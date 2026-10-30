#include "redis/revocation.hpp"

#include <sys/socket.h>

#include <hiredis/hiredis.h>
#include <nlohmann/json.hpp>

#include "redis/connection.hpp"

namespace voice::redis {

// --- RedisRevocationChecker -----------------------------------------------------------

RedisRevocationChecker::RedisRevocationChecker(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : endpoint_(std::move(endpoint)), timeout_(timeout) {}

RedisRevocationChecker::~RedisRevocationChecker() {
  std::lock_guard lock(mu_);
  disconnect_locked();
}

bool RedisRevocationChecker::connect_locked() {
  ctx_ = open_context(endpoint_, timeout_, /*select_db=*/true);
  if (!ctx_) return false;
  set_command_timeout(ctx_, timeout_);
  return true;
}

void RedisRevocationChecker::disconnect_locked() {
  if (ctx_) redisFree(ctx_);
  ctx_ = nullptr;
}

std::optional<bool> RedisRevocationChecker::is_revoked(const std::string& jti) {
  const std::string key = "token:revoked:" + jti;
  std::lock_guard lock(mu_);
  // Dos intentos: la conexión guardada puede haber muerto (Redis reiniciado).
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (!ctx_ && !connect_locked()) return std::nullopt;
    auto* reply = static_cast<redisReply*>(redisCommand(ctx_, "EXISTS %b", key.data(), key.size()));
    if (!reply) {
      disconnect_locked();
      continue;
    }
    std::optional<bool> result;
    if (reply->type == REDIS_REPLY_INTEGER) result = reply->integer > 0;
    freeReplyObject(reply);
    return result;
  }
  return std::nullopt;
}

// --- REVOKED ---------------------------------------------------------------------------

std::optional<std::pair<std::string, std::string>> parse_revoked_message(std::string_view channel,
                                                                         std::string_view payload) {
  constexpr std::string_view kPrefix = "room:";
  constexpr std::string_view kSuffix = ":sync";
  if (!channel.starts_with(kPrefix) || !channel.ends_with(kSuffix) ||
      channel.size() <= kPrefix.size() + kSuffix.size())
    return std::nullopt;
  const std::string room(channel.substr(kPrefix.size(), channel.size() - kPrefix.size() - kSuffix.size()));

  auto j = nlohmann::json::parse(payload, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::nullopt;
  auto type = j.find("type");
  auto jti = j.find("jti");
  if (type == j.end() || *type != "REVOKED" || jti == j.end() || !jti->is_string()) return std::nullopt;
  std::string jti_value = jti->get<std::string>();
  if (jti_value.empty()) return std::nullopt;
  return std::make_pair(room, std::move(jti_value));
}

// --- RevokedListener -------------------------------------------------------------------

RevokedListener::RevokedListener(RedisEndpoint endpoint, Callback callback)
    : endpoint_(std::move(endpoint)), callback_(std::move(callback)) {}

RevokedListener::~RevokedListener() { stop(); }

void RevokedListener::start() {
  stopping_ = false;
  thread_ = std::thread([this] { run(); });
}

void RevokedListener::stop() {
  stopping_ = true;
  {
    // Desbloquea la lectura en curso (redisGetReply no tiene tiempo límite).
    std::lock_guard lock(ctx_mu_);
    if (ctx_) ::shutdown(ctx_->fd, SHUT_RDWR);
  }
  {
    // Con el mutex tomado no se pierde el aviso si run() está por empezar a esperar.
    std::lock_guard lock(sleep_mu_);
  }
  sleep_cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

bool RevokedListener::subscribed() const { return subscribed_; }

void RevokedListener::run() {
  auto backoff = std::chrono::milliseconds(200);
  while (!stopping_) {
    redisContext* ctx = open_context(endpoint_, std::chrono::milliseconds(1000), /*select_db=*/false);
    if (ctx) {
      std::unique_lock lock(ctx_mu_);
      if (stopping_) {
        redisFree(ctx);
        break;
      }
      ctx_ = ctx;
      lock.unlock();

      auto* sub = static_cast<redisReply*>(redisCommand(ctx, "PSUBSCRIBE room:*:sync"));
      if (sub) {
        freeReplyObject(sub);
        subscribed_ = true;
        backoff = std::chrono::milliseconds(200);
        void* raw = nullptr;
        while (!stopping_ && redisGetReply(ctx, &raw) == REDIS_OK) {
          auto* reply = static_cast<redisReply*>(raw);
          if (reply->type == REDIS_REPLY_ARRAY && reply->elements == 4 &&
              std::string_view(reply->element[0]->str, reply->element[0]->len) == "pmessage") {
            auto revoked =
                parse_revoked_message(std::string_view(reply->element[2]->str, reply->element[2]->len),
                                      std::string_view(reply->element[3]->str, reply->element[3]->len));
            if (revoked) callback_(revoked->first, revoked->second);
          }
          freeReplyObject(reply);
        }
      }
      subscribed_ = false;
      lock.lock();
      ctx_ = nullptr;
      redisFree(ctx);
    }
    if (stopping_) break;
    std::unique_lock sleep_lock(sleep_mu_);
    sleep_cv_.wait_for(sleep_lock, backoff, [this] { return stopping_.load(); });
    backoff = std::min(backoff * 2, std::chrono::milliseconds(5000));
  }
}

}  // namespace voice::redis
