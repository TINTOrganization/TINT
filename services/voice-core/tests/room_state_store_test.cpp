#include "redis/room_state_store.hpp"

#include <chrono>
#include <cstdlib>

#include <gtest/gtest.h>
#include <hiredis/hiredis.h>

using namespace voice::redis;
using namespace std::chrono_literals;

TEST(RoomStateKeys, FollowTheRoomNamespace) {
  EXPECT_EQ(closed_key("abc"), "room:abc:closed");
  EXPECT_EQ(kind_key("abc"), "room:abc:kind");
  EXPECT_EQ(stage_key("abc"), "room:abc:voice:stage");
}

TEST(RedisRoomStateStore, FailsClosedWhenRedisIsUnreachable) {
  RedisRoomStateStore store({"127.0.0.1", 1, "", 0}, 200ms);
  EXPECT_EQ(store.is_closed("r"), std::nullopt);
  EXPECT_EQ(store.is_live("r"), std::nullopt);
  EXPECT_EQ(store.is_on_stage("r", "u"), std::nullopt);
  EXPECT_FALSE(store.set_on_stage("r", "u", true));
  EXPECT_FALSE(store.set_on_stage("r", "u", false));
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

// Comando de preparación (lo que escribe identity-api); devuelve el entero de la respuesta.
long long redis_run(const RedisEndpoint& ep, std::vector<std::string> args) {
  redisContext* c = redisConnect(ep.host.c_str(), ep.port);
  if (!c || c->err) return -100;
  std::vector<const char*> argv;
  std::vector<std::size_t> lens;
  for (auto& a : args) {
    argv.push_back(a.data());
    lens.push_back(a.size());
  }
  auto* reply =
      static_cast<redisReply*>(redisCommandArgv(c, static_cast<int>(argv.size()), argv.data(), lens.data()));
  long long value = reply && reply->type == REDIS_REPLY_INTEGER ? reply->integer : 0;
  if (reply) freeReplyObject(reply);
  redisFree(c);
  return value;
}

std::string unique_room() {
  return "room-state-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

}  // namespace

TEST(RedisRoomStateIntegration, ReadsClosedAndKind) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  RedisRoomStateStore store(*ep, 500ms);
  const auto room = unique_room();

  EXPECT_EQ(store.is_closed(room), false);
  EXPECT_EQ(store.is_live(room), false) << "sin room:{id}:kind es una sala watch";
  redis_run(*ep, {"SET", kind_key(room), "watch"});
  EXPECT_EQ(store.is_live(room), false);
  redis_run(*ep, {"SET", kind_key(room), "live"});
  EXPECT_EQ(store.is_live(room), true);
  redis_run(*ep, {"SET", closed_key(room), "1"});
  EXPECT_EQ(store.is_closed(room), true);

  // Un tipo de dato inesperado no se interpreta: falla cerrado.
  redis_run(*ep, {"DEL", kind_key(room)});
  redis_run(*ep, {"SADD", kind_key(room), "live"});
  EXPECT_EQ(store.is_live(room), std::nullopt);
  redis_run(*ep, {"DEL", kind_key(room), closed_key(room)});
}

TEST(RedisRoomStateIntegration, StageSetWithTtl) {
  auto ep = test_redis();
  if (!ep) GTEST_SKIP() << "VOICE_TEST_REDIS_URL no definida";
  RedisRoomStateStore store(*ep, 500ms);
  const auto room = unique_room();

  EXPECT_EQ(store.is_on_stage(room, "guest:ana"), false);
  ASSERT_TRUE(store.set_on_stage(room, "guest:ana", true));
  EXPECT_EQ(store.is_on_stage(room, "guest:ana"), true);
  EXPECT_EQ(store.is_on_stage(room, "guest:luis"), false);
  const auto ttl = redis_run(*ep, {"TTL", stage_key(room)});
  EXPECT_GT(ttl, 0);
  EXPECT_LE(ttl, kStageTtl.count());

  ASSERT_TRUE(store.set_on_stage(room, "guest:ana", false));
  EXPECT_EQ(store.is_on_stage(room, "guest:ana"), false);
  ASSERT_TRUE(store.set_on_stage(room, "guest:ana", false)) << "retirar dos veces no es error";
  EXPECT_EQ(redis_run(*ep, {"EXISTS", stage_key(room)}), 0);
}
