// Integración con libdatachannel real: clientes en el mismo proceso contra la PeerFactory del SFU.
// Valida el adaptador (pistas por mid, SSRC propios, DataChannel negociado id=0, RTCP del viewer).
#include "rtc/peer_factory.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <future>
#include <mutex>
#include <rtc/rtc.hpp>
#include <thread>

#include "rtp/packet.hpp"
#include "rtp/rtcp.hpp"
#include "support/rtp_builder.hpp"

using namespace stream;
using namespace std::chrono_literals;

namespace {

constexpr std::uint16_t kUdpPort = 47'654;

rtc::Configuration client_config() {
  rtc::Configuration c;
  c.disableAutoNegotiation = true;
  return c;
}

// Espera a que la recolección termine y devuelve la descripción local completa.
// El estado vive en el heap: libdatachannel puede llamar al callback después de que esta función retorne.
std::string local_sdp(rtc::PeerConnection& pc) {
  auto done = std::make_shared<std::promise<void>>();
  auto once = std::make_shared<std::once_flag>();
  auto f = done->get_future();
  pc.onGatheringStateChange([done, once](rtc::PeerConnection::GatheringState s) {
    if (s == rtc::PeerConnection::GatheringState::Complete) std::call_once(*once, [&] { done->set_value(); });
  });
  if (pc.gatheringState() == rtc::PeerConnection::GatheringState::Complete)
    std::call_once(*once, [&] { done->set_value(); });
  f.wait_for(3s);
  pc.onGatheringStateChange(nullptr);
  return std::string(*pc.localDescription());
}

// Estado que leen los callbacks de libdatachannel: compartido para que sobreviva al test.
struct Shared {
  std::mutex mu;
  std::vector<std::string> events;
  std::atomic<int> video_packets{0};
  std::atomic<std::uint32_t> video_ssrc{0};
  std::atomic<int> rtcp_from_viewer{0};
  std::atomic<int> received{0};
  std::atomic<int> scene_messages{0};
  std::atomic<int> closed{0};
  std::atomic<int> plis{0};
  std::atomic<std::uint64_t> remb_bps{0};
};

template <class Pred>
bool eventually(Pred pred, std::chrono::milliseconds timeout = 5s) {
  const auto end = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < end) {
    if (pred()) return true;
    std::this_thread::sleep_for(20ms);
  }
  return pred();
}

class RtcLoopback : public ::testing::Test {
 protected:
  static void SetUpTestSuite() { rtc::InitLogger(rtc::LogLevel::Warning); }
  stream::rtc_adapter::PeerFactoryConfig config{.udp_port = kUdpPort, .public_ip = "127.0.0.1"};
  stream::rtc_adapter::LibDataChannelPeerFactory factory{config};
};

}  // namespace

TEST_F(RtcLoopback, ViewerReceivesVideoAndDataChannelEvents) {
  // "Navegador" viewer: recvonly vídeo + audio + DataChannel negociado id=0.
  rtc::PeerConnection client(client_config());
  rtc::Description::Video video("0", rtc::Description::Direction::RecvOnly);
  video.addVP8Codec(100);
  auto vtrack = client.addTrack(video);
  rtc::Description::Audio audio("1", rtc::Description::Direction::RecvOnly);
  audio.addOpusCodec(109);
  auto atrack = client.addTrack(audio);
  rtc::DataChannelInit init;
  init.negotiated = true;
  init.id = 0;
  auto dc = client.createDataChannel("stream-events", init);
  auto st = std::make_shared<Shared>();
  auto& mu = st->mu;
  auto& events = st->events;
  auto& video_packets = st->video_packets;
  auto& video_ssrc = st->video_ssrc;
  auto& rtcp_from_viewer = st->rtcp_from_viewer;
  dc->onMessage([st](rtc::message_variant m) {
    if (auto* s = std::get_if<std::string>(&m)) {
      std::lock_guard l(st->mu);
      st->events.push_back(*s);
    }
  });
  vtrack->onMessage([st](rtc::message_variant m) {
    if (auto* b = std::get_if<rtc::binary>(&m)) {
      rtp::ByteView view(reinterpret_cast<const std::uint8_t*>(b->data()), b->size());
      if (rtp::looks_like_rtcp(view)) return;
      if (auto v = rtp::parse_rtp(view)) {
        st->video_ssrc = v->ssrc;
        ++st->video_packets;
      }
    }
  });
  client.setLocalDescription(rtc::Description::Type::Offer);
  const std::string offer = local_sdp(client);

  service::PeerRequest req{
      service::PeerRole::Viewer, "sess-v", offer,
      sfu::ViewerOptions{
          .video_ssrc = 0xABC0, .video_payload_type = 100, .audio_ssrc = 0xABC1, .audio_payload_type = 109}};
  auto peer = factory.create(req, {.on_rtp = {},
                                   .on_rtcp = [st](rtp::ByteView) { ++st->rtcp_from_viewer; },
                                   .on_message = {},
                                   .on_closed = {}});
  ASSERT_TRUE(peer) << peer.error().message;
  const auto& answer = (*peer)->answer_sdp();
  EXPECT_NE(answer.find("a=ssrc:" + std::to_string(0xABC0)), std::string::npos) << answer;
  EXPECT_NE(answer.find("127.0.0.1 " + std::to_string(kUdpPort) + " typ host"), std::string::npos) << answer;
  EXPECT_FALSE((*peer)->remote_ufrag().empty());

  client.setRemoteDescription(rtc::Description(answer, "answer"));
  ASSERT_TRUE(eventually([&] { return client.state() == rtc::PeerConnection::State::Connected; }));

  (*peer)->send_event(R"({"type":"stream_state","state":"live"})");
  ASSERT_TRUE(eventually([&] {
    std::lock_guard l(mu);
    return !events.empty();
  })) << "el DataChannel negociado id=0 se abre en ambos lados";
  {
    std::lock_guard l(mu);
    EXPECT_EQ(events.front(), R"({"type":"stream_state","state":"live"})");
  }

  ASSERT_TRUE(eventually([&] { return vtrack->isOpen(); }));
  for (std::uint16_t s = 1; s <= 20; ++s) {
    auto pkt =
        stream::testing::build_rtp({.pt = 100,
                                    .seq = s,
                                    .ts = s * 3000u,
                                    .ssrc = 0xABC0,
                                    .payload = stream::testing::build_vp8_payload({.keyframe = s == 1})});
    (*peer)->send_video(std::move(pkt));
    std::this_thread::sleep_for(5ms);
  }
  EXPECT_TRUE(eventually([&] { return video_packets.load() >= 15; })) << video_packets.load();
  EXPECT_EQ(video_ssrc.load(), 0xABC0u);

  // RTCP del viewer (PLI) llega al callback del SFU.
  vtrack->send(reinterpret_cast<const std::byte*>(rtp::build_pli(1, 0xABC0).data()), 12);
  EXPECT_TRUE(eventually([&] { return rtcp_from_viewer.load() > 0; }));

  (*peer)->close();
  EXPECT_TRUE(eventually([&] { return client.state() != rtc::PeerConnection::State::Connected; }, 10s));
  for (auto& t : {vtrack, atrack}) t->resetCallbacks();
  dc->resetCallbacks();
  client.resetCallbacks();
}

TEST_F(RtcLoopback, HostVideoReachesSfuCallback) {
  // "Navegador" host: sendonly VP8 + DataChannel. El SFU recibe el RTP crudo por su callback.
  rtc::PeerConnection client(client_config());
  rtc::Description::Video video("0", rtc::Description::Direction::SendOnly);
  video.addVP8Codec(96);
  video.addSSRC(0x10, "host", "stream", "video");
  auto track = client.addTrack(video);
  rtc::DataChannelInit init;
  init.negotiated = true;
  init.id = 0;
  auto dc = client.createDataChannel("stream-events", init);
  client.setLocalDescription(rtc::Description::Type::Offer);
  const std::string offer = local_sdp(client);

  auto st = std::make_shared<Shared>();
  auto& received = st->received;
  auto& scene_messages = st->scene_messages;
  auto& closed = st->closed;
  auto& plis = st->plis;
  auto peer = factory.create({service::PeerRole::HostVideo, "sess-h", offer, {}},
                             {.on_rtp =
                                  [st](rtp::ByteView p) {
                                    if (rtp::parse_rtp(p)) ++st->received;
                                  },
                              .on_rtcp = {},
                              .on_message =
                                  [st](const std::string& m) {
                                    if (m.find("scene") != std::string::npos) ++st->scene_messages;
                                  },
                              .on_closed = [st] { ++st->closed; }});
  ASSERT_TRUE(peer) << peer.error().message;
  client.setRemoteDescription(rtc::Description((*peer)->answer_sdp(), "answer"));
  ASSERT_TRUE(eventually([&] { return track->isOpen(); }));
  for (std::uint16_t s = 1; s <= 20; ++s) {
    auto pkt = stream::testing::build_rtp({.pt = 96, .seq = s, .ts = s * 3000u, .ssrc = 0x10});
    track->send(reinterpret_cast<const std::byte*>(pkt.data()), pkt.size());
    std::this_thread::sleep_for(5ms);
  }
  EXPECT_TRUE(eventually([&] { return received.load() >= 15; })) << received.load();

  ASSERT_TRUE(eventually([&] { return dc->isOpen(); }));
  dc->send(std::string(R"({"type":"scene","name":"brb"})"));
  EXPECT_TRUE(eventually([&] { return scene_messages.load() == 1; }));

  // PLI y REMB del SFU hacia el host (§7.1: el REMB va negociado con goog-remb en la respuesta).
  EXPECT_NE((*peer)->answer_sdp().find(" goog-remb"), std::string::npos);
  auto& remb_bps = st->remb_bps;
  track->onMessage([st](rtc::message_variant m) {
    if (auto* b = std::get_if<rtc::binary>(&m)) {
      auto info = rtp::parse_rtcp(rtp::ByteView(reinterpret_cast<const std::uint8_t*>(b->data()), b->size()));
      if (info && !info->keyframe_requests.empty()) ++st->plis;
      if (info && info->remb) st->remb_bps.store(info->remb->bitrate_bps);
    }
  });
  (*peer)->send_video_rtcp(rtp::build_pli(1, 0x10));
  EXPECT_TRUE(eventually([&] { return plis.load() > 0; }));
  const std::vector<std::uint32_t> host_ssrcs{0x10};
  (*peer)->send_video_rtcp(rtp::build_remb(1, 4'260'000, host_ssrcs));
  EXPECT_TRUE(eventually([&] { return remb_bps.load() == 4'260'000u; }));

  client.close();
  EXPECT_TRUE(eventually([&] { return closed.load() == 1; }, 15s))
      << "el SFU detecta la desconexión del host";
  track->resetCallbacks();
  dc->resetCallbacks();
  client.resetCallbacks();
  (*peer)->close();
}

TEST_F(RtcLoopback, GarbageOfferIsRejectedWith400) {
  auto peer = factory.create({service::PeerRole::Viewer, "x", "v=0\r\nbasura\r\n", {}}, {});
  ASSERT_FALSE(peer);
  EXPECT_EQ(peer.error().status, 400);
}
