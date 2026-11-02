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

StreamState::StreamState(std::chrono::milliseconds grace, std::chrono::milliseconds media_timeout)
    : grace_(grace), media_timeout_(media_timeout) {}

std::optional<std::int64_t> StreamState::grace_deadline_ms() const {
  if (state_ != State::HostGrace) return std::nullopt;
  return grace_deadline_ms_;
}

Effects StreamState::on_host_publish(std::int64_t now_ms) {
  if (state_ == State::Ended) return {.rejected = true};
  host_present_ = true;
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
  if (!host_present_ || state_ == State::Ended) return {};
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

Effects StreamState::enter_grace(std::int64_t now_ms) {
  host_present_ = false;
  if (state_ == State::HostGrace || state_ == State::Ended) return {};
  state_ = State::HostGrace;
  grace_deadline_ms_ = now_ms + grace_.count();
  return {.notify_state = true};
}

Effects StreamState::on_host_lost(std::int64_t now_ms) { return enter_grace(now_ms); }

Effects StreamState::on_tick(std::int64_t now_ms) {
  if (state_ == State::HostGrace && now_ms >= grace_deadline_ms_) {
    state_ = State::Ended;
    end_reason_ = EndReason::GraceExpired;
    return {.notify_state = true, .request_disable = true, .teardown = true};
  }
  if (host_present_ && (state_ == State::Live || state_ == State::Waiting) &&
      now_ms - last_rtp_ms_ > media_timeout_.count())
    return enter_grace(now_ms);
  return {};
}

Effects StreamState::on_room_closed() {
  if (state_ == State::Ended) return {};
  state_ = State::Ended;
  end_reason_ = EndReason::RoomClosed;
  host_present_ = false;
  return {.notify_state = true, .teardown = true};
}

}  // namespace stream::sfu
