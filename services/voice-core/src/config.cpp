#include "config.hpp"

#include <charconv>

namespace voice {
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

  cfg.jwt_secret = get("JWT_SECRET");
  if (cfg.jwt_secret.empty()) return std::unexpected("JWT_SECRET es obligatoria");
  cfg.redis_url = get("REDIS_URL");
  if (cfg.redis_url.empty()) return std::unexpected("REDIS_URL es obligatoria (revocación: falla cerrado)");

  if (auto addr = get("VOICE_CORE_ADDR"); !addr.empty()) {
    auto colon = addr.rfind(':');
    if (colon == std::string::npos) return std::unexpected("VOICE_CORE_ADDR debe ser host:puerto");
    auto port = parse_number<std::uint16_t>(std::string_view(addr).substr(colon + 1));
    if (!port) return std::unexpected("VOICE_CORE_ADDR tiene un puerto inválido");
    cfg.port = *port;
    if (colon > 0) cfg.host = addr.substr(0, colon);
  }
  if (auto v = get("JWT_ISSUER"); !v.empty()) cfg.jwt_issuer = v;
  if (auto v = get("JWT_AUDIENCE"); !v.empty()) cfg.jwt_audience = v;

  auto origins = get("ALLOWED_ORIGINS");
  cfg.allowed_origins = split_csv(origins.empty() ? "localhost:5173,127.0.0.1:5173" : origins);

  if (auto v = get("VOICE_MAX_MEMBERS"); !v.empty()) {
    auto max = parse_number<std::size_t>(v);
    if (!max || *max < 2 || *max > 16) return std::unexpected("VOICE_MAX_MEMBERS debe estar entre 2 y 16");
    cfg.max_members = *max;
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

}  // namespace voice
