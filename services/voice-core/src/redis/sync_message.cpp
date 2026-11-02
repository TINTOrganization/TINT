#include "redis/sync_message.hpp"

#include <sys/socket.h>

#include <hiredis/hiredis.h>
#include <nlohmann/json.hpp>

#include "redis/connection.hpp"

namespace voice::redis {
namespace {

bool non_empty_string(const nlohmann::json& j, const char* key) {
  auto it = j.find(key);
  return it != j.end() && it->is_string() && !it->get_ref<const std::string&>().empty();
}

}  // namespace

std::optional<SyncMessage> parse_sync_message(std::string_view channel, std::string_view payload) {
  constexpr std::string_view kPrefix = "room:";
  constexpr std::string_view kSuffix = ":sync";
  if (!channel.starts_with(kPrefix) || !channel.ends_with(kSuffix) ||
      channel.size() <= kPrefix.size() + kSuffix.size())
    return std::nullopt;
  std::string room(channel.substr(kPrefix.size(), channel.size() - kPrefix.size() - kSuffix.size()));

  auto j = nlohmann::json::parse(payload, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::nullopt;
  auto type = j.find("type");
  if (type == j.end() || !type->is_string()) return std::nullopt;

  if (*type == "REVOKED") {
    if (!non_empty_string(j, "jti")) return std::nullopt;
    return RevokedMessage{std::move(room), j["jti"].get<std::string>()};
  }
  if (*type == "ROOM_CLOSED") {
    if (!non_empty_string(j, "event_id") || !non_empty_string(j, "occurred_at") ||
        !non_empty_string(j, "room_id") || j["room_id"] != room)
      return std::nullopt;
    const auto& reason = j["reason"];
    if (!reason.is_string() || (reason != "host_ended" && reason != "grace_expired")) return std::nullopt;
    return RoomClosedMessage{std::move(room), reason.get<std::string>()};
  }
  return std::nullopt;
}

// --- SyncListener ----------------------------------------------------------------------

SyncListener::SyncListener(RedisEndpoint endpoint, Callback callback)
    : endpoint_(std::move(endpoint)), callback_(std::move(callback)) {}

SyncListener::~SyncListener() { stop(); }

void SyncListener::start() {
  stopping_ = false;
  thread_ = std::thread([this] { run(); });
}

void SyncListener::stop() {
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

bool SyncListener::subscribed() const { return subscribed_; }

void SyncListener::run() {
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
            auto message =
                parse_sync_message(std::string_view(reply->element[2]->str, reply->element[2]->len),
                                   std::string_view(reply->element[3]->str, reply->element[3]->len));
            if (message) callback_(*message);
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
