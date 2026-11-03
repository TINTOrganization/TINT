#pragma once

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "redis/redis_url.hpp"

struct redisContext;
struct redisReply;

namespace voice::redis {

struct ReplyDeleter {
  void operator()(redisReply* reply) const;
};
using Reply = std::unique_ptr<redisReply, ReplyDeleter>;

// true si hay respuesta y no es un error de Redis.
bool reply_ok(const Reply& reply);

// Conexión síncrona compartida (con mutex) para los stores que consultan Redis en el pool
// bloqueante. Conecta bajo demanda y reintenta una vez si la conexión guardada murió.
class BlockingClient {
 public:
  BlockingClient(RedisEndpoint endpoint, std::chrono::milliseconds timeout);
  ~BlockingClient();
  BlockingClient(const BlockingClient&) = delete;
  BlockingClient& operator=(const BlockingClient&) = delete;

  // nullptr si Redis no respondió (falla cerrado en quien llama).
  Reply command(const std::vector<std::string>& args);

 private:
  void disconnect_locked();

  RedisEndpoint endpoint_;
  std::chrono::milliseconds timeout_;
  std::mutex mu_;
  redisContext* ctx_ = nullptr;
};

}  // namespace voice::redis
