#include "redis/room_state_store.hpp"

#include <string_view>

#include <hiredis/hiredis.h>

namespace voice::redis {

std::string closed_key(const std::string& room_id) { return "room:" + room_id + ":closed"; }
std::string kind_key(const std::string& room_id) { return "room:" + room_id + ":kind"; }
std::string stage_key(const std::string& room_id) { return "room:" + room_id + ":voice:stage"; }

RedisRoomStateStore::RedisRoomStateStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : client_(std::move(endpoint), timeout) {}

std::optional<bool> RedisRoomStateStore::is_closed(const std::string& room_id) {
  auto reply = client_.command({"EXISTS", closed_key(room_id)});
  if (!reply || reply->type != REDIS_REPLY_INTEGER) return std::nullopt;
  return reply->integer > 0;
}

std::optional<bool> RedisRoomStateStore::is_live(const std::string& room_id) {
  auto reply = client_.command({"GET", kind_key(room_id)});
  if (!reply) return std::nullopt;
  // Sin clave es una sala watch (las anteriores a la migración no la tienen).
  if (reply->type == REDIS_REPLY_NIL) return false;
  if (reply->type != REDIS_REPLY_STRING) return std::nullopt;
  return std::string_view(reply->str, reply->len) == "live";
}

std::optional<bool> RedisRoomStateStore::is_on_stage(const std::string& room_id, const std::string& user_id) {
  auto reply = client_.command({"SISMEMBER", stage_key(room_id), user_id});
  if (!reply || reply->type != REDIS_REPLY_INTEGER) return std::nullopt;
  return reply->integer > 0;
}

bool RedisRoomStateStore::set_on_stage(const std::string& room_id, const std::string& user_id,
                                       bool on_stage) {
  const std::string key = stage_key(room_id);
  if (!reply_ok(client_.command({on_stage ? "SADD" : "SREM", key, user_id}))) return false;
  if (!on_stage) return true;
  return reply_ok(client_.command({"EXPIRE", key, std::to_string(kStageTtl.count())}));
}

}  // namespace voice::redis
