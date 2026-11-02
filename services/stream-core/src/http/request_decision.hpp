#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "auth/token_verifier.hpp"

namespace stream::http {

enum class Method { Get, Post, Patch, Delete, Options, Other };

// Petición HTTP ya leída por el servidor (sin red): la decisión es una función pura.
struct Request {
  Method method = Method::Get;
  std::string path;   // sin query
  std::string query;  // sin '?'
  std::string authorization;
  std::string content_type;
  std::string origin;
  std::string body;
};

// Error HTTP con cuerpo JSON {error: code, message}.
struct Problem {
  int status = 500;
  std::string code;
  std::string message;
};

enum class PublishMedia { Video, Audio };

struct WhipCommand {
  std::string room_id;
  auth::Claims claims;
  PublishMedia media = PublishMedia::Video;
  std::string sdp;
};
struct WhepCommand {
  std::string room_id;
  auth::Claims claims;
  std::string sdp;
};
struct IceServersCommand {
  std::string room_id;
  auth::Claims claims;
};
struct PatchCommand {
  std::string session_id;
  auth::Claims claims;
  std::string fragment;
};
struct DeleteCommand {
  std::string session_id;
  auth::Claims claims;
};
struct HealthCommand {};
struct PreflightCommand {
  std::string origin;
};

using Command = std::variant<WhipCommand, WhepCommand, IceServersCommand, PatchCommand, DeleteCommand,
                             HealthCommand, PreflightCommand>;
using Decision = std::variant<Problem, Command>;

// EXISTS token:revoked:{jti}. nullopt = no se pudo comprobar (falla cerrado).
class RevocationChecker {
 public:
  virtual ~RevocationChecker() = default;
  virtual std::optional<bool> is_revoked(const std::string& jti) = 0;
};

// room:{id}:stream:enabled y room:{id}:closed. nullopt = Redis no responde (falla cerrado).
struct RoomFlags {
  bool stream_enabled = false;
  bool closed = false;
};
class RoomStatus {
 public:
  virtual ~RoomStatus() = default;
  virtual std::optional<RoomFlags> flags(const std::string& room_id) = 0;
};

// Sesiones WHIP/WHEP vivas, para PATCH/DELETE y el cupo.
struct SessionInfo {
  std::string room_id;
  std::string owner_sub;
  std::string ice_ufrag;  // ufrag remoto vigente: otro distinto en un PATCH es un ICE restart
};
class SessionLookup {
 public:
  virtual ~SessionLookup() = default;
  virtual std::optional<SessionInfo> session(const std::string& session_id) = 0;
  virtual int viewer_count(const std::string& room_id) = 0;
};

struct DecisionContext {
  const auth::TokenVerifier& verifier;
  RevocationChecker& revocation;
  RoomStatus& rooms;
  SessionLookup& sessions;
  const std::vector<std::string>& allowed_origins;  // host[:puerto]
  int max_viewers = 50;
  std::int64_t now_s = 0;
};

inline constexpr std::size_t kMaxSdpBytes = 64 * 1024;

// Decide qué hacer con una petición (HU-LIVE-01, 04, 05, 06). Orden de comprobación:
// ruta -> Origin -> token -> revocación -> sala del token -> rol -> estado de la sala
// -> Content-Type -> SDP -> cupo.
Decision decide(const Request& request, DecisionContext& ctx);

bool origin_allowed(const std::string& origin, const std::vector<std::string>& allowed);

}  // namespace stream::http
