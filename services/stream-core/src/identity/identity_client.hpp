#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <string>

#include "service/stream_service.hpp"

namespace stream::identity {

struct HttpTarget {
  std::string host;
  std::string port = "80";
  std::string base_path;  // sin la barra final
};

// "http://identity-api:8081" -> {identity-api, 8081, ""}. nullopt si no es http://.
std::optional<HttpTarget> parse_http_url(const std::string& url);

// POST {base}/api/v1/internal/rooms/{id}/disable con X-Internal-Token (ADR 0019).
// 2xx o 409 (ya deshabilitada) cuentan como éxito; reintenta con espera creciente.
class HttpIdentityClient : public service::IdentityClient {
 public:
  using Sleep = std::function<void(std::chrono::milliseconds)>;
  HttpIdentityClient(HttpTarget target, std::string internal_secret, int attempts = 3,
                     std::chrono::milliseconds timeout = std::chrono::seconds(3), Sleep sleep = nullptr);
  bool disable_room(const std::string& room_id, const std::string& reason) override;

 private:
  int post_once(const std::string& path, const std::string& body);
  HttpTarget target_;
  std::string secret_;
  int attempts_;
  std::chrono::milliseconds timeout_;
  Sleep sleep_;
};

}  // namespace stream::identity
