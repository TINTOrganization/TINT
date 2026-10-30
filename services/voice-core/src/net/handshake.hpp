#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "auth/token_verifier.hpp"
#include "moderation/mute_store.hpp"

namespace voice::net {

// Fuente de revocaciones (token:revoked:{jti}). nullopt = no se pudo consultar.
class RevocationChecker {
 public:
  virtual ~RevocationChecker() = default;
  virtual std::optional<bool> is_revoked(const std::string& jti) = 0;
};

struct HandshakeRequest {
  std::string_view target;  // "/ws/voice?room_id=…&token=…"
  std::optional<std::string_view> origin;
};

// Rechazo HTTP antes del upgrade (no se filtra información del token).
struct Reject {
  unsigned status;
  std::string reason;
};

// Estado terminal con token bien firmado: upgrade y cierre 4xxx (ADR 0014),
// así el navegador ve el código y no reintenta para siempre.
struct AcceptThenClose {
  std::uint16_t code;
  std::string reason;
};

struct Accept {
  std::string room_id;
  auth::Claims claims;
  bool host_muted = false;  // el host lo silenció antes de entrar
};

using HandshakeDecision = std::variant<Reject, AcceptThenClose, Accept>;

inline constexpr std::string_view kVoicePath = "/ws/voice";

HandshakeDecision decide_handshake(const HandshakeRequest& request, const auth::TokenVerifier& verifier,
                                   RevocationChecker& revocation, moderation::MuteStore& mutes,
                                   const std::vector<std::string>& allowed_origins, std::int64_t now_s);

// Origin "http://localhost:5173" contra entradas "localhost:5173".
bool origin_allowed(std::string_view origin, const std::vector<std::string>& allowed);

// Decodifica %XX y '+'.
std::string url_decode(std::string_view in);

// Separa ruta y query string (decodifica %XX y '+').
std::string_view target_path(std::string_view target);
std::map<std::string, std::string> parse_query(std::string_view target);

}  // namespace voice::net
