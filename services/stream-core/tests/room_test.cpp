// Reenvío de una sala (HU-LIVE-02, 04, 05) con sinks falsos: sin red.
#include "sfu/room.hpp"

#include <gtest/gtest.h>

#include <thread>

#include "rtp/rtcp.hpp"
#include "support/fake_sinks.hpp"
#include "support/rtp_builder.hpp"

using namespace stream;
using namespace stream::sfu;
using namespace stream::rtp;
using namespace stream::testing;

namespace {

constexpr int kRidExt = 4;
const std::vector<std::string> kRids{"h", "m", "l"};
constexpr std::uint32_t kSsrcL = 0x10, kSsrcM = 0x20, kSsrcH = 0x30;
constexpr std::uint32_t ssrc_for(int layer) { return layer == 0 ? kSsrcL : layer == 1 ? kSsrcM : kSsrcH; }
const char* rid_for(int layer) { return layer == 0 ? "l" : layer == 1 ? "m" : "h"; }

Bytes host_video(int layer, std::uint16_t seq, bool keyframe, bool with_rid = true) {
  RtpSpec s{.pt = 96,
            .seq = seq,
            .ts = seq * 3000u,
            .ssrc = ssrc_for(layer),
            .payload = build_vp8_payload({.keyframe = keyframe, .picture_id = seq})};
  if (with_rid) s.extensions = {{kRidExt, rid_for(layer)}};
  return build_rtp(s);
}

struct ViewerHandle {
  std::shared_ptr<FakeViewerSink> sink = std::make_shared<FakeViewerSink>();
  std::shared_ptr<Viewer> viewer;
};

ViewerHandle make_viewer(const std::string& id, std::uint32_t ssrc = 0x9000) {
  ViewerHandle h;
  h.viewer = std::make_shared<Viewer>(
      id, "guest:" + id,
      ViewerOptions{
          .video_ssrc = ssrc, .video_payload_type = 100, .audio_ssrc = ssrc + 1, .audio_payload_type = 109},
      h.sink);
  return h;
}

class RoomTest : public ::testing::Test {
 protected:
  RoomTest() { room.set_host_video(host, kRidExt, kRids); }
  // Un keyframe por capa para que las tres estén activas.
  void prime(std::int64_t now = 0) {
    for (int l = 0; l < kLayers; ++l) room.on_host_video(host_video(l, 1, true), now);
  }
  Room room{"room-1"};
  std::shared_ptr<FakeHostSink> host = std::make_shared<FakeHostSink>();
};

}  // namespace

TEST_F(RoomTest, IngestReportsLayerAndKeyframe) {
  auto r = room.on_host_video(host_video(2, 1, true), 0);
  EXPECT_EQ(r.layer, 2);
  EXPECT_TRUE(r.keyframe);
  EXPECT_FALSE(room.on_host_video(host_video(1, 2, false), 0).keyframe);
  auto unknown = room.on_host_video(build_rtp({.ssrc = 0x777}), 0);
  EXPECT_FALSE(unknown.layer);
}

TEST_F(RoomTest, ForwardsOnlySelectedLayerToEachViewer) {
  auto a = make_viewer("a", 0xA000);
  auto b = make_viewer("b", 0xB000);
  ASSERT_TRUE(room.add_viewer(a.viewer, 0));
  ASSERT_TRUE(room.add_viewer(b.viewer, 0));
  b.viewer->set_desired_layer(2);
  for (std::uint16_t seq = 1; seq <= 5; ++seq)
    for (int l = 0; l < kLayers; ++l) room.on_host_video(host_video(l, seq, seq == 1), seq);
  EXPECT_EQ(a.sink->video_count(), 5u);
  EXPECT_EQ(b.sink->video_count(), 5u);
  for (auto& p : a.sink->video_snapshot()) EXPECT_EQ(parse_rtp(p)->ssrc, 0xA000u);
  for (auto& p : b.sink->video_snapshot()) EXPECT_EQ(parse_rtp(p)->ssrc, 0xB000u);
}

// RTCP Receiver Report vacío (sin bloques), como el primero que manda un navegador.
rtp::Bytes empty_rr(std::uint32_t sender) {
  return {0x80,
          201,
          0x00,
          0x01,
          static_cast<std::uint8_t>(sender >> 24),
          static_cast<std::uint8_t>(sender >> 16),
          static_cast<std::uint8_t>(sender >> 8),
          static_cast<std::uint8_t>(sender)};
}

TEST_F(RoomTest, KeyframeRequestedOnFirstViewerRtcpNotOnJoin) {
  // S2: un keyframe pedido al entrar (o al abrir la pista del lado del SFU) llega antes de que el
  // viewer tenga las claves SRTP y se pierde; el siguiente cae en la ventana de PliThrottle (~1.2 s
  // de TTFF). El primer RTCP del viewer prueba que ya descifra.
  prime();
  host->rtcp.clear();
  auto v = make_viewer("v");
  room.add_viewer(v.viewer, 5'000);
  EXPECT_TRUE(host->plis().empty()) << "todavía no puede recibirlo";
  room.on_viewer_rtcp("v", empty_rr(0xC000), 5'100);
  EXPECT_EQ(host->plis(), (std::vector<std::uint32_t>{kSsrcL})) << "entra en la capa baja: TTFF rápido";
  room.on_viewer_rtcp("v", empty_rr(0xC000), 7'000);
  EXPECT_EQ(host->plis().size(), 1u) << "solo el primer RTCP sin PLI pide keyframe";
}

TEST_F(RoomTest, HostUploadIndependentOfViewerCount) {
  // HU-LIVE-02 AC2 / HU-LIVE-04 AC1: 50 entradas no multiplican lo que se pide al host.
  prime();
  host->rtcp.clear();
  for (int i = 0; i < 50; ++i)
    ASSERT_TRUE(room.add_viewer(make_viewer("v" + std::to_string(i)).viewer, 10'000));
  for (int i = 0; i < 50; ++i) room.on_viewer_rtcp("v" + std::to_string(i), empty_rr(0xC000), 10'000 + i);
  EXPECT_EQ(host->plis().size(), 1u) << "un PLI compartido por capa y por segundo";
  EXPECT_EQ(room.viewer_count(), 50);
}

TEST_F(RoomTest, Capacity50Then51Rejected) {
  for (int i = 0; i < 50; ++i) ASSERT_TRUE(room.add_viewer(make_viewer("v" + std::to_string(i)).viewer, 0));
  EXPECT_FALSE(room.add_viewer(make_viewer("extra").viewer, 0));
  EXPECT_EQ(room.viewer_count(), 50);
}

TEST_F(RoomTest, LeaveStopsDeliveryAndReleases) {
  auto v = make_viewer("v");
  room.add_viewer(v.viewer, 0);
  room.on_host_video(host_video(0, 1, true), 0);
  ASSERT_EQ(v.sink->video_count(), 1u);
  auto removed = room.remove_viewer("v");
  ASSERT_TRUE(removed);
  EXPECT_EQ(room.viewer_count(), 0);
  room.on_host_video(host_video(0, 2, false), 1);
  EXPECT_EQ(v.sink->video_count(), 1u);
  removed.reset();
  EXPECT_EQ(v.viewer.use_count(), 1) << "la sala no conserva referencias (HU-LIVE-04 AC2)";
  EXPECT_FALSE(room.remove_viewer("v"));
}

TEST_F(RoomTest, NackRetransmitsRewrittenPacket) {
  auto v = make_viewer("v", 0xC000);
  room.add_viewer(v.viewer, 0);
  for (std::uint16_t s = 1; s <= 3; ++s) room.on_host_video(host_video(0, s, s == 1), s);
  auto sent = v.sink->video_snapshot();
  const auto lost_out_seq = parse_rtp(sent[1])->seq;
  std::vector<std::uint16_t> seqs{lost_out_seq};
  room.on_viewer_rtcp("v", build_nack(0xC000, 0xC000, seqs), 10);
  auto after = v.sink->video_snapshot();
  ASSERT_EQ(after.size(), 4u);
  EXPECT_EQ(after.back(), sent[1]) << "el reenvío es idéntico al paquete original del viewer";
}

TEST_F(RoomTest, PliFromViewerForwardedThrottled) {
  prime();
  auto v = make_viewer("v");
  room.add_viewer(v.viewer, 0);
  host->rtcp.clear();
  room.on_viewer_rtcp("v", build_pli(1, v.viewer->video_ssrc()), 2'000);
  room.on_viewer_rtcp("v", build_pli(1, v.viewer->video_ssrc()), 2'100);
  EXPECT_EQ(host->plis(), (std::vector<std::uint32_t>{kSsrcL}));
}

TEST_F(RoomTest, RembFromViewerChangesItsLayerOnly) {
  prime();
  auto a = make_viewer("a", 0xA000);
  auto b = make_viewer("b", 0xB000);
  room.add_viewer(a.viewer, 0);
  room.add_viewer(b.viewer, 0);
  std::vector<std::uint32_t> ssrc{0xA000};
  for (std::int64_t t = 0; t <= 12'000; t += 500) {
    for (int l = 0; l < kLayers; ++l)
      room.on_host_video(host_video(l, static_cast<std::uint16_t>(t / 500 + 2), false), t);
    room.on_viewer_rtcp("a", build_remb(0xA000, 10'000'000, ssrc), t);
    room.tick(t);
  }
  EXPECT_EQ(a.viewer->desired_layer(), 2) << "con ancho de banda sube hasta h";
  EXPECT_EQ(b.viewer->desired_layer(), 0) << "sin REMB ni informes no sube";
  room.on_viewer_rtcp("a", build_remb(0xA000, 300'000, ssrc), 12'100);
  EXPECT_EQ(a.viewer->desired_layer(), 0) << "HU-LIVE-02 AC3: baja la calidad en lugar de congelar";
}

TEST_F(RoomTest, HostReplaceKeepsViewersAndContinuity) {
  auto v = make_viewer("v");
  room.add_viewer(v.viewer, 0);
  room.on_host_video(host_video(0, 10, true), 0);
  room.on_host_video(host_video(0, 11, false), 33);
  auto new_host = std::make_shared<FakeHostSink>();
  room.set_host_video(new_host, kRidExt, kRids);  // el host recargó la pestaña
  RtpSpec s{.pt = 96,
            .seq = 500,
            .ts = 1,
            .ssrc = 0x99,
            .extensions = {{kRidExt, "l"}},
            .payload = build_vp8_payload({.keyframe = true})};
  room.on_host_video(build_rtp(s), 1'000);
  auto sent = v.sink->video_snapshot();
  ASSERT_EQ(sent.size(), 3u);
  EXPECT_EQ(static_cast<std::uint16_t>(parse_rtp(sent[2])->seq - parse_rtp(sent[1])->seq), 1);
  EXPECT_EQ(room.viewer_count(), 1);
}

TEST_F(RoomTest, AudioForwardedToAllViewersWithOwnSsrc) {
  room.set_host_audio();
  auto a = make_viewer("a", 0xA000);
  auto b = make_viewer("b", 0xB000);
  room.add_viewer(a.viewer, 0);
  room.add_viewer(b.viewer, 0);
  room.on_host_audio(build_rtp({.pt = 111, .seq = 7, .ts = 960, .ssrc = 0xAD}), 0);
  ASSERT_EQ(a.sink->audio.size(), 1u);
  ASSERT_EQ(b.sink->audio.size(), 1u);
  EXPECT_EQ(parse_rtp(a.sink->audio[0])->ssrc, 0xA001u);
  EXPECT_EQ(parse_rtp(b.sink->audio[0])->payload_type, 109);
}

TEST_F(RoomTest, TeardownClosesAllSinksWithEnded) {
  auto a = make_viewer("a");
  auto b = make_viewer("b");
  room.add_viewer(a.viewer, 0);
  room.add_viewer(b.viewer, 0);
  room.teardown(R"({"type":"stream_state","state":"ended"})");
  EXPECT_TRUE(room.ended());
  EXPECT_TRUE(a.sink->closed);
  EXPECT_TRUE(b.sink->closed);
  EXPECT_EQ(a.sink->events.back(), R"({"type":"stream_state","state":"ended"})");
  EXPECT_EQ(room.viewer_count(), 0);
  EXPECT_FALSE(room.add_viewer(make_viewer("tarde").viewer, 0));
}

TEST_F(RoomTest, BroadcastEventReachesEveryone) {
  auto a = make_viewer("a");
  room.add_viewer(a.viewer, 0);
  room.broadcast_event(R"({"type":"viewer_count","count":1})");
  EXPECT_EQ(a.sink->events.size(), 1u);
}

TEST_F(RoomTest, ConcurrentJoinLeaveWhileForwarding) {
  // Para TSan: ingesta, RTCP y altas/bajas en hilos distintos.
  std::atomic<bool> stop{false};
  std::thread ingest([&] {
    std::uint16_t seq = 1;
    while (!stop) {
      for (int l = 0; l < kLayers; ++l) room.on_host_video(host_video(l, seq, seq % 30 == 1), seq);
      ++seq;
    }
  });
  std::thread rtcp([&] {
    while (!stop) {
      room.on_viewer_rtcp("v0", build_pli(1, 0x9000), 0);
      room.tick(0);
    }
  });
  for (int round = 0; round < 200; ++round) {
    auto v = make_viewer("v" + std::to_string(round % 5));
    room.add_viewer(v.viewer, round);
    room.remove_viewer("v" + std::to_string((round + 2) % 5));
  }
  stop = true;
  ingest.join();
  rtcp.join();
  SUCCEED();
}
