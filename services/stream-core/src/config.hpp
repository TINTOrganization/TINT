#pragma once

#include <cstdint>
#include <expected>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace stream {

struct Config {
  std::string host = "0.0.0.0";
  std::uint16_t port = 8086;
  std::uint16_t udp_port = 8087;  // ICE UDP mux: un solo puerto para todos los medios
  std::string public_ip;          // se anuncia en el candidato host (Docker)
  std::string redis_url;
  std::string jwt_secret;
  std::string jwt_issuer = "tint-identity";
  std::string jwt_audience = "tint:room";
  std::vector<std::string> allowed_origins;
  int max_viewers = 50;
  std::int64_t host_grace_s = 60;
  std::string identity_api_url;  // http://identity-api:8081
  std::string internal_api_secret;
  std::vector<std::string> stun_urls;
  std::vector<std::string> turn_urls;
  std::string turn_secret;
  std::int64_t turn_ttl_s = 3600;
};

using EnvLookup = std::function<std::optional<std::string>(std::string_view)>;

std::vector<std::string> split_csv(std::string_view csv);

// Lee y valida las variables de entorno (ver AGENTS.md del servicio).
std::expected<Config, std::string> load_config(const EnvLookup& env);

}  // namespace stream
