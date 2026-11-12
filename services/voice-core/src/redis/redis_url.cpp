#include "redis/redis_url.hpp"

#include <charconv>

namespace voice::redis {
namespace {

std::string percent_decode(std::string_view in) {
  std::string out;
  for (std::size_t i = 0; i < in.size(); ++i) {
    unsigned value = 0;
    if (in[i] == '%' && i + 2 < in.size() &&
        std::from_chars(in.data() + i + 1, in.data() + i + 3, value, 16).ptr == in.data() + i + 3) {
      out.push_back(static_cast<char>(value));
      i += 2;
    } else {
      out.push_back(in[i]);
    }
  }
  return out;
}

}  // namespace

std::expected<RedisEndpoint, std::string> parse_redis_url(std::string_view url) {
  constexpr std::string_view kScheme = "redis://";
  if (!url.starts_with(kScheme)) return std::unexpected("REDIS_URL debe empezar por redis://");
  url.remove_prefix(kScheme.size());

  RedisEndpoint ep;
  if (auto at = url.rfind('@'); at != std::string_view::npos) {
    std::string_view userinfo = url.substr(0, at);
    auto colon = userinfo.find(':');
    ep.password = percent_decode(colon == std::string_view::npos ? userinfo : userinfo.substr(colon + 1));
    url.remove_prefix(at + 1);
  }

  std::string_view hostport = url.substr(0, url.find('/'));
  if (auto slash = url.find('/'); slash != std::string_view::npos) {
    std::string_view db = url.substr(slash + 1);
    if (!db.empty()) {
      auto [ptr, ec] = std::from_chars(db.data(), db.data() + db.size(), ep.db);
      if (ec != std::errc{} || ptr != db.data() + db.size())
        return std::unexpected("REDIS_URL: base de datos inválida");
    }
  }

  auto colon = hostport.rfind(':');
  ep.host = std::string(hostport.substr(0, colon));
  if (colon != std::string_view::npos) {
    std::string_view port = hostport.substr(colon + 1);
    auto [ptr, ec] = std::from_chars(port.data(), port.data() + port.size(), ep.port);
    if (ec != std::errc{} || ptr != port.data() + port.size() || port.empty())
      return std::unexpected("REDIS_URL: puerto inválido");
  }
  if (ep.host.empty()) return std::unexpected("REDIS_URL: falta el host");
  return ep;
}

}  // namespace voice::redis
