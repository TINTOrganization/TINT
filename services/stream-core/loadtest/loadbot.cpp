// Spike S2 (dominio-transmision §9): 1 publicador sintético + N viewers WHEP con libdatachannel contra
// stream-core real (WHIP/WHEP por HTTP, ICE/DTLS/SRTP reales). Mide el tiempo al primer keyframe
// (TTFF) de cada viewer y comprueba que el viewer N+1 recibe 409 ROOM_FULL.
//
// Uso: stream_core_loadbot [--url http://127.0.0.1:8086] [--viewers 50] [--duration 30]
//                          [--secret …] [--room …] [--ttff-max-ms 2000] [--keyframe-interval-s 10]
//                          [--remb-bps 4000000] [--no-audio] [--no-full-check]
// Sale con 0 solo si TTFF p95 < umbral, no hubo fallos y el viewer N+1 recibió 409.
#include <algorithm>
#include <array>
#include <atomic>
#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <random>
#include <rtc/rtc.hpp>
#include <string>
#include <thread>
#include <vector>

#include "rtp/packet.hpp"
#include "rtp/rtcp.hpp"
#include "rtp/vp8.hpp"
#include "support/jwt.hpp"
#include "support/rtp_builder.hpp"

using namespace std::chrono_literals;
namespace beast = boost::beast;
namespace bhttp = boost::beast::http;
using tcp = boost::asio::ip::tcp;
using Clock = std::chrono::steady_clock;

namespace {

// --- Opciones ------------------------------------------------------------------------------

struct Options {
  std::string host = "127.0.0.1";
  std::string port = "8086";
  std::string secret = "dev-secret-change-in-prod";
  std::string issuer = "tint-identity";
  std::string audience = "tint:room";
  std::string room;
  int viewers = 50;
  int duration_s = 30;
  int ttff_max_ms = 2000;
  int keyframe_interval_s = 10;
  std::uint64_t remb_bps = 4'000'000;
  bool audio = true;
  bool full_check = true;
};

std::string env_or(const char* name, std::string fallback) {
  const char* v = std::getenv(name);
  return v && *v ? std::string(v) : fallback;
}

Options parse_options(int argc, char** argv) {
  Options o;
  o.secret = env_or("JWT_SECRET", o.secret);
  o.issuer = env_or("JWT_ISSUER", o.issuer);
  o.audience = env_or("JWT_AUDIENCE", o.audience);
  std::string url = "http://127.0.0.1:8086";
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "falta el valor de %s\n", a.c_str());
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--url")
      url = next();
    else if (a == "--viewers")
      o.viewers = std::stoi(next());
    else if (a == "--duration")
      o.duration_s = std::stoi(next());
    else if (a == "--secret")
      o.secret = next();
    else if (a == "--room")
      o.room = next();
    else if (a == "--ttff-max-ms")
      o.ttff_max_ms = std::stoi(next());
    else if (a == "--keyframe-interval-s")
      o.keyframe_interval_s = std::stoi(next());
    else if (a == "--remb-bps")
      o.remb_bps = std::stoull(next());
    else if (a == "--no-audio")
      o.audio = false;
    else if (a == "--no-full-check")
      o.full_check = false;
    else {
      std::fprintf(stderr, "opción desconocida: %s\n", a.c_str());
      std::exit(2);
    }
  }
  if (url.starts_with("http://")) url = url.substr(7);
  if (auto slash = url.find('/'); slash != std::string::npos) url = url.substr(0, slash);
  if (auto colon = url.rfind(':'); colon != std::string::npos) {
    o.host = url.substr(0, colon);
    o.port = url.substr(colon + 1);
  } else {
    o.host = url;
  }
  if (o.room.empty()) o.room = "load-" + std::to_string(std::random_device{}());
  return o;
}

// --- HTTP (WHIP/WHEP) ------------------------------------------------------------------------

struct HttpResult {
  int status = 0;
  std::string body;
  std::string location;
  std::string error;
};

HttpResult http_call(const Options& o, bhttp::verb verb, const std::string& target, const std::string& body,
                     const std::string& content_type, const std::string& bearer) {
  HttpResult out;
  try {
    boost::asio::io_context io;
    tcp::resolver resolver(io);
    beast::tcp_stream stream(io);
    stream.expires_after(15s);
    stream.connect(resolver.resolve(o.host, o.port));
    bhttp::request<bhttp::string_body> req{verb, target, 11};
    req.set(bhttp::field::host, o.host);
    if (!bearer.empty()) req.set(bhttp::field::authorization, "Bearer " + bearer);
    if (!content_type.empty()) req.set(bhttp::field::content_type, content_type);
    req.body() = body;
    req.prepare_payload();
    bhttp::write(stream, req);
    beast::flat_buffer buffer;
    bhttp::response<bhttp::string_body> res;
    bhttp::read(stream, buffer, res);
    out.status = static_cast<int>(res.result_int());
    out.body = res.body();
    out.location = std::string(res[bhttp::field::location]);
    beast::error_code ec;
    stream.socket().shutdown(tcp::socket::shutdown_both, ec);
  } catch (const std::exception& e) {
    out.error = e.what();
  }
  return out;
}

std::string token(const Options& o, const std::string& sub, const std::string& role, const std::string& jti) {
  const auto now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
          .count();
  nlohmann::json claims{{"sub", sub},        {"room_id", o.room}, {"role", role},
                        {"nick", sub},       {"jti", jti},        {"iss", o.issuer},
                        {"aud", o.audience}, {"iat", now - 5},    {"exp", now + 3600}};
  return stream::testing::sign_jwt(claims, o.secret);
}

// --- libdatachannel --------------------------------------------------------------------------

// Espera a que termine la recolección. El estado vive en el heap: libdatachannel puede llamar al
// callback después de que la función retorne (regla 5 de AGENTS.md).
std::string local_sdp(rtc::PeerConnection& pc) {
  auto done = std::make_shared<std::promise<void>>();
  auto once = std::make_shared<std::once_flag>();
  auto f = done->get_future();
  pc.onGatheringStateChange([done, once](rtc::PeerConnection::GatheringState s) {
    if (s == rtc::PeerConnection::GatheringState::Complete) std::call_once(*once, [&] { done->set_value(); });
  });
  if (pc.gatheringState() == rtc::PeerConnection::GatheringState::Complete)
    std::call_once(*once, [&] { done->set_value(); });
  f.wait_for(5s);
  pc.onGatheringStateChange(nullptr);
  auto d = pc.localDescription();
  return d ? std::string(*d) : std::string();
}

rtc::Configuration client_config() {
  rtc::Configuration c;
  c.disableAutoNegotiation = true;
  return c;
}

std::int64_t now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();
}

// --- Publicador sintético -------------------------------------------------------------------

constexpr int kRidExt = 4;
constexpr int kVideoPt = 96;
constexpr int kAudioPt = 111;
constexpr int kFps = 30;
constexpr std::size_t kMaxPayload = 1100;

struct Layer {
  const char* rid;
  std::uint32_t ssrc;
  std::uint64_t bitrate_bps;
};
constexpr std::array<Layer, 3> kLayers{
    {{"l", 0x1000'0001u, 250'000}, {"m", 0x1000'0002u, 800'000}, {"h", 0x1000'0003u, 2'500'000}}};
constexpr std::uint32_t kAudioSsrc = 0x2000'0001u;

struct PublisherShared {
  std::array<std::atomic<bool>, 3> pli{};  // PLI/FIR pendiente por capa
  std::atomic<std::uint64_t> plis{0};
  std::atomic<std::uint64_t> sent_packets{0};
  std::atomic<std::uint64_t> sent_bytes{0};
  std::atomic<bool> failed{false};
};

class Publisher {
 public:
  explicit Publisher(const Options& o) : o_(o), shared_(std::make_shared<PublisherShared>()) {}

  bool start() {
    const auto host_token = token(o_, "user-host", "host", "jti-host-" + o_.room);
    // Vídeo: VP8 con simulcast l/m/h por rid (como Chrome, sin a=ssrc) + DataChannel negociado id=0.
    video_pc_ = std::make_shared<rtc::PeerConnection>(client_config());
    rtc::Description::Video v("0", rtc::Description::Direction::SendOnly);
    v.addVP8Codec(kVideoPt);
    v.addExtMap(rtc::Description::Entry::ExtMap(kRidExt, "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"));
    for (const auto& l : kLayers) v.addRid(l.rid);
    video_track_ = video_pc_->addTrack(v);
    rtc::DataChannelInit init;
    init.negotiated = true;
    init.id = 0;
    dc_ = video_pc_->createDataChannel("stream-events", init);
    auto st = shared_;
    video_track_->onMessage([st](rtc::message_variant m) {
      auto* b = std::get_if<rtc::binary>(&m);
      if (!b) return;
      stream::rtp::ByteView view(reinterpret_cast<const std::uint8_t*>(b->data()), b->size());
      if (!stream::rtp::looks_like_rtcp(view)) return;
      auto info = stream::rtp::parse_rtcp(view);
      if (!info) return;
      for (auto ssrc : info->keyframe_requests)
        for (std::size_t l = 0; l < kLayers.size(); ++l)
          if (kLayers[l].ssrc == ssrc) {
            st->pli[l].store(true);
            ++st->plis;
          }
    });
    video_pc_->onStateChange([st](rtc::PeerConnection::State s) {
      if (s == rtc::PeerConnection::State::Failed) st->failed.store(true);
    });
    video_pc_->setLocalDescription(rtc::Description::Type::Offer);
    if (!negotiate(*video_pc_, "video", host_token)) return false;

    if (o_.audio) {
      audio_pc_ = std::make_shared<rtc::PeerConnection>(client_config());
      rtc::Description::Audio a("0", rtc::Description::Direction::SendOnly);
      a.addOpusCodec(kAudioPt);
      a.addSSRC(kAudioSsrc, "loadbot", "tint-live", "audio");
      audio_track_ = audio_pc_->addTrack(a);
      audio_pc_->setLocalDescription(rtc::Description::Type::Offer);
      if (!negotiate(*audio_pc_, "audio", host_token)) return false;
    }

    const auto deadline = Clock::now() + 10s;
    while (Clock::now() < deadline && !(video_track_->isOpen() && (!audio_track_ || audio_track_->isOpen())))
      std::this_thread::sleep_for(20ms);
    if (!video_track_->isOpen()) {
      std::fprintf(stderr, "publicador: la pista de vídeo no se abrió (ICE/DTLS)\n");
      return false;
    }
    running_ = true;
    video_thread_ = std::thread([this] { video_loop(); });
    if (audio_track_) audio_thread_ = std::thread([this] { audio_loop(); });
    return true;
  }

  void stop() {
    running_ = false;
    if (video_thread_.joinable()) video_thread_.join();
    if (audio_thread_.joinable()) audio_thread_.join();
    for (auto& t : {video_track_, audio_track_})
      if (t) t->resetCallbacks();
    if (dc_) dc_->resetCallbacks();
    for (auto& pc : {video_pc_, audio_pc_})
      if (pc) {
        pc->resetCallbacks();
        pc->close();
      }
  }

  const PublisherShared& stats() const { return *shared_; }

 private:
  bool negotiate(rtc::PeerConnection& pc, const char* kind, const std::string& bearer) {
    const auto offer = local_sdp(pc);
    auto r = http_call(o_, bhttp::verb::post, "/api/v1/stream/rooms/" + o_.room + "/whip?kind=" + kind, offer,
                       "application/sdp", bearer);
    if (r.status != 201) {
      std::fprintf(stderr, "WHIP %s: %d %s %s\n", kind, r.status, r.body.c_str(), r.error.c_str());
      return false;
    }
    pc.setRemoteDescription(rtc::Description(r.body, "answer"));
    return true;
  }

  void send(const std::shared_ptr<rtc::Track>& t, const std::vector<std::uint8_t>& p) {
    if (!t || !t->isOpen()) return;
    try {
      t->send(reinterpret_cast<const std::byte*>(p.data()), p.size());
      ++shared_->sent_packets;
      shared_->sent_bytes += p.size();
    } catch (const std::exception&) {
    }
  }

  // 30 fps por capa. Keyframe al empezar, cada keyframe_interval_s y cuando el SFU manda PLI.
  void video_loop() {
    std::array<std::uint16_t, 3> seq{1, 1, 1};
    std::uint32_t ts = 90'000;
    std::uint16_t picture_id = 0;
    std::uint8_t tl0 = 0;
    const int periodic = std::max(1, o_.keyframe_interval_s) * kFps;
    auto next = Clock::now();
    for (int frame = 0; running_; ++frame) {
      for (std::size_t l = 0; l < kLayers.size(); ++l) {
        const bool keyframe = frame == 0 || frame % periodic == 0 || shared_->pli[l].exchange(false);
        std::size_t frame_bytes = kLayers[l].bitrate_bps / 8 / kFps;
        if (keyframe) frame_bytes *= 3;
        const std::size_t packets = std::max<std::size_t>(1, (frame_bytes + kMaxPayload - 1) / kMaxPayload);
        for (std::size_t p = 0; p < packets; ++p) {
          auto payload = stream::testing::build_vp8_payload(
              {.start = p == 0, .keyframe = keyframe && p == 0, .picture_id = picture_id, .tl0picidx = tl0});
          payload.resize(std::min(kMaxPayload, std::max<std::size_t>(payload.size(), frame_bytes / packets)),
                         0x5A);
          send(video_track_, stream::testing::build_rtp({.pt = kVideoPt,
                                                         .marker = p + 1 == packets,
                                                         .seq = seq[l]++,
                                                         .ts = ts,
                                                         .ssrc = kLayers[l].ssrc,
                                                         .extensions = {{kRidExt, kLayers[l].rid}},
                                                         .payload = std::move(payload)}));
        }
      }
      picture_id = (picture_id + 1) & 0x7FFF;
      ++tl0;
      ts += 90'000 / kFps;
      next += std::chrono::microseconds(1'000'000 / kFps);
      std::this_thread::sleep_until(next);
    }
  }

  // Opus 20 ms (~128 kbps estéreo).
  void audio_loop() {
    std::uint16_t seq = 1;
    std::uint32_t ts = 0;
    auto next = Clock::now();
    while (running_) {
      send(audio_track_, stream::testing::build_rtp({.pt = kAudioPt,
                                                     .seq = seq++,
                                                     .ts = ts,
                                                     .ssrc = kAudioSsrc,
                                                     .payload = std::vector<std::uint8_t>(320, 0x11)}));
      ts += 960;
      next += 20ms;
      std::this_thread::sleep_until(next);
    }
  }

  const Options& o_;
  std::shared_ptr<PublisherShared> shared_;
  std::shared_ptr<rtc::PeerConnection> video_pc_, audio_pc_;
  std::shared_ptr<rtc::Track> video_track_, audio_track_;
  std::shared_ptr<rtc::DataChannel> dc_;
  std::atomic<bool> running_{false};
  std::thread video_thread_, audio_thread_;
};

// --- Viewer ----------------------------------------------------------------------------------

struct ViewerShared {
  std::atomic<std::int64_t> first_keyframe_us{-1};
  std::atomic<std::uint32_t> video_ssrc{0};
  std::atomic<std::uint64_t> video_packets{0};
  std::atomic<std::uint64_t> video_bytes{0};
  std::atomic<std::uint64_t> audio_packets{0};
  std::atomic<std::uint64_t> events{0};
  std::atomic<bool> failed{false};
  std::atomic<bool> connected{false};
};

struct ViewerResult {
  int status = 0;
  std::string error;
  std::int64_t signaling_ms = -1;
  std::int64_t ttff_ms = -1;
  std::uint64_t video_packets = 0, video_bytes = 0, audio_packets = 0, events = 0;
};

class Viewer {
 public:
  Viewer(const Options& o, int index) : o_(o), index_(index), shared_(std::make_shared<ViewerShared>()) {}

  // Devuelve el estado HTTP del WHEP (201 si entró).
  int join() {
    pc_ = std::make_shared<rtc::PeerConnection>(client_config());
    rtc::Description::Video v("0", rtc::Description::Direction::RecvOnly);
    v.addVP8Codec(kVideoPt);
    video_ = pc_->addTrack(v);
    rtc::Description::Audio a("1", rtc::Description::Direction::RecvOnly);
    a.addOpusCodec(kAudioPt);
    audio_ = pc_->addTrack(a);
    rtc::DataChannelInit init;
    init.negotiated = true;
    init.id = 0;
    dc_ = pc_->createDataChannel("stream-events", init);
    auto st = shared_;
    video_->onMessage([st](rtc::message_variant m) {
      auto* b = std::get_if<rtc::binary>(&m);
      if (!b) return;
      stream::rtp::ByteView view(reinterpret_cast<const std::uint8_t*>(b->data()), b->size());
      if (stream::rtp::looks_like_rtcp(view)) return;
      auto rtp = stream::rtp::parse_rtp(view);
      if (!rtp) return;
      ++st->video_packets;
      st->video_bytes += b->size();
      st->video_ssrc.store(rtp->ssrc);
      if (st->first_keyframe_us.load() >= 0) return;
      auto vp8 = stream::rtp::parse_vp8(view.subspan(rtp->payload_offset, rtp->payload_size));
      if (vp8 && vp8->keyframe) {
        std::int64_t expected = -1;
        st->first_keyframe_us.compare_exchange_strong(expected, now_us());
      }
    });
    audio_->onMessage([st](rtc::message_variant m) {
      if (std::holds_alternative<rtc::binary>(m)) ++st->audio_packets;
    });
    dc_->onMessage([st](rtc::message_variant m) {
      if (std::holds_alternative<std::string>(m)) ++st->events;
    });
    pc_->onStateChange([st](rtc::PeerConnection::State s) {
      using S = rtc::PeerConnection::State;
      if (s == S::Connected) st->connected.store(true);
      if (s == S::Failed || (s == S::Disconnected && st->connected.load())) st->failed.store(true);
    });

    start_us_ = now_us();  // TTFF: desde que el "navegador" empieza a negociar
    pc_->setLocalDescription(rtc::Description::Type::Offer);
    const auto offer = local_sdp(*pc_);
    const auto bearer = token(o_, "guest:bot-" + std::to_string(index_), "participant",
                              "jti-bot-" + std::to_string(index_) + "-" + o_.room);
    auto r = http_call(o_, bhttp::verb::post, "/api/v1/stream/rooms/" + o_.room + "/whep", offer,
                       "application/sdp", bearer);
    result_.status = r.status;
    result_.signaling_ms = (now_us() - start_us_) / 1000;
    if (r.status != 201) {
      result_.error = r.error.empty() ? r.body : r.error;
      return r.status;
    }
    answer_ssrc_ = ssrc_in(r.body);
    pc_->setRemoteDescription(rtc::Description(r.body, "answer"));
    joined_.store(true, std::memory_order_release);  // a partir de aquí el poller usa la pista
    return 201;
  }

  // Como un navegador: mientras no decodifica, pide keyframe (PLI) cada 500 ms; luego informa REMB.
  void poll(std::int64_t now) {
    if (!joined_.load(std::memory_order_acquire) || !video_->isOpen()) return;
    const std::uint32_t media = shared_->video_ssrc.load() ? shared_->video_ssrc.load() : answer_ssrc_;
    if (shared_->first_keyframe_us.load() < 0) {
      if (now - last_pli_us_ >= 500'000) {
        last_pli_us_ = now;
        rtcp(stream::rtp::build_pli(kSenderSsrc + index_, media));
      }
    } else if (o_.remb_bps && now - last_remb_us_ >= 1'000'000) {
      last_remb_us_ = now;
      const std::uint32_t ssrcs[] = {media};
      rtcp(stream::rtp::build_remb(kSenderSsrc + index_, o_.remb_bps, ssrcs));
    }
  }

  ViewerResult result() const {
    ViewerResult r = result_;
    const auto kf = shared_->first_keyframe_us.load();
    if (kf >= 0) r.ttff_ms = (kf - start_us_) / 1000;
    r.video_packets = shared_->video_packets.load();
    r.video_bytes = shared_->video_bytes.load();
    r.audio_packets = shared_->audio_packets.load();
    r.events = shared_->events.load();
    if (r.status == 201 && shared_->failed.load() && r.error.empty()) r.error = "PeerConnection Failed";
    return r;
  }

  bool failed() const { return shared_->failed.load(); }

  void close() {
    for (auto& t : {video_, audio_})
      if (t) t->resetCallbacks();
    if (dc_) dc_->resetCallbacks();
    if (pc_) {
      pc_->resetCallbacks();
      pc_->close();
    }
  }

 private:
  static constexpr std::uint32_t kSenderSsrc = 0x3000'0000u;

  static std::uint32_t ssrc_in(const std::string& sdp) {
    auto pos = sdp.find("a=ssrc:");
    if (pos == std::string::npos) return 0;
    return static_cast<std::uint32_t>(std::strtoul(sdp.c_str() + pos + 7, nullptr, 10));
  }

  void rtcp(const std::vector<std::uint8_t>& packet) {
    try {
      video_->send(reinterpret_cast<const std::byte*>(packet.data()), packet.size());
    } catch (const std::exception&) {
    }
  }

  const Options& o_;
  int index_;
  std::shared_ptr<ViewerShared> shared_;
  std::shared_ptr<rtc::PeerConnection> pc_;
  std::shared_ptr<rtc::Track> video_, audio_;
  std::shared_ptr<rtc::DataChannel> dc_;
  std::int64_t start_us_ = 0;
  std::int64_t last_pli_us_ = 0;
  std::int64_t last_remb_us_ = 0;
  std::uint32_t answer_ssrc_ = 0;
  std::atomic<bool> joined_{false};
  ViewerResult result_;
};

std::int64_t percentile(std::vector<std::int64_t> v, double p) {
  if (v.empty()) return -1;
  std::sort(v.begin(), v.end());
  const auto idx = static_cast<std::size_t>(std::max(0.0, std::ceil(p * v.size()) - 1));
  return v[std::min(idx, v.size() - 1)];
}

}  // namespace

int main(int argc, char** argv) {
  const Options o = parse_options(argc, argv);
  rtc::InitLogger(rtc::LogLevel::Error);
  std::printf("stream-core loadbot: %s:%s sala=%s viewers=%d duración=%ds\n", o.host.c_str(), o.port.c_str(),
              o.room.c_str(), o.viewers, o.duration_s);

  auto enable = http_call(o, bhttp::verb::post, "/internal/events/start/" + o.room, "", "", "");
  if (enable.status != 200) {
    std::fprintf(stderr, "POST /internal/events/start: %d %s %s\n", enable.status, enable.body.c_str(),
                 enable.error.c_str());
    return 1;
  }

  Publisher publisher(o);
  if (!publisher.start()) {
    publisher.stop();
    return 1;
  }
  std::this_thread::sleep_for(1500ms);  // el primer keyframe pone la sala en live

  // Los N viewers entran a la vez (peor caso de señalización y de PLI).
  std::vector<std::unique_ptr<Viewer>> viewers;
  for (int i = 0; i < o.viewers; ++i) viewers.push_back(std::make_unique<Viewer>(o, i));
  std::atomic<bool> polling{true};
  std::thread poller([&] {
    while (polling.load()) {
      const auto now = now_us();
      for (auto& v : viewers) v->poll(now);
      std::this_thread::sleep_for(50ms);
    }
  });
  {
    std::vector<std::thread> joins;
    for (auto& v : viewers) joins.emplace_back([&v] { v->join(); });
    for (auto& t : joins) t.join();
  }

  // Cupo: el viewer N+1 recibe 409 ROOM_FULL.
  int full_status = 0;
  std::string full_body;
  if (o.full_check) {
    Viewer extra(o, o.viewers);
    full_status = extra.join();
    full_body = extra.result().error;
    extra.close();
  }

  // Régimen estable: los viewers suben de capa con REMB; se mide el reenvío sostenido.
  const auto deadline = Clock::now() + std::chrono::seconds(o.duration_s);
  while (Clock::now() < deadline) std::this_thread::sleep_for(200ms);
  polling.store(false);
  poller.join();

  std::vector<ViewerResult> results;
  for (auto& v : viewers) results.push_back(v->result());
  const auto& ps = publisher.stats();
  const bool publisher_failed = ps.failed.load();
  const auto sent_packets = ps.sent_packets.load();
  const auto sent_bytes = ps.sent_bytes.load();
  const auto plis = ps.plis.load();
  for (auto& v : viewers) v->close();
  publisher.stop();
  http_call(o, bhttp::verb::delete_, "/internal/events/start/" + o.room, "", "", "");

  std::vector<std::int64_t> ttff, signaling;
  int failures = 0;
  std::uint64_t packets = 0, bytes = 0, audio = 0;
  for (std::size_t i = 0; i < results.size(); ++i) {
    const auto& r = results[i];
    packets += r.video_packets;
    bytes += r.video_bytes;
    audio += r.audio_packets;
    if (r.signaling_ms >= 0) signaling.push_back(r.signaling_ms);
    std::string why;
    if (r.status != 201)
      why = "WHEP " + std::to_string(r.status) + " " + r.error;
    else if (!r.error.empty())
      why = r.error;
    else if (r.ttff_ms < 0)
      why = "sin keyframe";
    else if (r.video_packets == 0)
      why = "sin paquetes";
    if (!why.empty()) {
      ++failures;
      std::fprintf(stderr, "  viewer %zu: %s\n", i, why.c_str());
    }
    if (r.ttff_ms >= 0) ttff.push_back(r.ttff_ms);
  }

  const double secs = std::max(1, o.duration_s);
  const auto p50 = percentile(ttff, 0.50), p95 = percentile(ttff, 0.95),
             max = ttff.empty() ? -1 : *std::max_element(ttff.begin(), ttff.end());
  std::printf("\n== Resumen S2 ==\n");
  std::printf("viewers conectados: %zu/%d  fallos: %d  publicador: %s (PLI recibidos: %llu)\n", ttff.size(),
              o.viewers, failures, publisher_failed ? "FALLÓ" : "ok", static_cast<unsigned long long>(plis));
  std::printf("TTFF ms: p50=%lld p95=%lld max=%lld (umbral p95 < %d)\n", static_cast<long long>(p50),
              static_cast<long long>(p95), static_cast<long long>(max), o.ttff_max_ms);
  std::printf("señalización WHEP ms: p50=%lld p95=%lld\n", static_cast<long long>(percentile(signaling, 0.5)),
              static_cast<long long>(percentile(signaling, 0.95)));
  std::printf("recibido por los viewers: %llu paquetes de vídeo (%.1f MB), %llu de audio\n",
              static_cast<unsigned long long>(packets), bytes / 1e6, static_cast<unsigned long long>(audio));
  std::printf("egreso medio del SFU (vídeo) ≈ %.1f Mbps; subida del host ≈ %.2f Mbps (%llu paquetes)\n",
              bytes * 8 / secs / 1e6, sent_bytes * 8 / (secs + 1.5) / 1e6,
              static_cast<unsigned long long>(sent_packets));
  if (o.full_check)
    std::printf("viewer %d: %d %s\n", o.viewers + 1, full_status,
                full_body.find("ROOM_FULL") != std::string::npos ? "ROOM_FULL" : full_body.c_str());

  bool ok = true;
  if (failures > 0 || publisher_failed) ok = false;
  if (p95 < 0 || p95 >= o.ttff_max_ms) ok = false;
  if (o.full_check && (full_status != 409 || full_body.find("ROOM_FULL") == std::string::npos)) ok = false;
  std::printf("resultado: %s\n", ok ? "OK" : "FALLA");
  return ok ? 0 : 1;
}
