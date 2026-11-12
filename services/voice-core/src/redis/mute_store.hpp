#pragma once

#include <chrono>
#include <optional>
#include <string>

#include "moderation/mute_store.hpp"
#include "redis/client.hpp"
#include "redis/redis_url.hpp"

namespace voice::redis {

// room:{id}:voice:muted: SET con los user_id silenciados por el host. El TTL se renueva
// en cada silencio para que una sala olvidada no deje la clave para siempre.
inline constexpr std::chrono::seconds kMutedTtl = std::chrono::hours(24);

std::string muted_key(const std::string& room_id);

class RedisMuteStore : public moderation::MuteStore {
 public:
  RedisMuteStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout);

  std::optional<bool> is_muted(const std::string& room_id, const std::string& user_id) override;
  bool set_muted(const std::string& room_id, const std::string& user_id, bool muted) override;

 private:
  BlockingClient client_;
};

}  // namespace voice::redis
