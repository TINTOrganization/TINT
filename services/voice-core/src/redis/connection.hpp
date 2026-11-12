#pragma once

#include <chrono>

#include "redis/redis_url.hpp"

struct redisContext;

namespace voice::redis {

// Conecta y autentica (y hace SELECT si select_db); nullptr si algo falla.
redisContext* open_context(const RedisEndpoint& ep, std::chrono::milliseconds timeout, bool select_db);

// Tiempo límite de cada comando en una conexión ya abierta.
void set_command_timeout(redisContext* ctx, std::chrono::milliseconds timeout);

}  // namespace voice::redis
