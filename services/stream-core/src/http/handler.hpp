#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include "auth/token_verifier.hpp"
#include "http/request_decision.hpp"
#include "ice/ice_servers.hpp"
#include "service/stream_service.hpp"

namespace stream::http {

struct Response {
  int status = 200;
  std::vector<std::pair<std::string, std::string>> headers;
  std::string body;

  std::string header(std::string_view name) const;
  std::vector<std::string> all(std::string_view name) const;
};

// Cabeceras Link rel="ice-server" (RFC 9725 §4.6) a partir de la lista RTCIceServer.
std::vector<std::string> ice_link_headers(const nlohmann::json& ice_servers);

struct HandlerDeps {
  const auth::TokenVerifier& verifier;
  RevocationChecker& revocation;
  RoomStatus& rooms;
  service::StreamService& service;
  ice::IceConfig ice;
  std::vector<std::string> allowed_origins;
  int max_viewers = 50;
  std::function<std::int64_t()> now_s;
};

// Convierte una petición en respuesta: decide() + ejecución en el servicio. Sin sockets.
//  - Rutas públicas: /api/v1/stream/* y /healthz (las publica Caddy).
//  - Rutas internas: POST/DELETE /internal/events/start/{roomId} (solo red interna; Caddy no las enruta).
class Handler {
 public:
  explicit Handler(HandlerDeps deps) : deps_(std::move(deps)) {}
  Response handle(const Request& request);

 private:
  Response internal(const Request& request);
  void cors(const Request& request, Response& response) const;
  HandlerDeps deps_;
};

}  // namespace stream::http
