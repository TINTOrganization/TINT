#include "sfu/stream_state.hpp"

namespace stream::sfu {

std::string_view to_string(State state) {
  switch (state) {
    case State::Waiting:
      return "waiting";
    case State::Live:
      return "live";
    case State::HostGrace:
      return "reconnecting";
    case State::Ended:
      return "ended";
  }
  return "unknown";
}

std::string_view to_string(EndReason reason) {
  switch (reason) {
    case EndReason::HostEnded:
      return "host_ended";
    case EndReason::GraceExpired:
      return "grace_expired";
    case EndReason::None:
      break;
  }
  return "";
}

std::optional<EndReason> parse_end_reason(std::string_view text) {
  if (text == "host_ended") return EndReason::HostEnded;
  if (text == "grace_expired") return EndReason::GraceExpired;
  return std::nullopt;
}

StreamState::StreamState(std::chrono::milliseconds grace, std::chrono::milliseconds media_timeout)
    : grace_(grace), media_timeout_(media_timeout) {}

std::optional<std::int64_t> StreamState::grace_deadline_ms() const {
  if (state_ != State::HostGrace) return std::nullopt;
  return grace_deadline_ms_;
}

Effects StreamState::on_host_publish(std::int64_t now_ms) {
  if (state_ == State::Ended) return {.rejected = true};
  host_present_ = true;
  media_stalled_ = false;
  last_rtp_ms_ = now_ms;  // el watchdog cuenta desde que publica
  Effects e{.request_keyframe = true};
  if (state_ == State::HostGrace) {
    // Volvió a tiempo (AC3): los viewers conservan su sesión y piden un keyframe nuevo.
    state_ = State::Live;
    e.notify_state = true;
  }
  return e;
}

Effects StreamState::on_host_rtp(std::int64_t now_ms, bool keyframe) {
  if (state_ == State::Ended) return {};
  if (media_stalled_) {
    last_rtp_ms_ = now_ms;
    return resume_after_stall(keyframe);
  }
  if (!host_present_) return {};
  last_rtp_ms_ = now_ms;
  if (state_ != State::Waiting || !keyframe) return {};
  state_ = State::Live;
  Effects e{.notify_state = true};
  if (!started_published_) {
    started_published_ = true;
    e.publish_stream_started = true;
  }
  return e;
}

// El RTP volvió por la misma sesión tras un parón: no hubo desconexión, se cancela la gracia.
// Si ya hubo imagen vuelve a Live; si nunca la hubo, espera su primer keyframe.
Effects StreamState::resume_after_stall(bool keyframe) {
  media_stalled_ = false;
  host_present_ = true;
  Effects e{.notify_state = true, .request_keyframe = true};
  if (started_published_) {
    state_ = State::Live;
  } else if (keyframe) {
    state_ = State::Live;
    started_published_ = true;
    e.publish_stream_started = true;
  } else {
    state_ = State::Waiting;
  }
  return e;
}

Effects StreamState::enter_grace(std::int64_t now_ms, bool session_alive) {
  host_present_ = false;
  media_stalled_ = session_alive && state_ != State::HostGrace;
  if (state_ == State::HostGrace || state_ == State::Ended) return {};
  state_ = State::HostGrace;
  grace_deadline_ms_ = now_ms + grace_.count();
  return {.notify_state = true};
}

Effects StreamState::on_host_lost(std::int64_t now_ms) {
  media_stalled_ = false;  // la sesión se cerró: solo un WHIP nuevo devuelve al host
  return enter_grace(now_ms, /*session_alive=*/false);
}

Effects StreamState::on_tick(std::int64_t now_ms) {
  if (state_ == State::HostGrace && now_ms >= grace_deadline_ms_) {
    state_ = State::Ended;
    end_reason_ = EndReason::GraceExpired;
    media_stalled_ = false;
    return {.notify_state = true, .request_disable = true, .teardown = true};
  }
  if (host_present_ && (state_ == State::Live || state_ == State::Waiting) &&
      now_ms - last_rtp_ms_ > media_timeout_.count())
    return enter_grace(now_ms, /*session_alive=*/true);
  return {};
}

Effects StreamState::on_room_closed(EndReason reason) {
  if (state_ == State::Ended) return {};
  state_ = State::Ended;
  end_reason_ = reason == EndReason::None ? EndReason::HostEnded : reason;
  host_present_ = false;
  media_stalled_ = false;
  return {.notify_state = true, .teardown = true};
}

}  // namespace stream::sfu
