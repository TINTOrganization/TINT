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

namespace {

// {prefix}{room_id}/{segment}/{user_id}, sin barras extra y sin partes vacías.
std::optional<std::pair<std::string, std::string>> parse_room_user_path(std::string_view target,
                                                                        std::string_view segment) {
  std::string_view path = target_path(target);
  if (!path.starts_with(kMutesApiPrefix)) return std::nullopt;
  path.remove_prefix(kMutesApiPrefix.size());
  const std::string middle = "/" + std::string(segment) + "/";
  const auto pos = path.find(middle);
  if (pos == std::string_view::npos || pos == 0) return std::nullopt;
  std::string_view user = path.substr(pos + middle.size());
  if (user.empty() || user.find('/') != std::string_view::npos) return std::nullopt;
  std::string_view room = path.substr(0, pos);
  if (room.find('/') != std::string_view::npos) return std::nullopt;
  return std::make_pair(url_decode(room), url_decode(user));
}

}  // namespace

std::optional<std::pair<std::string, std::string>> parse_mute_path(std::string_view target) {
  return parse_room_user_path(target, "mutes");
}

std::optional<std::pair<std::string, std::string>> parse_stage_path(std::string_view target) {
  return parse_room_user_path(target, "stage");
}

std::string_view rest_error_code(unsigned status) {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    default:
      return "UNAVAILABLE";
  }
}

MuteDecision decide_mute_request(const MuteRequest& request, const auth::TokenVerifier& verifier,
                                 RevocationChecker& revocation, std::int64_t now_s) {
  auto mute_path = parse_mute_path(request.target);
  auto stage_path = mute_path ? std::nullopt : parse_stage_path(request.target);
  if (!mute_path && !stage_path) return Reject{404, "not found"};
  auto& path = mute_path ? *mute_path : *stage_path;
  const bool put = request.method == "PUT";
  if (!put && request.method != "DELETE") return Reject{405, "method not allowed"};

  auto token = bearer_token(request.authorization);
  if (!token) return Reject{401, "bearer token required"};
  // Aquí un token caducado es un 401 más: no hay WebSocket al que mandar 4003.
  auto claims = verifier.verify(*token, now_s);
  if (!claims) return Reject{401, "invalid token"};
  if (claims->room_id != path.first) return Reject{403, "token is for another room"};
  if (!moderation::can_moderate(claims->role)) return Reject{403, "only the host can moderate"};

  auto revoked = revocation.is_revoked(claims->jti);
  if (!revoked) return Reject{503, "revocation store unavailable"};
  if (*revoked) return Reject{401, "token revoked"};
  if (stage_path) return StageCommand{std::move(path.first), std::move(path.second), put};
  return MuteCommand{std::move(path.first), std::move(path.second), put};
}

}  // namespace voice::net
