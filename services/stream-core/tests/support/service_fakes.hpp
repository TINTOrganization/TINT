#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include "service/stream_service.hpp"
#include "support/fake_sinks.hpp"

namespace stream::testing {

class FakePeer : public service::Peer {
 public:
  explicit FakePeer(std::string ufrag) : ufrag_(std::move(ufrag)) {}
  const std::string& answer_sdp() const override { return answer_; }
  const std::string& remote_ufrag() const override { return ufrag_; }
  void add_remote_candidates(const std::string& f) override {
    std::lock_guard l(mu);
    candidates.push_back(f);
  }
  void send_video(rtp::Bytes p) override {
    std::lock_guard l(mu);
    video.push_back(std::move(p));
  }
  void send_audio(rtp::Bytes p) override {
    std::lock_guard l(mu);
    audio.push_back(std::move(p));
  }
  void send_event(std::string json) override {
    std::lock_guard l(mu);
    events.push_back(std::move(json));
  }
  void close() override { closed = true; }
  void send_video_rtcp(rtp::Bytes p) override {
    std::lock_guard l(mu);
    rtcp.push_back(std::move(p));
  }
  bool has_event(std::string_view needle) {
    std::lock_guard l(mu);
    for (const auto& e : events)
      if (e.find(needle) != std::string::npos) return true;
    return false;
  }

  std::mutex mu;
  std::vector<std::string> candidates, events;
  std::vector<rtp::Bytes> video, audio, rtcp;
  std::atomic<bool> closed{false};

 private:
  std::string answer_ = "v=0\r\n";
  std::string ufrag_;
};

class FakePeerFactory : public service::PeerFactory {
 public:
  std::expected<std::shared_ptr<service::Peer>, http::Problem> create(
      const service::PeerRequest& request, service::PeerCallbacks callbacks) override {
    if (fail) return std::unexpected(http::Problem{400, "INVALID_SDP", "no se pudo negociar"});
    auto peer = std::make_shared<FakePeer>("ufrag-" + request.session_id);
    created[request.session_id] = {request, std::move(callbacks), peer};
    last_session = request.session_id;
    return peer;
  }
  struct Created {
    service::PeerRequest request;
    service::PeerCallbacks callbacks;
    std::shared_ptr<FakePeer> peer;
  };
  std::map<std::string, Created> created;
  std::string last_session;
  bool fail = false;
};

class FakeRoomStore : public service::RoomStore {
 public:
  std::optional<http::RoomFlags> flags(const std::string& room) override {
    std::lock_guard l(mu);
    return http::RoomFlags{enabled.contains(room), closed.contains(room)};
  }
  bool enable(const std::string& room) override {
    std::lock_guard l(mu);
    enabled.insert(room);
    return !unavailable;
  }
  bool disable(const std::string& room) override {
    std::lock_guard l(mu);
    enabled.erase(room);
    return !unavailable;
  }
  bool publish_started(const std::string& room, std::int64_t at) override {
    std::lock_guard l(mu);
    if (started.contains(room)) return false;
    started[room] = at;
    return true;
  }
  void publish_ended(const std::string& room, const std::string& reason) override {
    std::lock_guard l(mu);
    ended.emplace_back(room, reason);
  }
  std::mutex mu;
  std::set<std::string> enabled, closed;
  std::map<std::string, std::int64_t> started;
  std::vector<std::pair<std::string, std::string>> ended;
  bool unavailable = false;
};

class FakeIdentityClient : public service::IdentityClient {
 public:
  bool disable_room(const std::string& room, const std::string& reason) override {
    std::lock_guard l(mu);
    calls.emplace_back(room, reason);
    return succeed;
  }
  std::mutex mu;
  std::vector<std::pair<std::string, std::string>> calls;
  bool succeed = true;
};

}  // namespace stream::testing
