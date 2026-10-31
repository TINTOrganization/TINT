#include "redis/revocation.hpp"

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <thread>

#include <gtest/gtest.h>
#include <hiredis/hiredis.h>

using namespace voice::redis;
using namespace std::chrono_literals;

TEST(ParseRevokedMessage, ExtractsRoomAndJti) {
  auto r = parse_revoked_message("room:abc-123:sync", R"({"type":"REVOKED","jti":"j1","event_id":"e"})");
  ASSERT_TRUE(r.has_value());
  EXPECT_EQ(r->first, "abc-123");
  EXPECT_EQ(r->second, "j1");
}

TEST(ParseRevokedMessage, IgnoresEverythingElse) {
  EXPECT_FALSE(parse_revoked_message("room:a:sync", R"({"type":"PLAY","jti":"j"})"));
  EXPECT_FALSE(parse_revoked_message("room:a:sync", R"({"type":"REVOKED"})"));
  EXPECT_FALSE(parse_revoked_message("room:a:sync", R"({"type":"REVOKED","jti":""})"));
  EXPECT_FALSE(parse_revoked_message("room:a:sync", R"({"type":"REVOKED","jti":5})"));
  EXPECT_FALSE(parse_revoked_message("room:a:sync", "no json"));
  EXPECT_FALSE(parse_revoked_message("room:a:sync", "[]"));
  EXPECT_FALSE(parse_revoked_message("room:a:social", R"({"type":"REVOKED","jti":"j"})"));
  EXPECT_FALSE(parse_revoked_message("room::sync", R"({"type":"REVOKED","jti":"j"})"));
  EXPECT_FALSE(parse_revoked_message("other", R"({"type":"REVOKED","jti":"j"})"));
}

TEST(RedisRevocationChecker, FailsClosedWhenRedisIsUnreachable) {
  RedisRevocationChecker checker({"127.0.0.1", 1, "", 0}, 200ms);
  EXPECT_EQ(checker.is_revoked("j"), std::nullopt);
  EXPECT_EQ(checker.is_revoked("j"), std::nullopt) << "reintenta conectar y vuelve a fallar cerrado";
}

// --- Integración con Redis real (VOICE_TEST_REDIS_URL) ---------------------------------

namespace {

std::optional<RedisEndpoint> test_redis() {
  const char* url = std::getenv("VOICE_TEST_REDIS_URL");
  if (!url || !*url) return std::nullopt;
  auto ep = parse_redis_url(url);
  if (!ep) return std::nullopt;
  return *ep;
}

void redis_command(const RedisEndpoint& ep, const std::string& cmd, const std::string& a,
                   const std::string& b = "") {
  redisContext* c = redisConnect(ep.host.c_str(), ep.port);
  ASSERT_TRUE(c && !c->err);
  redisReply* reply =
      b.empty() ? static_cast<redisReply*>(redisCommand(c, "%s %s", cmd.c_str(), a.c_str()))
                : static_cast<redisReply*>(redisCommand(c, "%s %s %s", cmd.c_str(), a.c_str(), b.c_str()));
  ASSERT_NE(reply, nullptr);
  freeReplyObject(reply);
  redisFree(c);
}

std::string unique(const std::string& prefix) {
  return prefix + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

}  // namespace

TEST(RedisIntegration, ChecksRevocationKey) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  std::string jti = unique("jti-");
  RedisRevocationChecker checker(*ep, 500ms);
  EXPECT_EQ(checker.is_revoked(jti), false);
  redis_command(*ep, "SET", "token:revoked:" + jti, "1");
  EXPECT_EQ(checker.is_revoked(jti), true);
  redis_command(*ep, "DEL", "token:revoked:" + jti);
}

TEST(RedisIntegration, ListenerReceivesRevokedAndStops) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  std::mutex mu;
  std::condition_variable cv;
  std::vector<std::pair<std::string, std::string>> got;
  RevokedListener listener(*ep, [&](const std::string& room, const std::string& jti) {
    std::lock_guard lock(mu);
    got.emplace_back(room, jti);
    cv.notify_all();
  });
  listener.start();
  for (int i = 0; i < 100 && !listener.subscribed(); ++i) std::this_thread::sleep_for(20ms);
  ASSERT_TRUE(listener.subscribed());

  std::string room = unique("room-");
  redis_command(*ep, "PUBLISH", "room:" + room + ":sync", R"({"type":"PLAY"})");
  redis_command(*ep, "PUBLISH", "room:" + room + ":sync", R"({"type":"REVOKED","jti":"j-live"})");

  std::unique_lock lock(mu);
  ASSERT_TRUE(cv.wait_for(lock, 3s, [&] { return !got.empty(); }));
  EXPECT_EQ(got[0], std::make_pair(room, std::string("j-live")));
  lock.unlock();

  auto t0 = std::chrono::steady_clock::now();
  listener.stop();
  EXPECT_LT(std::chrono::steady_clock::now() - t0, 2s) << "stop no debe quedarse bloqueado en la lectura";
  EXPECT_FALSE(listener.subscribed());
}

TEST(RedisIntegration, ListenerRetriesWhileRedisIsDown) {
  RevokedListener listener({"127.0.0.1", 1, "", 0}, [](const std::string&, const std::string&) {});
  listener.start();
  std::this_thread::sleep_for(100ms);
  EXPECT_FALSE(listener.subscribed());
  auto t0 = std::chrono::steady_clock::now();
  listener.stop();
  EXPECT_LT(std::chrono::steady_clock::now() - t0, 2s);
}
