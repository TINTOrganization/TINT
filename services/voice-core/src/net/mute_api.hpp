#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include "auth/token_verifier.hpp"
#include "net/handshake.hpp"

namespace voice::net {

// REST de moderación, con Authorization: Bearer <sync-ticket de host o cohost de esa sala>:
//   PUT|DELETE /api/v1/voice/rooms/{room_id}/mutes/{user_id}  silencio del host (HU-VOZ-04)
//   PUT|DELETE /api/v1/voice/rooms/{room_id}/stage/{user_id}  escenario de las salas live (ADR 0019)
inline constexpr std::string_view kMutesApiPrefix = "/api/v1/voice/rooms/";

struct MuteRequest {
  std::string_view method;  // "PUT", "DELETE", …
  std::string_view target;
  std::optional<std::string_view> authorization;
};

struct MuteCommand {
  std::string room_id;
  std::string user_id;
  bool muted = false;
};

struct StageCommand {
  std::string room_id;
  std::string user_id;
  bool on_stage = false;
};

using MuteDecision = std::variant<Reject, MuteCommand, StageCommand>;

// (room_id, user_id) decodificados si la ruta es la de silencios / la del escenario.
std::optional<std::pair<std::string, std::string>> parse_mute_path(std::string_view target);
std::optional<std::pair<std::string, std::string>> parse_stage_path(std::string_view target);

// Código UPPER_SNAKE del cuerpo de error de las rutas nuevas (dominio-transmision §6.1):
// 401 UNAUTHORIZED · 403 FORBIDDEN · 404 NOT_FOUND · 405 METHOD_NOT_ALLOWED · 503 UNAVAILABLE.
std::string_view rest_error_code(unsigned status);

// Silencios y escenario. 404 ruta · 405 método · 401 sin token, inválido, caducado o revocado · 403 otra sala
// o rol sin permiso · 503 revocación no disponible (falla cerrado).
MuteDecision decide_mute_request(const MuteRequest& request, const auth::TokenVerifier& verifier,
                                 RevocationChecker& revocation, std::int64_t now_s);

}  // namespace voice::net
