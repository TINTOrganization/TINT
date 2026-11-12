#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "rtp/packet.hpp"

namespace stream::rtp {

struct ReportBlock {
  std::uint32_t ssrc = 0;
  std::uint8_t fraction_lost = 0;  // /256
};

struct SenderReport {
  std::uint32_t ssrc = 0;
  std::uint64_t ntp = 0;
  std::uint32_t rtp_timestamp = 0;
};

struct Nack {
  std::uint32_t media_ssrc = 0;
  std::vector<std::uint16_t> sequences;
};

struct Remb {
  std::uint64_t bitrate_bps = 0;
  std::vector<std::uint32_t> ssrcs;
};

// Lo que el SFU usa de un paquete RTCP compuesto.
struct RtcpInfo {
  std::vector<SenderReport> sender_reports;
  std::vector<ReportBlock> reports;
  std::vector<Nack> nacks;
  std::vector<std::uint32_t> keyframe_requests;  // PLI y FIR: SSRC del medio
  std::optional<Remb> remb;
};

// nullopt si algún paquete del compuesto está mal formado.
std::optional<RtcpInfo> parse_rtcp(ByteView packet);

Bytes build_pli(std::uint32_t sender_ssrc, std::uint32_t media_ssrc);
Bytes build_nack(std::uint32_t sender_ssrc, std::uint32_t media_ssrc, std::span<const std::uint16_t> seqs);
Bytes build_remb(std::uint32_t sender_ssrc, std::uint64_t bitrate_bps, std::span<const std::uint32_t> ssrcs);

}  // namespace stream::rtp
