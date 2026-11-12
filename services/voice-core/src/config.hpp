#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace voice {

struct Config {
  std::string host = "0.0.0.0";
  std::uint16_t port = 8085;
  std::string redis_url;
  std::string jwt_secret;
  std::string jwt_issuer = "tint-identity";
  std::string jwt_audience = "tint:room";
  std::vector<std::string> allowed_origins;  // host[:puerto]
  std::size_t max_members = 8;
  std::vector<std::string> stun_urls;
  std::vector<std::string> turn_urls;
  std::string turn_secret;
  std::int64_t turn_ttl_s = 3600;
};

using EnvLookup = std::function<std::optional<std::string>(std::string_view)>;

// Lee la configuración de las variables de entorno; el error describe la variable inválida.
std::expected<Config, std::string> load_config(const EnvLookup& env);

// "a, b,,c" -> {"a", "b", "c"}
std::vector<std::string> split_csv(std::string_view csv);

}  // namespace voice
