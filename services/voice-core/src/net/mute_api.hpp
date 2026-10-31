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

// REST de moderación (HU-VOZ-04): PUT silencia, DELETE levanta el silencio.
//   PUT|DELETE /api/v1/voice/rooms/{room_id}/mutes/{user_id}
//   Authorization: Bearer <sync-ticket de host o cohost de esa sala>
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

using MuteDecision = std::variant<Reject, MuteCommand>;

// (room_id, user_id) decodificados si la ruta es la de silencios.
std::optional<std::pair<std::string, std::string>> parse_mute_path(std::string_view target);

// 404 ruta · 405 método · 401 sin token, inválido, caducado o revocado · 403 otra sala o
// rol sin permiso · 503 revocación no disponible (falla cerrado).
MuteDecision decide_mute_request(const MuteRequest& request, const auth::TokenVerifier& verifier,
                                 RevocationChecker& revocation, std::int64_t now_s);

}  // namespace voice::net
