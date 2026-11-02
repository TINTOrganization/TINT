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
#include <variant>

#include "redis/redis_url.hpp"

struct redisContext;

namespace voice::redis {

// Mensajes de room:{id}:sync que le importan a voice-core (solo lectura).
struct RevokedMessage {
  std::string room_id;
  std::string jti;
};

// ADR 0019 / dominio-transmision §6.1. Lo publica solo identity-api.
struct RoomClosedMessage {
  std::string room_id;
  std::string reason;  // host_ended | grace_expired
};

using SyncMessage = std::variant<RevokedMessage, RoomClosedMessage>;

// nullopt si el mensaje no es para voice-core o no cumple el formato (se descarta):
//   {"type":"REVOKED","jti":"…"}
//   {"type":"ROOM_CLOSED","event_id","room_id" (= el del canal),"reason","occurred_at"}
std::optional<SyncMessage> parse_sync_message(std::string_view channel, std::string_view payload);

// Escucha room:*:sync (PSUBSCRIBE) y entrega REVOKED y ROOM_CLOSED. Reconecta con espera
// exponencial si Redis se cae.
class SyncListener {
 public:
  using Callback = std::function<void(const SyncMessage&)>;

  SyncListener(RedisEndpoint endpoint, Callback callback);
  ~SyncListener();

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
