#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "rooms/room_state.hpp"

namespace voice::testing {

// Estado de sala en memoria (ver rooms::RoomStateStore, ADR 0019). `unavailable` simula
// Redis caído: nullopt / false (falla cerrado → 503).
class FakeRoomState : public rooms::RoomStateStore {
 public:
  std::optional<bool> is_closed(const std::string& room_id) override {
    std::lock_guard lock(mu_);
    ++calls;
    if (unavailable) return std::nullopt;
    return closed_.contains(room_id);
  }
  std::optional<bool> is_live(const std::string& room_id) override {
    std::lock_guard lock(mu_);
    ++calls;
    if (unavailable || live_unavailable) return std::nullopt;
    return live_.contains(room_id);
  }
  std::optional<bool> is_on_stage(const std::string& room_id, const std::string& user_id) override {
    std::lock_guard lock(mu_);
    ++calls;
    if (unavailable || stage_unavailable) return std::nullopt;
    return stage_.contains({room_id, user_id});
  }
  bool set_on_stage(const std::string& room_id, const std::string& user_id, bool on_stage) override {
    std::lock_guard lock(mu_);
    ++writes;
    if (unavailable) return false;
    if (on_stage)
      stage_.insert({room_id, user_id});
    else
      stage_.erase({room_id, user_id});
    return true;
  }

  // Preparación de las pruebas (lo que escribe identity-api).
  void close(const std::string& room_id) {
    std::lock_guard lock(mu_);
    closed_.insert(room_id);
  }
  void make_live(const std::string& room_id) {
    std::lock_guard lock(mu_);
    live_.insert(room_id);
  }
  bool on_stage(const std::string& room_id, const std::string& user_id) {
    std::lock_guard lock(mu_);
    return stage_.contains({room_id, user_id});
  }

  std::atomic<bool> unavailable{false};
  // Fallos parciales (Redis que se cae a mitad del handshake o del DELETE).
  std::atomic<bool> live_unavailable{false};
  std::atomic<bool> stage_unavailable{false};
  std::atomic<int> calls{0};
  std::atomic<int> writes{0};

 private:
  std::mutex mu_;
  std::set<std::string> closed_;
  std::set<std::string> live_;
  std::set<std::pair<std::string, std::string>> stage_;
};

}  // namespace voice::testing
