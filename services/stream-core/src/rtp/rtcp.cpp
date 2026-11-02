#include "rtp/rtcp.hpp"

namespace stream::rtp {
namespace {

constexpr std::uint8_t kSR = 200, kRR = 201, kRTPFB = 205, kPSFB = 206;

std::uint16_t read16(ByteView b, std::size_t at) {
  return static_cast<std::uint16_t>((b[at] << 8) | b[at + 1]);
}
std::uint32_t read32(ByteView b, std::size_t at) {
  return (std::uint32_t{b[at]} << 24) | (std::uint32_t{b[at + 1]} << 16) | (std::uint32_t{b[at + 2]} << 8) |
         std::uint32_t{b[at + 3]};
}
void put16(Bytes& b, std::uint16_t v) {
  b.push_back(static_cast<std::uint8_t>(v >> 8));
  b.push_back(static_cast<std::uint8_t>(v));
}
void put32(Bytes& b, std::uint32_t v) {
  for (int s = 24; s >= 0; s -= 8) b.push_back(static_cast<std::uint8_t>(v >> s));
}
void put_header(Bytes& b, std::uint8_t count_or_fmt, std::uint8_t pt, std::size_t total_bytes) {
  b.push_back(static_cast<std::uint8_t>(0x80 | count_or_fmt));
  b.push_back(pt);
  put16(b, static_cast<std::uint16_t>(total_bytes / 4 - 1));
}

bool parse_report_blocks(ByteView pkt, std::size_t at, int count, RtcpInfo& info) {
  for (int i = 0; i < count; ++i, at += 24) {
    if (at + 24 > pkt.size()) return false;
    info.reports.push_back({read32(pkt, at), pkt[at + 4]});
  }
  return true;
}

}  // namespace

std::optional<RtcpInfo> parse_rtcp(ByteView data) {
  if (data.size() < 4) return std::nullopt;
  RtcpInfo info;
  std::size_t offset = 0;
  while (offset < data.size()) {
    if (offset + 4 > data.size() || (data[offset] >> 6) != 2) return std::nullopt;
    const std::size_t length = 4 * (std::size_t{read16(data, offset + 2)} + 1);
    if (offset + length > data.size()) return std::nullopt;
    const ByteView pkt = data.subspan(offset, length);
    const int count = pkt[0] & 0x1F;
    const std::uint8_t pt = pkt[1];
    offset += length;

    if (pt == kSR) {
      if (pkt.size() < 28) return std::nullopt;
      info.sender_reports.push_back(
          {read32(pkt, 4), (std::uint64_t{read32(pkt, 8)} << 32) | read32(pkt, 12), read32(pkt, 16)});
      if (!parse_report_blocks(pkt, 28, count, info)) return std::nullopt;
    } else if (pt == kRR) {
      if (pkt.size() < 8 || !parse_report_blocks(pkt, 8, count, info)) return std::nullopt;
    } else if (pt == kRTPFB && count == 1) {  // NACK genérico (RFC 4585 §6.2.1)
      if (pkt.size() < 12) return std::nullopt;
      Nack nack{read32(pkt, 8), {}};
      for (std::size_t at = 12; at + 4 <= pkt.size(); at += 4) {
        const std::uint16_t pid = read16(pkt, at);
        const std::uint16_t blp = read16(pkt, at + 2);
        nack.sequences.push_back(pid);
        for (int bit = 0; bit < 16; ++bit)
          if (blp & (1u << bit)) nack.sequences.push_back(static_cast<std::uint16_t>(pid + bit + 1));
      }
      info.nacks.push_back(std::move(nack));
    } else if (pt == kPSFB) {
      if (pkt.size() < 12) return std::nullopt;
      if (count == 1) {  // PLI
        info.keyframe_requests.push_back(read32(pkt, 8));
      } else if (count == 4) {  // FIR: FCI = SSRC + seq
        for (std::size_t at = 12; at + 8 <= pkt.size(); at += 8)
          info.keyframe_requests.push_back(read32(pkt, at));
      } else if (count == 15 && pkt.size() >= 20 && pkt[12] == 'R' && pkt[13] == 'E' && pkt[14] == 'M' &&
                 pkt[15] == 'B') {
        const std::size_t num = pkt[16];
        const unsigned exp = pkt[17] >> 2;
        const std::uint64_t mantissa = ((std::uint64_t{pkt[17]} & 0x03) << 16) | (pkt[18] << 8) | pkt[19];
        if (20 + 4 * num > pkt.size()) return std::nullopt;
        Remb remb{mantissa << exp, {}};
        for (std::size_t i = 0; i < num; ++i) remb.ssrcs.push_back(read32(pkt, 20 + 4 * i));
        info.remb = std::move(remb);
      }
    }
    // SDES, BYE, APP y XR no los usa el SFU.
  }
  return info;
}

Bytes build_pli(std::uint32_t sender_ssrc, std::uint32_t media_ssrc) {
  Bytes b;
  put_header(b, 1, kPSFB, 12);
  put32(b, sender_ssrc);
  put32(b, media_ssrc);
  return b;
}

Bytes build_nack(std::uint32_t sender_ssrc, std::uint32_t media_ssrc, std::span<const std::uint16_t> seqs) {
  // Agrupa en pares PID/BLP: cada PID cubre las 16 secuencias siguientes.
  std::vector<std::pair<std::uint16_t, std::uint16_t>> fci;
  for (auto seq : seqs) {
    if (!fci.empty()) {
      const std::uint16_t diff = static_cast<std::uint16_t>(seq - fci.back().first);
      if (diff >= 1 && diff <= 16) {
        fci.back().second |= static_cast<std::uint16_t>(1u << (diff - 1));
        continue;
      }
    }
    fci.emplace_back(seq, 0);
  }
  Bytes b;
  put_header(b, 1, kRTPFB, 12 + 4 * fci.size());
  put32(b, sender_ssrc);
  put32(b, media_ssrc);
  for (const auto& [pid, blp] : fci) {
    put16(b, pid);
    put16(b, blp);
  }
  return b;
}

Bytes build_remb(std::uint32_t sender_ssrc, std::uint64_t bitrate_bps, std::span<const std::uint32_t> ssrcs) {
  unsigned exp = 0;
  std::uint64_t mantissa = bitrate_bps;
  while (mantissa > 0x3FFFF) {  // 18 bits
    mantissa >>= 1;
    ++exp;
  }
  Bytes b;
  put_header(b, 15, kPSFB, 20 + 4 * ssrcs.size());
  put32(b, sender_ssrc);
  put32(b, 0);
  b.insert(b.end(), {'R', 'E', 'M', 'B'});
  b.push_back(static_cast<std::uint8_t>(ssrcs.size()));
  b.push_back(static_cast<std::uint8_t>((exp << 2) | ((mantissa >> 16) & 0x03)));
  b.push_back(static_cast<std::uint8_t>(mantissa >> 8));
  b.push_back(static_cast<std::uint8_t>(mantissa));
  for (auto s : ssrcs) put32(b, s);
  return b;
}

}  // namespace stream::rtp
