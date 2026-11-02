#pragma once

#include <chrono>
#include <cstdint>
#include <expected>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "http/request_decision.hpp"
#include "sfu/room.hpp"
#include "sfu/stream_state.hpp"

namespace stream::service {

// --- Puertos hacia afuera (los implementan rtc/, redis/ e identity/) ------------------------

// Una PeerConnection ya negociada. Es a la vez la salida hacia un viewer y el RTCP hacia el host.
class Peer : public sfu::ViewerSink, public sfu::HostSink {
 public:
  virtual const std::string& answer_sdp() const = 0;
  virtual const std::string& remote_ufrag() const = 0;
  virtual void add_remote_candidates(const std::string& sdpfrag) = 0;
};

enum class PeerRole { HostVideo, HostAudio, Viewer };

struct PeerRequest {
  PeerRole role = PeerRole::Viewer;
  std::string session_id;
  std::string offer_sdp;
  sfu::ViewerOptions viewer;  // SSRC y PT que el viewer verá (solo Viewer)
};

struct PeerCallbacks {
  std::function<void(rtp::ByteView)> on_rtp;           // medios del host
  std::function<void(rtp::ByteView)> on_rtcp;          // RTCP del viewer
  std::function<void(const std::string&)> on_message;  // DataChannel (escena del host)
  std::function<void()> on_closed;                     // Disconnected/Failed/Closed
  std::function<void()> on_open;                       // DataChannel abierto (DTLS listo)
};

class PeerFactory {
 public:
  virtual ~PeerFactory() = default;
  virtual std::expected<std::shared_ptr<Peer>, http::Problem> create(const PeerRequest& request,
                                                                     PeerCallbacks callbacks) = 0;
};

// Redis: room:{id}:stream:enabled, room:{id}:stream:started_at y el canal room:{id}:stream.
class RoomStore : public http::RoomStatus {
 public:
  virtual bool enable(const std::string& room_id) = 0;
  virtual bool disable(const std::string& room_id) = 0;
  // SET NX started_at + PUBLISH STREAM_STARTED. false si ya estaba (una reconexión no reinicia el reloj).
  virtual bool publish_started(const std::string& room_id, std::int64_t started_at_ms) = 0;
  // DEL started_at + PUBLISH STREAM_ENDED (al terminar la sala: ROOM_CLOSED o gracia vencida).
  virtual void publish_ended(const std::string& room_id, const std::string& reason) = 0;
};

// POST /api/v1/internal/rooms/{id}/disable (gracia vencida, ADR 0019).
class IdentityClient {
 public:
  virtual ~IdentityClient() = default;
  virtual bool disable_room(const std::string& room_id, const std::string& reason) = 0;
};

struct SessionAnswer {
  std::string session_id;
  std::string sdp;
};

struct ServiceConfig {
  int max_viewers = 50;
  std::chrono::milliseconds host_grace{60'000};
  std::chrono::milliseconds media_timeout{3'000};
};

// Orquesta salas, sesiones y el ciclo de vida (HU-LIVE-01, 04, 05, 08). Thread-safe.
class StreamService : public http::SessionLookup {
 public:
  using Clock = std::function<std::int64_t()>;
  using Async = std::function<void(std::function<void()>)>;  // pool para IO bloqueante

  StreamService(
      ServiceConfig config, PeerFactory& peers, RoomStore& store, IdentityClient& identity, Clock clock,
      Async async = [](std::function<void()> f) { f(); });

  std::expected<SessionAnswer, http::Problem> publish(const http::WhipCommand& command);
  std::expected<SessionAnswer, http::Problem> watch(const http::WhepCommand& command);
  std::optional<http::Problem> trickle(const http::PatchCommand& command);
  void end_session(const http::DeleteCommand& command);

  bool events_start(const std::string& room_id);  // /internal/events/start/{id}
  bool events_stop(const std::string& room_id);
  // ROOM_CLOSED (identity-api): el reason del mensaje llega a stream_state y STREAM_ENDED.
  void on_room_closed(const std::string& room_id, sfu::EndReason reason = sfu::EndReason::HostEnded);
  void on_revoked(const std::string& jti);  // REVOKED: cierra sesiones con ese jti
  void tick();                              // gracia, watchdog, capas, viewer_count

  // http::SessionLookup
  std::optional<http::SessionInfo> session(const std::string& session_id) override;
  int viewer_count(const std::string& room_id) override;

  std::optional<sfu::State> state_of(const std::string& room_id);

 private:
  struct Session {
    std::string id;
    std::string room_id;
    std::string sub;
    std::string jti;
    PeerRole role;
    std::shared_ptr<Peer> peer;
  };
  struct RoomEntry {
    explicit RoomEntry(const std::string& id, const ServiceConfig& c)
        : room(id, sfu::RoomConfig{.max_viewers = c.max_viewers}), state(c.host_grace, c.media_timeout) {}
    sfu::Room room;
    std::mutex state_mu;
    sfu::StreamState state;
    std::shared_ptr<Peer> host_video;
    std::shared_ptr<Peer> host_audio;
    std::string host_video_session;
    std::string host_audio_session;
    std::atomic<std::int64_t> last_state_rtp_ms{0};
    int last_viewer_count = -1;
    std::int64_t last_host_stats_ms = INT64_MIN / 2;  // solo lo toca tick()
    std::string scene = "live";
  };

  std::shared_ptr<RoomEntry> entry(const std::string& room_id, bool create);
  void apply(const std::shared_ptr<RoomEntry>& e, const sfu::Effects& effects, std::int64_t now);
  void on_host_rtp(const std::shared_ptr<RoomEntry>& e, PeerRole role, rtp::ByteView packet);
  void on_host_closed(const std::shared_ptr<RoomEntry>& e, const std::string& session_id);
  void remove_session(const std::string& session_id);
  void teardown(const std::shared_ptr<RoomEntry>& e, const std::string& reason);
  std::string new_id();

  ServiceConfig config_;
  PeerFactory& peers_;
  RoomStore& store_;
  IdentityClient& identity_;
  Clock clock_;
  Async async_;
  std::mutex mu_;
  std::map<std::string, std::shared_ptr<RoomEntry>> rooms_;
  std::map<std::string, Session> sessions_;
};

}  // namespace stream::service
