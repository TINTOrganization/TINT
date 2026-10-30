#pragma once

#include <cstdint>
#include <expected>
#include <string>
#include <string_view>

namespace voice::redis {

struct RedisEndpoint {
  std::string host;
  std::uint16_t port = 6379;
  std::string password;
  int db = 0;
};

// redis://[:password@]host[:port][/db]
std::expected<RedisEndpoint, std::string> parse_redis_url(std::string_view url);

}  // namespace voice::redis
