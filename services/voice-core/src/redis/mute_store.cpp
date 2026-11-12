#include "redis/mute_store.hpp"

#include <hiredis/hiredis.h>

namespace voice::redis {

std::string muted_key(const std::string& room_id) { return "room:" + room_id + ":voice:muted"; }

RedisMuteStore::RedisMuteStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : client_(std::move(endpoint), timeout) {}

std::optional<bool> RedisMuteStore::is_muted(const std::string& room_id, const std::string& user_id) {
  auto reply = client_.command({"SISMEMBER", muted_key(room_id), user_id});
  if (!reply || reply->type != REDIS_REPLY_INTEGER) return std::nullopt;
  return reply->integer > 0;
}

bool RedisMuteStore::set_muted(const std::string& room_id, const std::string& user_id, bool muted) {
  const std::string key = muted_key(room_id);
  if (!reply_ok(client_.command({muted ? "SADD" : "SREM", key, user_id}))) return false;
  if (!muted) return true;
  return reply_ok(client_.command({"EXPIRE", key, std::to_string(kMutedTtl.count())}));
}

}  // namespace voice::redis
