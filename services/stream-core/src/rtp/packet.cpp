#include "rtp/packet.hpp"

namespace stream::rtp {
namespace {

std::uint16_t read16(ByteView b, std::size_t at) {
  return static_cast<std::uint16_t>((b[at] << 8) | b[at + 1]);
}
std::uint32_t read32(ByteView b, std::size_t at) {
  return (std::uint32_t{b[at]} << 24) | (std::uint32_t{b[at + 1]} << 16) | (std::uint32_t{b[at + 2]} << 8) |
         std::uint32_t{b[at + 3]};
}
void write16(std::span<std::uint8_t> b, std::size_t at, std::uint16_t v) {
  b[at] = static_cast<std::uint8_t>(v >> 8);
  b[at + 1] = static_cast<std::uint8_t>(v);
}
void write32(std::span<std::uint8_t> b, std::size_t at, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) b[at + i] = static_cast<std::uint8_t>(v >> (24 - 8 * i));
}

constexpr std::uint16_t kOneByteProfile = 0xBEDE;
constexpr bool is_two_byte_profile(std::uint16_t p) { return (p & 0xFFF0) == 0x1000; }

}  // namespace

bool looks_like_rtcp(ByteView packet) {
  if (packet.size() < 8 || (packet[0] >> 6) != 2) return false;
  const auto pt = packet[1];
  return pt >= 192 && pt <= 223;
}

std::optional<RtpView> parse_rtp(ByteView p) {
  if (p.size() < 12 || (p[0] >> 6) != 2) return std::nullopt;
  RtpView v;
  const bool padding = p[0] & 0x20;
  const bool extension = p[0] & 0x10;
  const std::size_t csrc_count = p[0] & 0x0F;
  v.marker = p[1] & 0x80;
  v.payload_type = p[1] & 0x7F;
  v.seq = read16(p, 2);
  v.timestamp = read32(p, 4);
  v.ssrc = read32(p, 8);

  std::size_t offset = 12 + 4 * csrc_count;
  if (offset > p.size()) return std::nullopt;
  if (extension) {
    if (offset + 4 > p.size()) return std::nullopt;
    v.extension_profile = read16(p, offset);
    const std::size_t words = read16(p, offset + 2);
    v.extension_offset = offset + 4;
    v.extension_size = 4 * words;
    offset = v.extension_offset + v.extension_size;
    if (offset > p.size()) return std::nullopt;
  }
  std::size_t pad = 0;
  if (padding) {
    if (p.size() == offset) return std::nullopt;
    pad = p.back();
    if (pad == 0 || offset + pad > p.size()) return std::nullopt;
  }
  v.payload_offset = offset;
  v.payload_size = p.size() - offset - pad;
  return v;
}

std::optional<ByteView> find_extension(ByteView p, const RtpView& v, int id) {
  if (v.extension_size == 0) return std::nullopt;
  const bool one_byte = v.extension_profile == kOneByteProfile;
  if (!one_byte && !is_two_byte_profile(v.extension_profile)) return std::nullopt;
  std::size_t i = v.extension_offset;
  const std::size_t end = v.extension_offset + v.extension_size;
  while (i < end) {
    if (p[i] == 0) {  // relleno entre elementos
      ++i;
      continue;
    }
    int element_id;
    std::size_t len;
    if (one_byte) {
      element_id = p[i] >> 4;
      len = (p[i] & 0x0F) + 1u;
      if (element_id == 15) break;  // reservado: fin de la extensión
      ++i;
    } else {
      if (i + 1 >= end) break;
      element_id = p[i];
      len = p[i + 1];
      i += 2;
    }
    if (i + len > end) break;
    if (element_id == id) return p.subspan(i, len);
    i += len;
  }
  return std::nullopt;
}

void set_payload_type(std::span<std::uint8_t> p, std::uint8_t pt) {
  p[1] = static_cast<std::uint8_t>((p[1] & 0x80) | (pt & 0x7F));
}
void set_sequence(std::span<std::uint8_t> p, std::uint16_t seq) { write16(p, 2, seq); }
void set_timestamp(std::span<std::uint8_t> p, std::uint32_t ts) { write32(p, 4, ts); }
void set_ssrc(std::span<std::uint8_t> p, std::uint32_t ssrc) { write32(p, 8, ssrc); }

Bytes rewrite_extensions(ByteView p, const RtpView& v, const std::map<int, int>& keep) {
  // Elementos que se conservan, ya con el id del receptor (formato de un byte: id 1..14, 1..16 bytes).
  Bytes ext;
  for (const auto& [from, to] : keep) {
    auto data = find_extension(p, v, from);
    if (!data || data->empty() || data->size() > 16 || to < 1 || to > 14) continue;
    ext.push_back(static_cast<std::uint8_t>((to << 4) | (data->size() - 1)));
    ext.insert(ext.end(), data->begin(), data->end());
  }
  while (ext.size() % 4) ext.push_back(0);

  const std::size_t csrc_bytes = 4 * (p[0] & 0x0F);
  Bytes out;
  out.reserve(12 + csrc_bytes + (ext.empty() ? 0 : 4 + ext.size()) + v.payload_size);
  out.insert(out.end(), p.begin(), p.begin() + 12 + csrc_bytes);
  out[0] = static_cast<std::uint8_t>(out[0] & ~0x30);  // sin padding ni extensión por ahora
  if (!ext.empty()) {
    out[0] |= 0x10;
    out.push_back(kOneByteProfile >> 8);
    out.push_back(kOneByteProfile & 0xFF);
    const auto words = static_cast<std::uint16_t>(ext.size() / 4);
    out.push_back(static_cast<std::uint8_t>(words >> 8));
    out.push_back(static_cast<std::uint8_t>(words));
    out.insert(out.end(), ext.begin(), ext.end());
  }
  out.insert(out.end(), p.begin() + v.payload_offset, p.begin() + v.payload_offset + v.payload_size);
  return out;
}

}  // namespace stream::rtp
