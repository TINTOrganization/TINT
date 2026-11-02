#include "rtc/peer_factory.hpp"

#include <atomic>
#include <future>
#include <mutex>
#include <rtc/rtc.hpp>
#include <vector>

#include "rtp/packet.hpp"
#include "sdp/munge.hpp"
#include "sdp/offer_inspect.hpp"

namespace stream::rtc_adapter {
namespace {

using service::PeerRole;

std::string ufrag_of(const std::string& sdp) {
  constexpr std::string_view kKey = "a=ice-ufrag:";
  auto pos = sdp.find(kKey);
  if (pos == std::string::npos) return {};
  auto end = sdp.find_first_of("\r\n", pos);
  return sdp.substr(pos + kKey.size(), end - pos - kKey.size());
}

rtp::ByteView view_of(const rtc::binary& b) {
  return {reinterpret_cast<const std::uint8_t*>(b.data()), b.size()};
}

class DcPeer : public service::Peer {
 public:
  const std::string& answer_sdp() const override { return answer_; }
  const std::string& remote_ufrag() const override { return ufrag_; }

  void add_remote_candidates(const std::string& sdpfrag) override {
    // Trickle ICE (RFC 8840): líneas a=candidate bajo a=mid.
    std::string mid = "0";
    std::size_t start = 0;
    while (start < sdpfrag.size()) {
      auto end = sdpfrag.find('\n', start);
      if (end == std::string::npos) end = sdpfrag.size();
      std::string line = sdpfrag.substr(start, end - start);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      start = end + 1;
      if (line.starts_with("a=mid:")) mid = line.substr(6);
      if (line.starts_with("a=candidate:")) try {
          pc->addRemoteCandidate(rtc::Candidate(line.substr(2), mid));
        } catch (const std::exception&) {
          // candidato inválido: se ignora (el resto sigue)
        }
    }
  }

  void send_video(rtp::Bytes packet) override { send(video, packet); }
  void send_audio(rtp::Bytes packet) override { send(audio, packet); }
  void send_video_rtcp(rtp::Bytes packet) override { send(video, packet); }

  void send_event(std::string json) override {
    std::lock_guard lock(mu_);
    if (dc && dc->isOpen()) {
      try {
        dc->send(json);
      } catch (const std::exception&) {
      }
    } else if (pending_.size() < 32) {
      pending_.push_back(std::move(json));
    }
  }

  void flush_events() {
    std::lock_guard lock(mu_);
    for (auto& e : pending_) try {
        dc->send(e);
      } catch (const std::exception&) {
      }
    pending_.clear();
  }

  // Desconecta los callbacks antes de cerrar: una sesión cerrada no vuelve a llamar al servicio
  // (los hilos de libdatachannel pueden seguir entregando eventos durante el cierre).
  void close() override {
    for (auto* t : {&video, &audio})
      if (*t) (*t)->resetCallbacks();
    if (dc) dc->resetCallbacks();
    if (pc) {
      pc->resetCallbacks();
      pc->close();
    }
  }

  void notify_closed() {
    if (!closed_notified_.exchange(true) && on_closed) on_closed();
  }

  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> video;
  std::shared_ptr<rtc::Track> audio;
  std::shared_ptr<rtc::DataChannel> dc;
  std::function<void()> on_closed;
  std::string answer_;
  std::string ufrag_;

 private:
  static void send(const std::shared_ptr<rtc::Track>& track, const rtp::Bytes& packet) {
    if (!track || !track->isOpen()) return;
    try {
      track->send(reinterpret_cast<const std::byte*>(packet.data()), packet.size());
    } catch (const std::exception&) {
      // la pista se cerró entre la comprobación y el envío
    }
  }
  std::mutex mu_;
  std::vector<std::string> pending_;
  std::atomic<bool> closed_notified_{false};
};

std::string wait_local_description(rtc::PeerConnection& pc, std::chrono::milliseconds timeout) {
  auto done = std::make_shared<std::promise<void>>();
  auto future = done->get_future();
  auto once = std::make_shared<std::once_flag>();
  pc.onGatheringStateChange([done, once](rtc::PeerConnection::GatheringState s) {
    if (s == rtc::PeerConnection::GatheringState::Complete) std::call_once(*once, [&] { done->set_value(); });
  });
  if (pc.gatheringState() == rtc::PeerConnection::GatheringState::Complete)
    std::call_once(*once, [&] { done->set_value(); });
  future.wait_for(timeout);  // con mux y solo candidatos host termina casi enseguida
  auto local = pc.localDescription();
  return local ? std::string(*local) : std::string();
}

}  // namespace

LibDataChannelPeerFactory::LibDataChannelPeerFactory(PeerFactoryConfig config) : config_(std::move(config)) {}

std::expected<std::shared_ptr<service::Peer>, http::Problem> LibDataChannelPeerFactory::create(
    const service::PeerRequest& request, service::PeerCallbacks callbacks) {
  const std::string offer_sdp = sdp::sanitize_offer(request.offer_sdp);
  auto offer = sdp::parse_offer(offer_sdp);
  if (!offer) return std::unexpected(http::Problem{400, "INVALID_SDP", "La oferta SDP no se pudo leer."});

  rtc::Configuration cfg;
  cfg.disableAutoNegotiation = true;
  cfg.enableIceUdpMux = true;
  cfg.portRangeBegin = cfg.portRangeEnd = config_.udp_port;
  if (!config_.bind_address.empty()) cfg.bindAddress = config_.bind_address;

  auto peer = std::make_shared<DcPeer>();
  peer->ufrag_ = ufrag_of(offer_sdp);
  peer->on_closed = std::move(callbacks.on_closed);
  std::weak_ptr<DcPeer> weak = peer;

  try {
    peer->pc = std::make_shared<rtc::PeerConnection>(cfg);
    auto& pc = *peer->pc;
    pc.onStateChange([weak](rtc::PeerConnection::State s) {
      using S = rtc::PeerConnection::State;
      if (s == S::Disconnected || s == S::Failed || s == S::Closed)
        if (auto p = weak.lock()) p->notify_closed();
    });

    const bool host = request.role != PeerRole::Viewer;
    if (host) {
      // El host envía: su pista llega como remota.
      auto on_rtp = std::move(callbacks.on_rtp);
      pc.onTrack([weak, on_rtp, role = request.role](std::shared_ptr<rtc::Track> track) {
        auto p = weak.lock();
        if (!p) return;
        (role == PeerRole::HostVideo ? p->video : p->audio) = track;
        track->onMessage([on_rtp](rtc::message_variant m) {
          auto* b = std::get_if<rtc::binary>(&m);
          if (!b || !on_rtp) return;
          auto view = view_of(*b);
          if (!rtp::looks_like_rtcp(view)) on_rtp(view);
        });
      });
    }

    pc.setRemoteDescription(rtc::Description(offer_sdp, rtc::Description::Type::Offer));

    if (!host) {
      // Pistas sendonly en los mid de la oferta, con los SSRC que verá este viewer.
      auto on_rtcp = std::move(callbacks.on_rtcp);
      for (const auto& m : offer->media) {
        if (m.kind != "video" && m.kind != "audio") continue;
        const bool is_video = m.kind == "video";
        std::shared_ptr<rtc::Track> track;
        if (is_video) {
          rtc::Description::Video d(m.mid, rtc::Description::Direction::SendOnly);
          d.addVP8Codec(request.viewer.video_payload_type);
          if (auto abs = m.extmaps.find(std::string(sdp::kAbsSendTimeExtension)); abs != m.extmaps.end())
            d.addExtMap(rtc::Description::Entry::ExtMap(abs->second, abs->first));
          d.addSSRC(request.viewer.video_ssrc, "stream-core", "tint-live", "video");
          track = pc.addTrack(d);
          peer->video = track;
        } else {
          rtc::Description::Audio d(m.mid, rtc::Description::Direction::SendOnly);
          d.addOpusCodec(request.viewer.audio_payload_type);
          d.addSSRC(request.viewer.audio_ssrc, "stream-core", "tint-live", "audio");
          track = pc.addTrack(d);
          peer->audio = track;
        }
        track->onMessage([on_rtcp](rtc::message_variant msg) {
          auto* b = std::get_if<rtc::binary>(&msg);
          if (b && on_rtcp) on_rtcp(view_of(*b));
        });
      }
    }

    if (offer->count("application") > 0) {
      rtc::DataChannelInit init;
      init.negotiated = true;
      init.id = 0;
      peer->dc = pc.createDataChannel("stream-events", init);
      auto on_message = std::move(callbacks.on_message);
      auto on_open = std::move(callbacks.on_open);
      peer->dc->onOpen([weak, on_open] {
        if (auto p = weak.lock()) p->flush_events();
        if (on_open) on_open();
      });
      peer->dc->onMessage([on_message](rtc::message_variant m) {
        if (auto* s = std::get_if<std::string>(&m); s && on_message) on_message(*s);
      });
    }

    pc.setLocalDescription(rtc::Description::Type::Answer);
    std::string answer = wait_local_description(pc, config_.gathering_timeout);
    if (answer.empty()) throw std::runtime_error("sin descripción local");
    answer = sdp::rewrite_host_candidates(answer, config_.public_ip);
    if (request.role == PeerRole::HostVideo) {
      answer = sdp::fix_simulcast_answer(answer);
      answer = sdp::add_start_bitrate(answer, config_.start_bitrate_kbps);
    } else {
      answer = sdp::opus_stereo(answer);
    }
    peer->answer_ = std::move(answer);
  } catch (const std::exception& e) {
    if (peer->pc) peer->pc->close();
    return std::unexpected(
        http::Problem{400, "INVALID_SDP", std::string("No se pudo negociar la sesión: ") + e.what()});
  }
  return peer;
}

}  // namespace stream::rtc_adapter
