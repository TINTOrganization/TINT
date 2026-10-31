#include "redis/connection.hpp"

#include <sys/time.h>

#include <hiredis/hiredis.h>

namespace voice::redis {
namespace {

timeval to_timeval(std::chrono::milliseconds ms) {
  return {static_cast<time_t>(ms.count() / 1000), static_cast<suseconds_t>((ms.count() % 1000) * 1000)};
}

}  // namespace

redisContext* open_context(const RedisEndpoint& ep, std::chrono::milliseconds timeout, bool select_db) {
  const timeval tv = to_timeval(timeout);
  redisContext* ctx = redisConnectWithTimeout(ep.host.c_str(), ep.port, tv);
  if (!ctx || ctx->err) {
    if (ctx) redisFree(ctx);
    return nullptr;
  }
  auto ok = [&](redisReply* reply) {
    const bool good = reply && reply->type != REDIS_REPLY_ERROR;
    if (reply) freeReplyObject(reply);
    return good;
  };
  if (!ep.password.empty() &&
      !ok(static_cast<redisReply*>(redisCommand(ctx, "AUTH %b", ep.password.data(), ep.password.size())))) {
    redisFree(ctx);
    return nullptr;
  }
  if (select_db && ep.db != 0 && !ok(static_cast<redisReply*>(redisCommand(ctx, "SELECT %d", ep.db)))) {
    redisFree(ctx);
    return nullptr;
  }
  return ctx;
}

void set_command_timeout(redisContext* ctx, std::chrono::milliseconds timeout) {
  const timeval tv = to_timeval(timeout);
  redisSetTimeout(ctx, tv);
}

}  // namespace voice::redis
