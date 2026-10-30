#include "net/mute_api.hpp"

#include "moderation/mute_store.hpp"

namespace voice::net {
namespace {

// "Bearer <token>" (el esquema no distingue mayúsculas).
std::optional<std::string_view> bearer_token(std::optional<std::string_view> authorization) {
  constexpr std::string_view kScheme = "bearer ";
  if (!authorization || authorization->size() <= kScheme.size()) return std::nullopt;
  for (std::size_t i = 0; i < kScheme.size(); ++i)
    if (std::tolower(static_cast<unsigned char>((*authorization)[i])) != kScheme[i]) return std::nullopt;
  return authorization->substr(kScheme.size());
}

}  // namespace

std::optional<std::pair<std::string, std::string>> parse_mute_path(std::string_view target) {
  std::string_view path = target_path(target);
  if (!path.starts_with(kMutesApiPrefix)) return std::nullopt;
  path.remove_prefix(kMutesApiPrefix.size());
  // {room_id}/mutes/{user_id}
  constexpr std::string_view kMiddle = "/mutes/";
  const auto middle = path.find(kMiddle);
  if (middle == std::string_view::npos || middle == 0) return std::nullopt;
  std::string_view user = path.substr(middle + kMiddle.size());
  if (user.empty() || user.find('/') != std::string_view::npos) return std::nullopt;
  std::string_view room = path.substr(0, middle);
  if (room.find('/') != std::string_view::npos) return std::nullopt;
  return std::make_pair(url_decode(room), url_decode(user));
}

MuteDecision decide_mute_request(const MuteRequest& request, const auth::TokenVerifier& verifier,
                                 RevocationChecker& revocation, std::int64_t now_s) {
  auto path = parse_mute_path(request.target);
  if (!path) return Reject{404, "not found"};
  const bool mute = request.method == "PUT";
  if (!mute && request.method != "DELETE") return Reject{405, "method not allowed"};

  auto token = bearer_token(request.authorization);
  if (!token) return Reject{401, "bearer token required"};
  // Aquí un token caducado es un 401 más: no hay WebSocket al que mandar 4003.
  auto claims = verifier.verify(*token, now_s);
  if (!claims) return Reject{401, "invalid token"};
  if (claims->room_id != path->first) return Reject{403, "token is for another room"};
  if (!moderation::can_moderate(claims->role)) return Reject{403, "only the host can mute"};

  auto revoked = revocation.is_revoked(claims->jti);
  if (!revoked) return Reject{503, "revocation store unavailable"};
  if (*revoked) return Reject{401, "token revoked"};
  return MuteCommand{std::move(path->first), std::move(path->second), mute};
}

}  // namespace voice::net
