#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>

#include "http/request_decision.hpp"

namespace stream::testing {

class FakeRevocation : public http::RevocationChecker {
 public:
  std::optional<bool> is_revoked(const std::string& jti) override {
    std::lock_guard lock(mu_);
    ++calls;
    if (unavailable) return std::nullopt;
    return revoked_.contains(jti);
  }
  void revoke(const std::string& jti) {
    std::lock_guard lock(mu_);
    revoked_.insert(jti);
  }
  std::atomic<bool> unavailable{false};
  std::atomic<int> calls{0};

 private:
  std::mutex mu_;
  std::set<std::string> revoked_;
};

class FakeRoomStatus : public http::RoomStatus {
 public:
  std::optional<http::RoomFlags> flags(const std::string& room_id) override {
    std::lock_guard lock(mu_);
    if (unavailable) return std::nullopt;
    auto it = rooms_.find(room_id);
    return it == rooms_.end() ? http::RoomFlags{} : it->second;
  }
  void set(const std::string& room_id, http::RoomFlags flags) {
    std::lock_guard lock(mu_);
    rooms_[room_id] = flags;
  }
  std::atomic<bool> unavailable{false};

 private:
  std::mutex mu_;
  std::map<std::string, http::RoomFlags> rooms_;
};

class FakeSessions : public http::SessionLookup {
 public:
  std::optional<http::SessionInfo> session(const std::string& id) override {
    auto it = sessions.find(id);
    if (it == sessions.end()) return std::nullopt;
    return it->second;
  }
  int viewer_count(const std::string& room_id) override {
    auto it = viewers.find(room_id);
    return it == viewers.end() ? 0 : it->second;
  }
  std::map<std::string, http::SessionInfo> sessions;
  std::map<std::string, int> viewers;
};

}  // namespace stream::testing
