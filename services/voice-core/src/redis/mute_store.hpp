#pragma once

#include <chrono>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "moderation/mute_store.hpp"
#include "redis/redis_url.hpp"

struct redisContext;
struct redisReply;

namespace voice::redis {

// room:{id}:voice:muted: SET con los user_id silenciados por el host. El TTL se renueva
// en cada silencio para que una sala olvidada no deje la clave para siempre.
inline constexpr std::chrono::seconds kMutedTtl = std::chrono::hours(24);

std::string muted_key(const std::string& room_id);

class RedisMuteStore : public moderation::MuteStore {
 public:
  RedisMuteStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout);
  ~RedisMuteStore() override;

  std::optional<bool> is_muted(const std::string& room_id, const std::string& user_id) override;
  bool set_muted(const std::string& room_id, const std::string& user_id, bool muted) override;

 private:
  // Envía el comando (con un reintento si la conexión murió); nullptr si falló.
  redisReply* command_locked(const std::vector<std::string>& args);
  void disconnect_locked();

  RedisEndpoint endpoint_;
  std::chrono::milliseconds timeout_;
  std::mutex mu_;
  redisContext* ctx_ = nullptr;
};

}  // namespace voice::redis
