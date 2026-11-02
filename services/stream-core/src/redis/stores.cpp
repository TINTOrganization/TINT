#include "redis/stores.hpp"

#include <sys/socket.h>

#include <hiredis/hiredis.h>
#include <chrono>
#include <ctime>
#include <nlohmann/json.hpp>

#include "redis/connection.hpp"
#include "util/uuid.hpp"

namespace stream::redis {
namespace {

Reply to_reply(const redisReply* r) {
  Reply out;
  switch (r->type) {
    case REDIS_REPLY_INTEGER:
      out.type = Reply::Type::Integer;
      out.integer = r->integer;
      break;
    case REDIS_REPLY_STRING:
      out.type = Reply::Type::String;
      out.str.assign(r->str, r->len);
      break;
    case REDIS_REPLY_STATUS:
      out.type = Reply::Type::Status;
      out.str.assign(r->str, r->len);
      break;
    case REDIS_REPLY_ARRAY:
      out.type = Reply::Type::Array;
      out.integer = static_cast<long long>(r->elements);
      break;
    case REDIS_REPLY_ERROR:
      out.type = Reply::Type::Error;
      out.str.assign(r->str, r->len);
      break;
    default:
      out.type = Reply::Type::Nil;
  }
  return out;
}

std::string rfc3339_ms(std::int64_t ms) {
  const std::time_t secs = ms / 1000;
  std::tm tm{};
  gmtime_r(&secs, &tm);
  char buf[32];
  std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%S", &tm);
  char out[40];
  std::snprintf(out, sizeof out, "%s.%03dZ", buf, static_cast<int>(ms % 1000));
  return out;
}

std::int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

// --- RedisClient -------------------------------------------------------------------------

RedisClient::RedisClient(RedisEndpoint endpoint, std::chrono::milliseconds timeout)
    : endpoint_(std::move(endpoint)), timeout_(timeout) {}

RedisClient::~RedisClient() {
  std::lock_guard lock(mu_);
  if (ctx_) redisFree(ctx_);
}

std::optional<Reply> RedisClient::command(const std::vector<std::string>& args) {
  std::vector<const char*> argv;
  std::vector<std::size_t> lens;
  for (const auto& a : args) {
    argv.push_back(a.data());
    lens.push_back(a.size());
  }
  std::lock_guard lock(mu_);
  // Dos intentos: la conexión guardada puede haber muerto (Redis reiniciado).
  for (int attempt = 0; attempt < 2; ++attempt) {
    if (!ctx_) {
      ctx_ = open_context(endpoint_, timeout_, /*select_db=*/true);
      if (!ctx_) return std::nullopt;
      set_command_timeout(ctx_, timeout_);
    }
    auto* reply = static_cast<redisReply*>(
        redisCommandArgv(ctx_, static_cast<int>(argv.size()), argv.data(), lens.data()));
    if (!reply) {
      redisFree(ctx_);
      ctx_ = nullptr;
      continue;
    }
    Reply out = to_reply(reply);
    freeReplyObject(reply);
    if (out.type == Reply::Type::Error) return std::nullopt;
    return out;
  }
  return std::nullopt;
}

// --- Revocación y estado de la sala --------------------------------------------------------

std::optional<bool> RedisRevocationChecker::is_revoked(const std::string& jti) {
  auto r = client_.command({"EXISTS", "token:revoked:" + jti});
  if (!r || r->type != Reply::Type::Integer) return std::nullopt;
  return r->integer > 0;
}

std::optional<http::RoomFlags> RedisRoomStore::flags(const std::string& room_id) {
  auto r = client_.command({"EXISTS", "room:" + room_id + ":stream:enabled"});
  auto c = client_.command({"EXISTS", "room:" + room_id + ":closed"});
  if (!r || !c || r->type != Reply::Type::Integer || c->type != Reply::Type::Integer) return std::nullopt;
  return http::RoomFlags{r->integer > 0, c->integer > 0};
}

bool RedisRoomStore::enable(const std::string& room_id) {
  auto r = client_.command(
      {"SET", "room:" + room_id + ":stream:enabled", "1", "EX", std::to_string(ttl_.count())});
  return r && r->type == Reply::Type::Status;
}

bool RedisRoomStore::disable(const std::string& room_id) {
  return client_.command({"DEL", "room:" + room_id + ":stream:enabled"}).has_value();
}

bool RedisRoomStore::publish_started(const std::string& room_id, std::int64_t started_at_ms) {
  auto r = client_.command({"SET", "room:" + room_id + ":stream:started_at", std::to_string(started_at_ms),
                            "NX", "EX", std::to_string(ttl_.count())});
  if (!r || r->type != Reply::Type::Status) return false;  // Nil = ya existía
  client_.command({"PUBLISH", "room:" + room_id + ":stream", stream_started_payload(room_id, started_at_ms)});
  return true;
}

void RedisRoomStore::publish_ended(const std::string& room_id, const std::string& reason) {
  client_.command({"PUBLISH", "room:" + room_id + ":stream", stream_ended_payload(room_id, reason)});
}

std::string stream_started_payload(const std::string& room_id, std::int64_t started_at_ms) {
  return nlohmann::json{{"event_id", util::new_uuid()},
                        {"type", "STREAM_STARTED"},
                        {"room_id", room_id},
                        {"started_at", rfc3339_ms(started_at_ms)},
                        {"started_at_ms", started_at_ms},
                        {"occurred_at", rfc3339_ms(now_ms())}}
      .dump();
}

std::string stream_ended_payload(const std::string& room_id, const std::string& reason) {
  return nlohmann::json{{"event_id", util::new_uuid()},
                        {"type", "STREAM_ENDED"},
                        {"room_id", room_id},
                        {"reason", reason},
                        {"occurred_at", rfc3339_ms(now_ms())}}
      .dump();
}

// --- room:{id}:sync ------------------------------------------------------------------------

std::optional<SyncMessage> parse_sync_message(std::string_view channel, std::string_view payload) {
  constexpr std::string_view kPrefix = "room:";
  constexpr std::string_view kSuffix = ":sync";
  if (!channel.starts_with(kPrefix) || !channel.ends_with(kSuffix) ||
      channel.size() <= kPrefix.size() + kSuffix.size())
    return std::nullopt;
  SyncMessage m;
  m.room_id = std::string(channel.substr(kPrefix.size(), channel.size() - kPrefix.size() - kSuffix.size()));
  auto j = nlohmann::json::parse(payload, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::nullopt;
  auto type = j.find("type");
  if (type == j.end() || !type->is_string()) return std::nullopt;
  if (*type == "ROOM_CLOSED") {
    m.type = SyncMessage::Type::RoomClosed;
    auto reason = j.find("reason");
    if (reason != j.end() && reason->is_string())
      m.reason =
          sfu::parse_end_reason(reason->get_ref<const std::string&>()).value_or(sfu::EndReason::HostEnded);
    return m;
  }
  if (*type == "REVOKED") {
    auto jti = j.find("jti");
    if (jti == j.end() || !jti->is_string() || jti->get_ref<const std::string&>().empty())
      return std::nullopt;
    m.type = SyncMessage::Type::Revoked;
    m.jti = jti->get<std::string>();
    return m;
  }
  return std::nullopt;
}

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
    std::lock_guard lock(sleep_mu_);
  }
  sleep_cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

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
            auto m = parse_sync_message(std::string_view(reply->element[2]->str, reply->element[2]->len),
                                        std::string_view(reply->element[3]->str, reply->element[3]->len));
            if (m) callback_(*m);
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

}  // namespace stream::redis
