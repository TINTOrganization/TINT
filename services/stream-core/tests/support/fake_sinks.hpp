#pragma once

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "rtp/packet.hpp"
#include "rtp/rtcp.hpp"
#include "sfu/room.hpp"

namespace stream::testing {

class FakeViewerSink : public sfu::ViewerSink {
 public:
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

  std::vector<rtp::Bytes> video_snapshot() {
    std::lock_guard l(mu);
    return video;
  }
  std::size_t video_count() {
    std::lock_guard l(mu);
    return video.size();
  }

  std::mutex mu;
  std::vector<rtp::Bytes> video, audio;
  std::vector<std::string> events;
  std::atomic<bool> closed{false};
};

class FakeHostSink : public sfu::HostSink {
 public:
  void send_video_rtcp(rtp::Bytes p) override {
    std::lock_guard l(mu);
    rtcp.push_back(std::move(p));
  }
  // SSRC del medio de cada PLI recibido.
  std::vector<std::uint32_t> plis() {
    std::lock_guard l(mu);
    std::vector<std::uint32_t> out;
    for (const auto& p : rtcp)
      if (auto info = rtp::parse_rtcp(p))
        out.insert(out.end(), info->keyframe_requests.begin(), info->keyframe_requests.end());
    return out;
  }
  // REMB recibidos (bitrate y SSRC).
  std::vector<rtp::Remb> rembs() {
    std::lock_guard l(mu);
    std::vector<rtp::Remb> out;
    for (const auto& p : rtcp)
      if (auto info = rtp::parse_rtcp(p); info && info->remb) out.push_back(*info->remb);
    return out;
  }
  std::mutex mu;
  std::vector<rtp::Bytes> rtcp;
};

}  // namespace stream::testing
