// Adaptadores de Redis. Las de integración se saltan sin STREAM_TEST_REDIS_URL (en CI hay un Redis).
#include "redis/stores.hpp"

#include <gtest/gtest.h>

#include <cstdlib>
#include <nlohmann/json.hpp>
#include <regex>
#include <thread>

#include "util/uuid.hpp"

using namespace stream;
using namespace stream::redis;
using nlohmann::json;
using namespace std::chrono_literals;

// --- Puro ----------------------------------------------------------------------------------

TEST(SyncMessages, ParsesRoomClosed) {
  auto m =
      parse_sync_message("room:abc:sync", R"({"type":"ROOM_CLOSED","room_id":"abc","reason":"host_ended"})");
  ASSERT_TRUE(m);
  EXPECT_EQ(m->type, SyncMessage::Type::RoomClosed);
  EXPECT_EQ(m->room_id, "abc");
  EXPECT_EQ(m->reason, sfu::EndReason::HostEnded);
}

TEST(SyncMessages, RoomClosedCarriesGraceExpiredReason) {
  auto m = parse_sync_message("room:abc:sync", R"({"type":"ROOM_CLOSED","reason":"grace_expired"})");
  ASSERT_TRUE(m);
  EXPECT_EQ(m->reason, sfu::EndReason::GraceExpired);
}

TEST(SyncMessages, RoomClosedWithoutOrUnknownReasonIsHostEnded) {
  for (auto payload : {R"({"type":"ROOM_CLOSED"})", R"({"type":"ROOM_CLOSED","reason":"room_closed"})",
                       R"({"type":"ROOM_CLOSED","reason":42})"}) {
    auto m = parse_sync_message("room:abc:sync", payload);
    ASSERT_TRUE(m) << payload;
    EXPECT_EQ(m->reason, sfu::EndReason::HostEnded) << payload;
  }
}

TEST(SyncMessages, ParsesRevoked) {
  auto m = parse_sync_message("room:abc:sync", R"({"type":"REVOKED","jti":"j1"})");
  ASSERT_TRUE(m);
  EXPECT_EQ(m->type, SyncMessage::Type::Revoked);
  EXPECT_EQ(m->jti, "j1");
}

TEST(SyncMessages, IgnoresOtherTypesAndGarbage) {
  EXPECT_FALSE(parse_sync_message("room:abc:sync", R"({"type":"PLAY"})"));
  EXPECT_FALSE(parse_sync_message("room:abc:sync", R"({"type":"REVOKED"})")) << "REVOKED sin jti";
  EXPECT_FALSE(parse_sync_message("room:abc:sync", "nope"));
  EXPECT_FALSE(parse_sync_message("room::sync", R"({"type":"ROOM_CLOSED"})"));
  EXPECT_FALSE(parse_sync_message("room:abc:social", R"({"type":"ROOM_CLOSED"})"));
}

TEST(StreamChannelPayloads, StartedAndEndedShape) {
  auto started = json::parse(stream_started_payload("r1", 1'700'000'000'123));
  EXPECT_EQ(started["type"], "STREAM_STARTED");
  EXPECT_EQ(started["room_id"], "r1");
  EXPECT_EQ(started["started_at_ms"], 1'700'000'000'123);
  EXPECT_EQ(started["started_at"], "2023-11-14T22:13:20.123Z") << "RFC 3339 en UTC con milisegundos";
  const std::regex uuid_v4("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  const std::regex rfc3339_ms(R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$)");
  EXPECT_TRUE(std::regex_match(started["event_id"].get<std::string>(), uuid_v4));
  ASSERT_TRUE(started.contains("occurred_at")) << "§6.1: todo mensaje del bus lleva occurred_at";
  EXPECT_TRUE(std::regex_match(started["occurred_at"].get<std::string>(), rfc3339_ms));
  auto ended = json::parse(stream_ended_payload("r1", "grace_expired"));
  EXPECT_EQ(ended["type"], "STREAM_ENDED");
  EXPECT_EQ(ended["room_id"], "r1");
  EXPECT_EQ(ended["reason"], "grace_expired");
  EXPECT_TRUE(std::regex_match(ended["event_id"].get<std::string>(), uuid_v4));
  EXPECT_TRUE(std::regex_match(ended["occurred_at"].get<std::string>(), rfc3339_ms));
}

TEST(RedisClient, UnreachableRedisFailsClosed) {
  RedisClient client(*parse_redis_url("redis://127.0.0.1:1"), 200ms);
  EXPECT_FALSE(client.command({"PING"}));
  RedisRevocationChecker revocation(client);
  EXPECT_FALSE(revocation.is_revoked("x"));
  RedisRoomStore store(client);
  EXPECT_FALSE(store.flags("room"));
  EXPECT_FALSE(store.enable("room"));
}

// --- Integración con Redis real -------------------------------------------------------------

namespace {
class RedisIntegration : public ::testing::Test {
 protected:
  void SetUp() override {
    const char* url = std::getenv("STREAM_TEST_REDIS_URL");
    if (!url || !*url) GTEST_SKIP() << "sin STREAM_TEST_REDIS_URL";
    auto parsed = parse_redis_url(url);
    ASSERT_TRUE(parsed) << "STREAM_TEST_REDIS_URL inválida: " << url;
    endpoint = *parsed;
    client = std::make_unique<RedisClient>(endpoint, 1000ms);
    room = "it-" + util::new_uuid();
  }
  RedisEndpoint endpoint;
  std::unique_ptr<RedisClient> client;
  std::string room;
};
}  // namespace

TEST_F(RedisIntegration, RevocationKey) {
  RedisRevocationChecker revocation(*client);
  const std::string jti = util::new_uuid();
  EXPECT_EQ(revocation.is_revoked(jti), false);
  client->command({"SET", "token:revoked:" + jti, "1", "EX", "60"});
  EXPECT_EQ(revocation.is_revoked(jti), true);
}

TEST_F(RedisIntegration, RoomFlagsEnableDisableAndClosedMarker) {
  RedisRoomStore store(*client);
  EXPECT_EQ(store.flags(room)->stream_enabled, false);
  EXPECT_TRUE(store.enable(room));
  EXPECT_EQ(store.flags(room)->stream_enabled, true);
  client->command({"SET", "room:" + room + ":closed", "1", "EX", "60"});
  EXPECT_TRUE(store.flags(room)->closed);
  EXPECT_TRUE(store.disable(room));
  EXPECT_EQ(store.flags(room)->stream_enabled, false);
}

TEST_F(RedisIntegration, StartedAtSetOnce) {
  RedisRoomStore store(*client);
  EXPECT_TRUE(store.publish_started(room, 1000));
  EXPECT_FALSE(store.publish_started(room, 2000)) << "una reconexión no reinicia el reloj";
  auto v = client->command({"GET", "room:" + room + ":stream:started_at"});
  ASSERT_TRUE(v);
  EXPECT_EQ(v->str, "1000");
}

TEST_F(RedisIntegration, EndedClearsStartedAt) {
  // Sin started_at, un social-core que arranque después del fin no rearma las trivias por minuto.
  RedisRoomStore store(*client);
  ASSERT_TRUE(store.publish_started(room, 1000));
  store.publish_ended(room, "host_ended");
  auto exists = client->command({"EXISTS", "room:" + room + ":stream:started_at"});
  ASSERT_TRUE(exists);
  EXPECT_EQ(exists->integer, 0);
}

TEST_F(RedisIntegration, ListenerReceivesRoomClosed) {
  std::atomic<int> closed{0};
  SyncListener listener(endpoint, [&](const SyncMessage& m) {
    if (m.type == SyncMessage::Type::RoomClosed && m.room_id == room) ++closed;
  });
  listener.start();
  for (int i = 0; i < 50 && !listener.subscribed(); ++i) std::this_thread::sleep_for(20ms);
  ASSERT_TRUE(listener.subscribed());
  client->command(
      {"PUBLISH", "room:" + room + ":sync", R"({"type":"ROOM_CLOSED","room_id":")" + room + "\"}"});
  for (int i = 0; i < 50 && closed == 0; ++i) std::this_thread::sleep_for(20ms);
  EXPECT_EQ(closed.load(), 1);
  listener.stop();
}
