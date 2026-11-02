#include "http/request_decision.hpp"

#include <algorithm>
#include <cctype>

#include "sdp/offer_inspect.hpp"

namespace stream::http {
namespace {

constexpr std::string_view kRoomsPrefix = "/api/v1/stream/rooms/";
constexpr std::string_view kSessionsPrefix = "/api/v1/stream/sessions/";

enum class Route { Unknown, Health, Whip, Whep, IceServers, Session };

struct Target {
  Route route = Route::Unknown;
  std::string id;  // room_id o session_id
};

bool valid_id(std::string_view id) {
  return !id.empty() && id.size() <= 128 && std::ranges::all_of(id, [](unsigned char c) {
    return std::isalnum(c) || c == '-' || c == '_' || c == ':';
  });
}

Target parse_target(std::string_view path) {
  if (path == "/healthz" || path == "/api/v1/stream/healthz") return {Route::Health, {}};
  if (path.starts_with(kSessionsPrefix)) {
    auto id = path.substr(kSessionsPrefix.size());
    if (valid_id(id)) return {Route::Session, std::string(id)};
    return {};
  }
  if (!path.starts_with(kRoomsPrefix)) return {};
  auto rest = path.substr(kRoomsPrefix.size());
  auto slash = rest.find('/');
  if (slash == std::string_view::npos) return {};
  auto id = rest.substr(0, slash);
  auto action = rest.substr(slash + 1);
  if (!valid_id(id)) return {};
  if (action == "whip") return {Route::Whip, std::string(id)};
  if (action == "whep") return {Route::Whep, std::string(id)};
  if (action == "ice-servers") return {Route::IceServers, std::string(id)};
  return {};
}

Method expected_method(Route route) {
  switch (route) {
    case Route::Health:
    case Route::IceServers:
      return Method::Get;
    case Route::Whip:
    case Route::Whep:
      return Method::Post;
    default:
      return Method::Other;  // Session: PATCH o DELETE
  }
}

std::string query_param(std::string_view query, std::string_view key) {
  while (!query.empty()) {
    auto amp = query.find('&');
    auto pair = query.substr(0, amp);
    auto eq = pair.find('=');
    if (eq != std::string_view::npos && pair.substr(0, eq) == key) return std::string(pair.substr(eq + 1));
    if (amp == std::string_view::npos) break;
    query.remove_prefix(amp + 1);
  }
  return {};
}

// "Application/SDP; charset=utf-8" -> "application/sdp"
std::string media_type(std::string_view content_type) {
  auto semi = content_type.find(';');
  auto type = content_type.substr(0, semi);
  while (!type.empty() && type.back() == ' ') type.remove_suffix(1);
  std::string out(type);
  std::ranges::transform(out, out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

Problem bad_sdp(std::string message) { return {400, "INVALID_SDP", std::move(message)}; }

bool sends(sdp::Direction d) { return d == sdp::Direction::SendOnly || d == sdp::Direction::SendRecv; }

// Oferta WHIP de vídeo: una sola pista VP8 con simulcast por rid + DataChannel (ADR 0018).
std::optional<Problem> check_whip_video(const sdp::Offer& offer) {
  const auto* video = offer.first("video");
  if (!video || offer.count("video") != 1 || offer.count("audio") != 0)
    return bad_sdp("La oferta de vídeo debe tener exactamente una sección m=video y ninguna de audio.");
  if (!video->payload_type_of("vp8")) return bad_sdp("El vídeo debe ofrecer el códec VP8.");
  if (!sends(video->direction)) return bad_sdp("La sección de vídeo debe ser sendonly.");
  if (video->send_rids.empty() || video->send_rids.size() > 3 ||
      !video->extmaps.contains(std::string(sdp::kRidExtension)))
    return bad_sdp(
        "El vídeo debe publicarse con simulcast (1 a 3 a=rid ... send y la extensión rtp-stream-id).");
  if (offer.count("application") != 1)
    return Problem{400, "DATACHANNEL_REQUIRED", "La oferta debe incluir un DataChannel (m=application)."};
  return std::nullopt;
}

std::optional<Problem> check_whip_audio(const sdp::Offer& offer) {
  const auto* audio = offer.first("audio");
  if (!audio || offer.count("audio") != 1 || offer.count("video") != 0)
    return bad_sdp("La oferta de audio debe tener exactamente una sección m=audio y ninguna de vídeo.");
  if (!audio->payload_type_of("opus")) return bad_sdp("El audio debe ofrecer el códec Opus.");
  if (!sends(audio->direction)) return bad_sdp("La sección de audio debe ser sendonly.");
  return std::nullopt;
}

std::optional<Problem> check_whep(const sdp::Offer& offer) {
  const auto* video = offer.first("video");
  if (!video || offer.count("video") != 1 || offer.count("audio") > 1)
    return bad_sdp("La oferta debe tener una sección m=video y como mucho una m=audio.");
  if (!video->payload_type_of("vp8")) return bad_sdp("El vídeo debe aceptar el códec VP8.");
  for (const auto& m : offer.media) {
    if (m.kind == "application") continue;
    if (m.direction != sdp::Direction::RecvOnly)
      return bad_sdp("Las secciones de medios deben ser recvonly.");
    if (m.kind == "audio" && !m.payload_type_of("opus"))
      return bad_sdp("El audio debe aceptar el códec Opus.");
  }
  if (offer.count("application") != 1)
    return Problem{400, "DATACHANNEL_REQUIRED", "La oferta debe incluir un DataChannel (m=application)."};
  return std::nullopt;
}

std::string fragment_ufrag(std::string_view fragment) {
  constexpr std::string_view kKey = "a=ice-ufrag:";
  auto pos = fragment.find(kKey);
  if (pos == std::string_view::npos) return {};
  auto value = fragment.substr(pos + kKey.size());
  auto end = value.find_first_of("\r\n");
  return std::string(value.substr(0, end));
}

}  // namespace

bool origin_allowed(const std::string& origin, const std::vector<std::string>& allowed) {
  if (origin.empty()) return true;  // sin Origin no es un navegador
  auto scheme = origin.find("://");
  if (scheme == std::string::npos) return false;
  const std::string host = origin.substr(scheme + 3);
  return std::ranges::find(allowed, host) != allowed.end();
}

Decision decide(const Request& r, DecisionContext& ctx) {
  const Target target = parse_target(r.path);
  if (target.route == Route::Unknown) return Problem{404, "NOT_FOUND", "Ruta desconocida."};

  if (r.method == Method::Options) {
    if (r.origin.empty() || !origin_allowed(r.origin, ctx.allowed_origins))
      return Problem{403, "FORBIDDEN", "Origen no permitido."};
    return PreflightCommand{r.origin};
  }

  const Method expected = expected_method(target.route);
  const bool method_ok = target.route == Route::Session
                             ? (r.method == Method::Patch || r.method == Method::Delete)
                             : r.method == expected;
  if (!method_ok) return Problem{405, "METHOD_NOT_ALLOWED", "Método no permitido en esta ruta."};
  if (target.route == Route::Health) return HealthCommand{};

  if (!origin_allowed(r.origin, ctx.allowed_origins))
    return Problem{403, "FORBIDDEN", "Origen no permitido."};

  // --- Autenticación (falla cerrado) ---
  constexpr std::string_view kBearer = "Bearer ";
  if (!r.authorization.starts_with(kBearer) || r.authorization.size() == kBearer.size())
    return Problem{401, "UNAUTHORIZED", "Falta el token (Authorization: Bearer)."};
  auto claims = ctx.verifier.verify(std::string_view(r.authorization).substr(kBearer.size()), ctx.now_s);
  if (!claims) {
    if (claims.error() == auth::TokenError::Expired)
      return Problem{401, "TOKEN_EXPIRED", "El token caducó; pide uno nuevo."};
    return Problem{401, "UNAUTHORIZED", "Token inválido."};
  }
  auto revoked = ctx.revocation.is_revoked(claims->jti);
  if (!revoked) return Problem{503, "UNAVAILABLE", "No se pudo comprobar el token; reintenta."};
  if (*revoked) return Problem{401, "TOKEN_REVOKED", "El token fue revocado."};

  // --- Sesiones (PATCH / DELETE) ---
  if (target.route == Route::Session) {
    auto session = ctx.sessions.session(target.id);
    if (!session) return Problem{404, "SESSION_NOT_FOUND", "La sesión no existe o ya terminó."};
    if (session->room_id != claims->room_id || session->owner_sub != claims->sub)
      return Problem{403, "FORBIDDEN", "La sesión pertenece a otro usuario."};
    if (r.method == Method::Delete) return DeleteCommand{target.id, *claims};
    if (media_type(r.content_type) != "application/trickle-ice-sdpfrag")
      return Problem{415, "UNSUPPORTED_MEDIA_TYPE", "Se esperaba application/trickle-ice-sdpfrag."};
    auto ufrag = fragment_ufrag(r.body);
    if (!ufrag.empty() && ufrag != session->ice_ufrag)
      return Problem{405, "ICE_RESTART_UNSUPPORTED", "ICE restart no soportado: haz un POST nuevo."};
    return PatchCommand{target.id, *claims, r.body};
  }

  // --- Rutas de sala ---
  if (claims->room_id != target.id) return Problem{403, "FORBIDDEN", "El token es de otra sala."};
  if (target.route == Route::Whip && !claims->is_host())
    return Problem{403, "FORBIDDEN_ROLE", "Solo el host puede transmitir en esta sala."};

  auto flags = ctx.rooms.flags(target.id);
  if (!flags) return Problem{503, "UNAVAILABLE", "No se pudo comprobar el estado de la sala; reintenta."};
  if (flags->closed) return Problem{410, "ROOM_DISABLED", "El evento terminó y la sala fue deshabilitada."};
  if (!flags->stream_enabled)
    return Problem{404, "STREAM_NOT_FOUND", "Esta sala no tiene transmisión en vivo."};

  if (target.route == Route::IceServers) return IceServersCommand{target.id, *claims};

  PublishMedia media = PublishMedia::Video;
  if (target.route == Route::Whip) {
    const std::string kind = query_param(r.query, "kind");
    if (kind == "audio")
      media = PublishMedia::Audio;
    else if (!kind.empty() && kind != "video")
      return Problem{400, "INVALID_REQUEST", "kind debe ser video o audio."};
  }

  if (media_type(r.content_type) != "application/sdp")
    return Problem{415, "UNSUPPORTED_MEDIA_TYPE", "Se esperaba Content-Type: application/sdp."};
  if (r.body.empty() || r.body.size() > kMaxSdpBytes)
    return bad_sdp("La oferta SDP está vacía o supera los 64 KiB.");
  auto offer = sdp::parse_offer(r.body);
  if (!offer) return bad_sdp("La oferta SDP no se pudo leer.");

  if (target.route == Route::Whip) {
    auto problem = media == PublishMedia::Video ? check_whip_video(*offer) : check_whip_audio(*offer);
    if (problem) return *problem;
    return WhipCommand{target.id, *claims, media, r.body};
  }

  if (auto problem = check_whep(*offer)) return *problem;
  if (ctx.sessions.viewer_count(target.id) >= ctx.max_viewers)
    return Problem{409, "ROOM_FULL", "La sala está llena; intenta más tarde."};
  return WhepCommand{target.id, *claims, r.body};
}

}  // namespace stream::http
