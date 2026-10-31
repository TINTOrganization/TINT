#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <set>
#include <string>

#include "net/handshake.hpp"

namespace voice::testing {

class FakeRevocation : public net::RevocationChecker {
 public:
  std::optional<bool> is_revoked(const std::string& jti) override {
    std::lock_guard lock(mu_);
    ++calls;
    if (unavailable) return std::nullopt;
    return revoked.contains(jti);
  }
  void revoke(const std::string& jti) {
    std::lock_guard lock(mu_);
    revoked.insert(jti);
  }

  std::atomic<bool> unavailable{false};
  std::atomic<int> calls{0};

 private:
  std::mutex mu_;
  std::set<std::string> revoked;
};

}  // namespace voice::testing
