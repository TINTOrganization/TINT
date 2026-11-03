#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string_view>

namespace stream::sfu {

enum class State { Waiting, Live, HostGrace, Ended };
// reason de cierre único (dominio-transmision §6.1): ROOM_CLOSED, STREAM_ENDED, stream_state y analítica.
enum class EndReason { None, HostEnded, GraceExpired };

std::string_view to_string(State state);
std::string_view to_string(EndReason reason);  // "host_ended" | "grace_expired" ("" con None)
std::optional<EndReason> parse_end_reason(std::string_view text);

// Qué tiene que hacer quien llama (sin IO aquí dentro).
struct Effects {
  bool notify_state = false;            // enviar stream_state a todos
  bool publish_stream_started = false;  // STREAM_STARTED (solo la primera vez)
  bool request_keyframe = false;        // PLI a todas las capas del host
  bool request_disable = false;         // POST /internal/rooms/{id}/disable a identity-api
  bool teardown = false;                // cerrar todas las sesiones de la sala
  bool rejected = false;                // la operación no aplica (p. ej. publicar en Ended)
};

// Ciclo de vida de la transmisión de una sala (HU-LIVE-05). Reloj inyectado en ms.
//   Waiting --keyframe--> Live --host perdido / 3 s sin RTP--> HostGrace
//   HostGrace --nuevo WHIP--> Live          HostGrace --vence la gracia--> Ended
//   HostGrace (solo por el watchdog: la sesión sigue abierta) --vuelve el RTP--> Live | Waiting
//   cualquiera --ROOM_CLOSED--> Ended
class StreamState {
 public:
  explicit StreamState(std::chrono::milliseconds grace,
                       std::chrono::milliseconds media_timeout = std::chrono::seconds(3));

  State state() const { return state_; }
  EndReason end_reason() const { return end_reason_; }
  std::optional<std::int64_t> grace_deadline_ms() const;

  Effects on_host_publish(std::int64_t now_ms);  // WHIP del host aceptado (primera vez o reconexión)
  Effects on_host_rtp(std::int64_t now_ms, bool keyframe);
  Effects on_host_lost(std::int64_t now_ms);  // PeerConnection Disconnected/Failed/Closed o DELETE
  Effects on_tick(std::int64_t now_ms);       // vence la gracia o el watchdog de medios
  Effects on_room_closed(EndReason reason = EndReason::HostEnded);  // ROOM_CLOSED de identity-api

 private:
  Effects enter_grace(std::int64_t now_ms, bool session_alive);
  Effects resume_after_stall(bool keyframe);

  std::chrono::milliseconds grace_;
  std::chrono::milliseconds media_timeout_;
  State state_ = State::Waiting;
  EndReason end_reason_ = EndReason::None;
  bool host_present_ = false;
  bool media_stalled_ = false;  // gracia por el watchdog con la sesión del host todavía abierta
  bool started_published_ = false;
  std::int64_t last_rtp_ms_ = 0;
  std::int64_t grace_deadline_ms_ = 0;
};

}  // namespace stream::sfu
