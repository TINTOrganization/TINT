#include "redis/mute_store.hpp"

#include <chrono>
#include <cstdlib>

#include <gtest/gtest.h>
#include <hiredis/hiredis.h>

using namespace voice::redis;
using namespace std::chrono_literals;

TEST(MutedKey, FollowsTheRoomNamespace) { EXPECT_EQ(muted_key("abc"), "room:abc:voice:muted"); }

TEST(RedisMuteStore, FailsClosedWhenRedisIsUnreachable) {
  RedisMuteStore store({"127.0.0.1", 1, "", 0}, 200ms);
  EXPECT_EQ(store.is_muted("r", "u"), std::nullopt);
  EXPECT_FALSE(store.set_muted("r", "u", true));
  EXPECT_FALSE(store.set_muted("r", "u", false));
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

long long redis_integer(const RedisEndpoint& ep, const char* cmd, const std::string& key) {
  redisContext* c = redisConnect(ep.host.c_str(), ep.port);
  if (!c || c->err) return -100;
  auto* reply = static_cast<redisReply*>(redisCommand(c, "%s %b", cmd, key.data(), key.size()));
  long long value = reply && reply->type == REDIS_REPLY_INTEGER ? reply->integer : -100;
  if (reply) freeReplyObject(reply);
  redisFree(c);
  return value;
}

std::string unique_room() {
  return "room-mute-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

}  // namespace

TEST(RedisMuteStoreIntegration, MutesPersistWithTtl) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  RedisMuteStore store(*ep, 500ms);
  const auto room = unique_room();

  EXPECT_EQ(store.is_muted(room, "guest:ana"), false);
  ASSERT_TRUE(store.set_muted(room, "guest:ana", true));
  EXPECT_EQ(store.is_muted(room, "guest:ana"), true);
  EXPECT_EQ(store.is_muted(room, "guest:luis"), false);
  const auto ttl = redis_integer(*ep, "TTL", muted_key(room));
  EXPECT_GT(ttl, 0);
  EXPECT_LE(ttl, std::chrono::duration_cast<std::chrono::seconds>(kMutedTtl).count());

  ASSERT_TRUE(store.set_muted(room, "guest:ana", false));
  EXPECT_EQ(store.is_muted(room, "guest:ana"), false);
  ASSERT_TRUE(store.set_muted(room, "guest:ana", false)) << "levantar dos veces no es error";
  EXPECT_EQ(redis_integer(*ep, "EXISTS", muted_key(room)), 0);
}

TEST(RedisMuteStoreIntegration, ReconnectsAfterTheConnectionDies) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  RedisMuteStore store(*ep, 500ms);
  const auto room = unique_room();
  ASSERT_EQ(store.is_muted(room, "u"), false);
  // Mata las conexiones de los clientes (como un reinicio de Redis).
  redisContext* c = redisConnect(ep->host.c_str(), ep->port);
  ASSERT_TRUE(c && !c->err);
  freeReplyObject(redisCommand(c, "CLIENT KILL TYPE normal SKIPME yes"));
  redisFree(c);
  EXPECT_TRUE(store.set_muted(room, "u", true));
  EXPECT_EQ(store.is_muted(room, "u"), true);
  store.set_muted(room, "u", false);
}
