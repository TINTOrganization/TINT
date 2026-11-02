#include "redis/revocation.hpp"

#include <hiredis/hiredis.h>

#include "redis/sync_message.hpp"

namespace voice::redis {

// --- RedisRevocationChecker -----------------------------------------------------------

RedisRevocationChecker::RedisRevocationChecker(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : client_(std::move(endpoint), timeout) {}

std::optional<bool> RedisRevocationChecker::is_revoked(const std::string& jti) {
  auto reply = client_.command({"EXISTS", "token:revoked:" + jti});
  if (!reply || reply->type != REDIS_REPLY_INTEGER) return std::nullopt;
  return reply->integer > 0;
}

// --- REVOKED ---------------------------------------------------------------------------

std::optional<std::pair<std::string, std::string>> parse_revoked_message(std::string_view channel,
                                                                         std::string_view payload) {
  auto message = parse_sync_message(channel, payload);
  auto* revoked = message ? std::get_if<RevokedMessage>(&*message) : nullptr;
  if (!revoked) return std::nullopt;
  return std::make_pair(std::move(revoked->room_id), std::move(revoked->jti));
}

}  // namespace voice::redis
