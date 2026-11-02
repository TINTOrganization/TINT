#pragma once

// Construye paquetes RTP/VP8 para las pruebas.
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace stream::testing {

struct RtpSpec {
  std::uint8_t pt = 96;
  bool marker = false;
  std::uint16_t seq = 1;
  std::uint32_t ts = 1000;
  std::uint32_t ssrc = 0x1111;
  std::vector<std::uint32_t> csrcs;
  std::vector<std::pair<int, std::string>> extensions;  // id -> datos (formato de un byte)
  bool two_byte_extensions = false;
  std::vector<std::uint8_t> payload{0xAA, 0xBB};
  std::uint8_t padding = 0;
};

inline void put16(std::vector<std::uint8_t>& b, std::uint16_t v) {
  b.push_back(v >> 8);
  b.push_back(v & 0xFF);
}
inline void put32(std::vector<std::uint8_t>& b, std::uint32_t v) {
  for (int s = 24; s >= 0; s -= 8) b.push_back((v >> s) & 0xFF);
}

inline std::vector<std::uint8_t> build_rtp(const RtpSpec& s) {
  std::vector<std::uint8_t> b;
  const bool ext = !s.extensions.empty();
  b.push_back(0x80 | (s.padding ? 0x20 : 0) | (ext ? 0x10 : 0) | static_cast<std::uint8_t>(s.csrcs.size()));
  b.push_back((s.marker ? 0x80 : 0) | s.pt);
  put16(b, s.seq);
  put32(b, s.ts);
  put32(b, s.ssrc);
  for (auto c : s.csrcs) put32(b, c);
  if (ext) {
    std::vector<std::uint8_t> data;
    for (const auto& [id, value] : s.extensions) {
      if (s.two_byte_extensions) {
        data.push_back(static_cast<std::uint8_t>(id));
        data.push_back(static_cast<std::uint8_t>(value.size()));
      } else {
        data.push_back(static_cast<std::uint8_t>((id << 4) | (value.size() - 1)));
      }
      data.insert(data.end(), value.begin(), value.end());
    }
    while (data.size() % 4) data.push_back(0);
    put16(b, s.two_byte_extensions ? 0x1000 : 0xBEDE);
    put16(b, static_cast<std::uint16_t>(data.size() / 4));
    b.insert(b.end(), data.begin(), data.end());
  }
  b.insert(b.end(), s.payload.begin(), s.payload.end());
  if (s.padding) {
    for (int i = 1; i < s.padding; ++i) b.push_back(0);
    b.push_back(s.padding);
  }
  return b;
}

// Descriptor VP8 (RFC 7741) + 3 bytes de cabecera de payload VP8.
struct Vp8Spec {
  bool start = true;
  std::uint8_t partition = 0;
  bool keyframe = false;
  int picture_id_bits = 15;  // 0 (sin I), 7 o 15
  std::uint16_t picture_id = 100;
  bool with_tl0 = true;
  std::uint8_t tl0picidx = 7;
};

inline std::vector<std::uint8_t> build_vp8_payload(const Vp8Spec& v) {
  std::vector<std::uint8_t> p;
  const bool x = v.picture_id_bits || v.with_tl0;
  p.push_back((x ? 0x80 : 0) | (v.start ? 0x10 : 0) | (v.partition & 0x07));
  if (x) {
    p.push_back((v.picture_id_bits ? 0x80 : 0) | (v.with_tl0 ? 0x40 : 0));
    if (v.picture_id_bits == 7) p.push_back(v.picture_id & 0x7F);
    if (v.picture_id_bits == 15) {
      p.push_back(0x80 | ((v.picture_id >> 8) & 0x7F));
      p.push_back(v.picture_id & 0xFF);
    }
    if (v.with_tl0) p.push_back(v.tl0picidx);
  }
  // Cabecera de frame VP8: bit P (0 = keyframe).
  p.push_back(v.keyframe ? 0x10 : 0x11);
  p.push_back(0x02);
  p.push_back(0x00);
  return p;
}

}  // namespace stream::testing
