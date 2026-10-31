#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include "net/handshake.hpp"
#include "redis/redis_url.hpp"

struct redisContext;

namespace voice::redis {

// EXISTS token:revoked:{jti}. Falla cerrado: cualquier error devuelve nullopt.
class RedisRevocationChecker : public net::RevocationChecker {
 public:
  RedisRevocationChecker(RedisEndpoint endpoint, std::chrono::milliseconds timeout);
  ~RedisRevocationChecker() override;

  std::optional<bool> is_revoked(const std::string& jti) override;

 private:
  bool connect_locked();
  void disconnect_locked();

  RedisEndpoint endpoint_;
  std::chrono::milliseconds timeout_;
  std::mutex mu_;
  redisContext* ctx_ = nullptr;
};

// Mensaje de room:{id}:sync -> (room_id, jti) si es un REVOKED válido.
std::optional<std::pair<std::string, std::string>> parse_revoked_message(std::string_view channel,
                                                                         std::string_view payload);

// Escucha REVOKED en room:*:sync (solo lectura, mismo contrato que social-core) y
// reconecta con espera exponencial si Redis se cae.
class RevokedListener {
 public:
  using Callback = std::function<void(const std::string& room_id, const std::string& jti)>;

  RevokedListener(RedisEndpoint endpoint, Callback callback);
  ~RevokedListener();

  void start();
  void stop();
  // true cuando la suscripción está activa (para pruebas y /healthz).
  bool subscribed() const;

 private:
  void run();

  RedisEndpoint endpoint_;
  Callback callback_;
  std::atomic<bool> stopping_{false};
  std::atomic<bool> subscribed_{false};
  std::mutex ctx_mu_;
  redisContext* ctx_ = nullptr;
  std::mutex sleep_mu_;
  std::condition_variable sleep_cv_;
  std::thread thread_;
};

}  // namespace voice::redis
