#include "rtp/vp8.hpp"

namespace stream::rtp {

std::optional<Vp8Descriptor> parse_vp8(std::span<const std::uint8_t> p) {
  if (p.empty()) return std::nullopt;
  Vp8Descriptor d;
  std::size_t i = 0;
  const bool x = p[i] & 0x80;
  d.start_of_partition = p[i] & 0x10;
  d.partition_index = p[i] & 0x07;
  ++i;
  if (x) {
    if (i >= p.size()) return std::nullopt;
    const bool has_i = p[i] & 0x80;
    const bool has_l = p[i] & 0x40;
    const bool has_t = p[i] & 0x20;
    const bool has_k = p[i] & 0x10;
    ++i;
    if (has_i) {
      if (i >= p.size()) return std::nullopt;
      d.picture_id_offset = i;
      if (p[i] & 0x80) {
        if (i + 1 >= p.size()) return std::nullopt;
        d.picture_id = static_cast<std::uint16_t>(((p[i] & 0x7F) << 8) | p[i + 1]);
        d.picture_id_15bit = true;
        i += 2;
      } else {
        d.picture_id = p[i] & 0x7F;
        ++i;
      }
    }
    if (has_l) {
      if (i >= p.size()) return std::nullopt;
      d.tl0picidx_offset = i;
      d.tl0picidx = p[i];
      ++i;
    }
    if (has_t || has_k) {
      if (i >= p.size()) return std::nullopt;
      ++i;
    }
  }
  d.size = i;
  // Cabecera del frame VP8 (RFC 6386 §9.1): bit P = 0 en un keyframe.
  d.keyframe = d.start_of_partition && d.partition_index == 0 && i < p.size() && (p[i] & 0x01) == 0;
  return d;
}

void write_picture_id(std::span<std::uint8_t> p, const Vp8Descriptor& d, std::uint16_t picture_id) {
  if (!d.picture_id) return;
  if (d.picture_id_15bit) {
    p[d.picture_id_offset] = static_cast<std::uint8_t>(0x80 | ((picture_id >> 8) & 0x7F));
    p[d.picture_id_offset + 1] = static_cast<std::uint8_t>(picture_id & 0xFF);
  } else {
    p[d.picture_id_offset] = static_cast<std::uint8_t>(picture_id & 0x7F);
  }
}

void write_tl0picidx(std::span<std::uint8_t> p, const Vp8Descriptor& d, std::uint8_t value) {
  if (d.tl0picidx) p[d.tl0picidx_offset] = value;
}

}  // namespace stream::rtp
