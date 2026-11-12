#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "net/handshake.hpp"
#include "redis/client.hpp"
#include "redis/redis_url.hpp"

namespace voice::redis {

// EXISTS token:revoked:{jti}. Falla cerrado: cualquier error devuelve nullopt.
class RedisRevocationChecker : public net::RevocationChecker {
 public:
  RedisRevocationChecker(RedisEndpoint endpoint, std::chrono::milliseconds timeout);

  std::optional<bool> is_revoked(const std::string& jti) override;

 private:
  BlockingClient client_;
};

// Mensaje de room:{id}:sync -> (room_id, jti) si es un REVOKED válido (envoltorio de
// parse_sync_message, ver redis/sync_message.hpp).
std::optional<std::pair<std::string, std::string>> parse_revoked_message(std::string_view channel,
                                                                         std::string_view payload);

}  // namespace voice::redis
