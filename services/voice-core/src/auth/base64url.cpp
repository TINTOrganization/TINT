#include "auth/base64url.hpp"

#include <array>
#include <cstdint>

namespace voice::auth {
namespace {

constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

constexpr std::array<int, 256> make_reverse() {
  std::array<int, 256> table{};
  table.fill(-1);
  for (int i = 0; i < 64; ++i) table[static_cast<unsigned char>(kAlphabet[i])] = i;
  return table;
}
constexpr auto kReverse = make_reverse();

}  // namespace

std::string base64url_encode(std::string_view in) {
  std::string out;
  out.reserve((in.size() * 4 + 2) / 3);
  std::size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    std::uint32_t n = (static_cast<unsigned char>(in[i]) << 16) |
                      (static_cast<unsigned char>(in[i + 1]) << 8) | static_cast<unsigned char>(in[i + 2]);
    out.push_back(kAlphabet[(n >> 18) & 63]);
    out.push_back(kAlphabet[(n >> 12) & 63]);
    out.push_back(kAlphabet[(n >> 6) & 63]);
    out.push_back(kAlphabet[n & 63]);
  }
  std::size_t rest = in.size() - i;
  if (rest == 1) {
    std::uint32_t n = static_cast<unsigned char>(in[i]) << 16;
    out.push_back(kAlphabet[(n >> 18) & 63]);
    out.push_back(kAlphabet[(n >> 12) & 63]);
  } else if (rest == 2) {
    std::uint32_t n =
        (static_cast<unsigned char>(in[i]) << 16) | (static_cast<unsigned char>(in[i + 1]) << 8);
    out.push_back(kAlphabet[(n >> 18) & 63]);
    out.push_back(kAlphabet[(n >> 12) & 63]);
    out.push_back(kAlphabet[(n >> 6) & 63]);
  }
  return out;
}

std::optional<std::string> base64url_decode(std::string_view in) {
  if (in.size() % 4 == 1) return std::nullopt;
  std::string out;
  out.reserve(in.size() * 3 / 4);
  std::uint32_t buffer = 0;
  int bits = 0;
  for (char c : in) {
    int value = kReverse[static_cast<unsigned char>(c)];
    if (value < 0) return std::nullopt;
    buffer = (buffer << 6) | static_cast<std::uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((buffer >> bits) & 0xFF));
    }
  }
  return out;
}

}  // namespace voice::auth
