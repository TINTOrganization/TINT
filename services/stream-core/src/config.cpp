#include "config.hpp"

#include <charconv>

namespace stream {
namespace {

std::string trim(std::string_view s) {
  const auto begin = s.find_first_not_of(" \t");
  if (begin == std::string_view::npos) return {};
  const auto end = s.find_last_not_of(" \t");
  return std::string(s.substr(begin, end - begin + 1));
}

template <typename T>
std::optional<T> parse_number(std::string_view s) {
  T value{};
  auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), value);
  if (ec != std::errc{} || ptr != s.data() + s.size() || s.empty()) return std::nullopt;
  return value;
}

}  // namespace

std::vector<std::string> split_csv(std::string_view csv) {
  std::vector<std::string> out;
  while (!csv.empty()) {
    auto comma = csv.find(',');
    auto item = trim(csv.substr(0, comma));
    if (!item.empty()) out.push_back(std::move(item));
    if (comma == std::string_view::npos) break;
    csv.remove_prefix(comma + 1);
  }
  return out;
}

std::expected<Config, std::string> load_config(const EnvLookup& env) {
  Config cfg;
  auto get = [&](std::string_view key) { return env(key).value_or(""); };
  auto required = [&](std::string_view key, std::string& out,
                      std::string_view why) -> std::optional<std::string> {
    out = get(key);
    if (out.empty()) return std::string(key) + " es obligatoria (" + std::string(why) + ")";
    return std::nullopt;
  };

  if (auto e = required("JWT_SECRET", cfg.jwt_secret, "la misma de identity-api")) return std::unexpected(*e);
  if (auto e = required("REDIS_URL", cfg.redis_url, "revocación y estado de la sala: falla cerrado"))
    return std::unexpected(*e);
  if (auto e = required("STREAM_PUBLIC_IP", cfg.public_ip, "se anuncia en el candidato ICE"))
    return std::unexpected(*e);
  if (auto e =
          required("IDENTITY_API_URL", cfg.identity_api_url, "para deshabilitar la sala al vencer la gracia"))
    return std::unexpected(*e);
  if (auto e =
          required("INTERNAL_API_SECRET", cfg.internal_api_secret, "X-Internal-Token hacia identity-api"))
    return std::unexpected(*e);

  if (auto addr = get("STREAM_CORE_ADDR"); !addr.empty()) {
    auto colon = addr.rfind(':');
    if (colon == std::string::npos) return std::unexpected("STREAM_CORE_ADDR debe ser host:puerto o :puerto");
    auto port = parse_number<std::uint16_t>(std::string_view(addr).substr(colon + 1));
    if (!port || *port == 0) return std::unexpected("STREAM_CORE_ADDR tiene un puerto inválido");
    cfg.port = *port;
    if (colon > 0) cfg.host = addr.substr(0, colon);
  }
  if (auto v = get("STREAM_UDP_PORT"); !v.empty()) {
    auto port = parse_number<std::uint16_t>(v);
    if (!port || *port == 0) return std::unexpected("STREAM_UDP_PORT debe ser un puerto válido");
    cfg.udp_port = *port;
  }
  if (auto v = get("JWT_ISSUER"); !v.empty()) cfg.jwt_issuer = v;
  if (auto v = get("JWT_AUDIENCE"); !v.empty()) cfg.jwt_audience = v;

  auto origins = get("ALLOWED_ORIGINS");
  cfg.allowed_origins = split_csv(origins.empty() ? "localhost:5173,127.0.0.1:5173" : origins);

  if (auto v = get("STREAM_MAX_VIEWERS"); !v.empty()) {
    auto max = parse_number<int>(v);
    if (!max || *max < 1 || *max > 50) return std::unexpected("STREAM_MAX_VIEWERS debe estar entre 1 y 50");
    cfg.max_viewers = *max;
  }
  if (auto v = get("STREAM_HOST_GRACE_S"); !v.empty()) {
    auto grace = parse_number<std::int64_t>(v);
    if (!grace || *grace < 10 || *grace > 300)
      return std::unexpected("STREAM_HOST_GRACE_S debe estar entre 10 y 300");
    cfg.host_grace_s = *grace;
  }

  cfg.stun_urls = split_csv(get("STUN_URLS"));
  cfg.turn_urls = split_csv(get("TURN_URLS"));
  cfg.turn_secret = get("TURN_SECRET");
  if (!cfg.turn_urls.empty() && cfg.turn_secret.empty())
    return std::unexpected("TURN_URLS necesita TURN_SECRET para firmar credenciales");
  if (auto v = get("TURN_TTL_SECONDS"); !v.empty()) {
    auto ttl = parse_number<std::int64_t>(v);
    if (!ttl || *ttl <= 0) return std::unexpected("TURN_TTL_SECONDS debe ser positivo");
    cfg.turn_ttl_s = *ttl;
  }
  return cfg;
}

}  // namespace stream
