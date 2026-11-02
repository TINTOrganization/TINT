#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "http/request_decision.hpp"
#include "redis/redis_url.hpp"
#include "service/stream_service.hpp"

struct redisContext;

namespace stream::redis {

struct Reply {
  enum class Type { Nil, Integer, String, Status, Array, Error } type = Type::Nil;
  long long integer = 0;
  std::string str;
};

// Una conexión con reconexión y tiempo límite por comando. Thread-safe (un mutex por cliente).
// nullopt = Redis no respondió: quien llama falla cerrado.
class RedisClient {
 public:
  RedisClient(RedisEndpoint endpoint, std::chrono::milliseconds timeout);
  ~RedisClient();
  RedisClient(const RedisClient&) = delete;
  RedisClient& operator=(const RedisClient&) = delete;

  std::optional<Reply> command(const std::vector<std::string>& args);

 private:
  RedisEndpoint endpoint_;
  std::chrono::milliseconds timeout_;
  std::mutex mu_;
  redisContext* ctx_ = nullptr;
};

// EXISTS token:revoked:{jti} (falla cerrado).
class RedisRevocationChecker : public http::RevocationChecker {
 public:
  explicit RedisRevocationChecker(RedisClient& client) : client_(client) {}
  std::optional<bool> is_revoked(const std::string& jti) override;

 private:
  RedisClient& client_;
};

// room:{id}:stream:enabled, room:{id}:closed, room:{id}:stream:started_at y el canal room:{id}:stream.
class RedisRoomStore : public service::RoomStore {
 public:
  explicit RedisRoomStore(RedisClient& client, std::chrono::seconds ttl = std::chrono::hours(24))
      : client_(client), ttl_(ttl) {}
  std::optional<http::RoomFlags> flags(const std::string& room_id) override;
  bool enable(const std::string& room_id) override;
  bool disable(const std::string& room_id) override;
  bool publish_started(const std::string& room_id, std::int64_t started_at_ms) override;
  void publish_ended(const std::string& room_id, const std::string& reason) override;

 private:
  RedisClient& client_;
  std::chrono::seconds ttl_;
};

// Mensajes de room:{id}:sync que le importan a stream-core (contratos de ADR 0007 y 0018).
struct SyncMessage {
  enum class Type { Revoked, RoomClosed } type = Type::Revoked;
  std::string room_id;
  std::string jti;
  // ROOM_CLOSED: host_ended | grace_expired; si falta o es desconocido, host_ended (§6.1).
  sfu::EndReason reason = sfu::EndReason::HostEnded;
};
std::optional<SyncMessage> parse_sync_message(std::string_view channel, std::string_view payload);

// JSON publicado en room:{id}:stream (contrato con social-core: trivia por minuto del stream).
std::string stream_started_payload(const std::string& room_id, std::int64_t started_at_ms);
std::string stream_ended_payload(const std::string& room_id, const std::string& reason);

// PSUBSCRIBE room:*:sync con reconexión exponencial (generaliza el RevokedListener de voice-core).
class SyncListener {
 public:
  using Callback = std::function<void(const SyncMessage&)>;
  SyncListener(RedisEndpoint endpoint, Callback callback);
  ~SyncListener();
  void start();
  void stop();
  bool subscribed() const { return subscribed_.load(); }

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

}  // namespace stream::redis
