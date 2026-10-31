#include "util/uuid.hpp"

#include <array>
#include <cstdint>
#include <random>

namespace voice::util {

std::string new_uuid() {
  thread_local std::mt19937_64 rng{std::random_device{}()};
  std::array<std::uint8_t, 16> b{};
  for (std::size_t i = 0; i < b.size(); i += 8) {
    const std::uint64_t r = rng();
    for (std::size_t j = 0; j < 8; ++j) b[i + j] = static_cast<std::uint8_t>(r >> (j * 8));
  }
  b[6] = static_cast<std::uint8_t>((b[6] & 0x0F) | 0x40);  // versión 4
  b[8] = static_cast<std::uint8_t>((b[8] & 0x3F) | 0x80);  // variante RFC 4122
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(36);
  for (std::size_t i = 0; i < b.size(); ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out.push_back('-');
    out.push_back(kHex[b[i] >> 4]);
    out.push_back(kHex[b[i] & 0x0F]);
  }
  return out;
}

}  // namespace voice::util
