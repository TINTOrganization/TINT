#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "moderation/mute_store.hpp"

namespace voice::testing {

class FakeMuteStore : public moderation::MuteStore {
 public:
  std::optional<bool> is_muted(const std::string& room_id, const std::string& user_id) override {
    std::lock_guard lock(mu_);
    if (unavailable) return std::nullopt;
    return muted_.contains({room_id, user_id});
  }
  bool set_muted(const std::string& room_id, const std::string& user_id, bool muted) override {
    std::lock_guard lock(mu_);
    ++writes;
    if (unavailable) return false;
    if (muted)
      muted_.insert({room_id, user_id});
    else
      muted_.erase({room_id, user_id});
    return true;
  }
  bool contains(const std::string& room_id, const std::string& user_id) {
    std::lock_guard lock(mu_);
    return muted_.contains({room_id, user_id});
  }

  std::atomic<bool> unavailable{false};
  std::atomic<int> writes{0};

 private:
  std::mutex mu_;
  std::set<std::pair<std::string, std::string>> muted_;
};

}  // namespace voice::testing
