#include "redis/mute_store.hpp"

#include <hiredis/hiredis.h>

#include "redis/connection.hpp"

namespace voice::redis {
namespace {

bool reply_ok(redisReply* reply) { return reply && reply->type != REDIS_REPLY_ERROR; }

}  // namespace

std::string muted_key(const std::string& room_id) { return "room:" + room_id + ":voice:muted"; }

RedisMuteStore::RedisMuteStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : endpoint_(std::move(endpoint)), timeout_(timeout) {}

RedisMuteStore::~RedisMuteStore() {
  std::lock_guard lock(mu_);
  disconnect_locked();
}

std::optional<bool> RedisMuteStore::is_muted(const std::string& room_id, const std::string& user_id) {
  std::lock_guard lock(mu_);
  redisReply* reply = command_locked({"SISMEMBER", muted_key(room_id), user_id});
  std::optional<bool> result;
  if (reply && reply->type == REDIS_REPLY_INTEGER) result = reply->integer > 0;
  if (reply) freeReplyObject(reply);
  return result;
}

bool RedisMuteStore::set_muted(const std::string& room_id, const std::string& user_id, bool muted) {
  const std::string key = muted_key(room_id);
  std::lock_guard lock(mu_);
  redisReply* reply = command_locked({muted ? "SADD" : "SREM", key, user_id});
  bool ok = reply_ok(reply);
  if (reply) freeReplyObject(reply);
  if (!ok || !muted) return ok;
  const auto ttl = std::chrono::duration_cast<std::chrono::seconds>(kMutedTtl).count();
  reply = command_locked({"EXPIRE", key, std::to_string(ttl)});
  ok = reply_ok(reply);
  if (reply) freeReplyObject(reply);
  return ok;
}

redisReply* RedisMuteStore::command_locked(const std::vector<std::string>& args) {
  std::vector<const char*> argv;
  std::vector<std::size_t> argvlen;
  for (const auto& a : args) {
    argv.push_back(a.data());
    argvlen.push_back(a.size());
  }
  // Dos intentos: la conexión guardada puede haber muerto (Redis reiniciado).
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (!ctx_) {
      ctx_ = open_context(endpoint_, timeout_, /*select_db=*/true);
      if (!ctx_) return nullptr;
      set_command_timeout(ctx_, timeout_);
    }
    auto* reply = static_cast<redisReply*>(
        redisCommandArgv(ctx_, static_cast<int>(argv.size()), argv.data(), argvlen.data()));
    if (reply) return reply;
    disconnect_locked();
  }
  return nullptr;
}

void RedisMuteStore::disconnect_locked() {
  if (ctx_) redisFree(ctx_);
  ctx_ = nullptr;
}

}  // namespace voice::redis
