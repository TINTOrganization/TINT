#pragma once

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "hub/hub.hpp"

namespace voice::testing {

// Peer en memoria: guarda lo que el Hub le envía y el cierre pedido.
class FakePeer : public hub::Peer {
 public:
  explicit FakePeer(std::string id) : id_(std::move(id)) {}

  const std::string& id() const override { return id_; }
  void send(std::string text) override {
    std::lock_guard lock(mu_);
    sent_.push_back(nlohmann::json::parse(text));
  }
  void close(std::uint16_t code, std::string reason) override {
    std::lock_guard lock(mu_);
    closed_ = std::make_pair(code, std::move(reason));
  }

  std::vector<nlohmann::json> sent() const {
    std::lock_guard lock(mu_);
    return sent_;
  }
  std::vector<nlohmann::json> of_type(const std::string& type) const {
    std::vector<nlohmann::json> out;
    for (auto& m : sent())
      if (m["type"] == type) out.push_back(m);
    return out;
  }
  std::optional<std::pair<std::uint16_t, std::string>> closed() const {
    std::lock_guard lock(mu_);
    return closed_;
  }
  void clear() {
    std::lock_guard lock(mu_);
    sent_.clear();
  }

 private:
  std::string id_;
  mutable std::mutex mu_;
  std::vector<nlohmann::json> sent_;
  std::optional<std::pair<std::uint16_t, std::string>> closed_;
};

}  // namespace voice::testing
