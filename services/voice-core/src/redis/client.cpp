#include "redis/client.hpp"

#include <hiredis/hiredis.h>

#include "redis/connection.hpp"

namespace voice::redis {

void ReplyDeleter::operator()(redisReply* reply) const { freeReplyObject(reply); }

bool reply_ok(const Reply& reply) { return reply && reply->type != REDIS_REPLY_ERROR; }

BlockingClient::BlockingClient(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : endpoint_(std::move(endpoint)), timeout_(timeout) {}

BlockingClient::~BlockingClient() {
  std::lock_guard lock(mu_);
  disconnect_locked();
}

Reply BlockingClient::command(const std::vector<std::string>& args) {
  std::vector<const char*> argv;
  std::vector<std::size_t> argvlen;
  for (const auto& a : args) {
    argv.push_back(a.data());
    argvlen.push_back(a.size());
  }
  std::lock_guard lock(mu_);
  // Dos intentos: la conexión guardada puede haber muerto (Redis reiniciado).
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (!ctx_) {
      ctx_ = open_context(endpoint_, timeout_, /*select_db=*/true);
      if (!ctx_) return nullptr;
      set_command_timeout(ctx_, timeout_);
    }
    auto* reply = static_cast<redisReply*>(
        redisCommandArgv(ctx_, static_cast<int>(argv.size()), argv.data(), argvlen.data()));
    if (reply) return Reply(reply);
    disconnect_locked();
  }
  return nullptr;
}

void BlockingClient::disconnect_locked() {
  if (ctx_) redisFree(ctx_);
  ctx_ = nullptr;
}

}  // namespace voice::redis
