// ADR 0019: ROOM_CLOSED en room:{id}:sync cierra con 4010 todas las conexiones de la sala, y
// retirar a alguien del escenario de una sala live lo cierra con 4009.

#include <atomic>
#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "hub/hub.hpp"
#include "support/fake_peer.hpp"

#include "redis/sync_message.hpp"

using namespace voice::hub;
using nlohmann::json;
using voice::auth::Claims;
using voice::testing::FakePeer;

namespace {

static_assert(close_code::kRoomClosed == 4010 && close_code::kNotOnStage == 4009, "dominio-transmision §6.1");

Claims claims(std::string sub, std::string role = "participant", std::string room = "room-1") {
  return {sub, room, role, "Nick " + sub, "jti-" + sub, 0};
}

class RoomClosedHubTest : public ::testing::Test {
 protected:
  RoomClosedHubTest() {
    HubOptions o;
    o.now_ms = [this] { return now_.load(); };
    o.new_event_id = [this] { return "evt-" + std::to_string(++ids_); };
    hub_ = std::make_unique<Hub>(o);
  }

  std::shared_ptr<FakePeer> join(const std::string& peer_id, const Claims& c,
                                 const std::string& room = "room-1") {
    auto peer = std::make_shared<FakePeer>(peer_id);
    hub_->join(room, c, peer);
    return peer;
  }

  int ids_ = 0;
  std::atomic<std::int64_t> now_{5000};
  std::unique_ptr<Hub> hub_;
};

}  // namespace

// HU-LIVE-09 AC1: voz cierra con 4010 a todos (también al host) al terminar el evento.
TEST_F(RoomClosedHubTest, ClosesEveryPeerOfTheRoomWith4010) {
  auto host = join("p-host", claims("host", "host"));
  auto ana = join("p-ana", claims("ana"));
  auto tab2 = join("p-ana-2", claims("ana"));
  auto other = join("p-otro", claims("otro", "participant", "room-2"), "room-2");

  hub_->close_room("room-1");

  for (auto& p : {host, ana, tab2}) {
    ASSERT_TRUE(p->closed().has_value()) << p->id();
    EXPECT_EQ(p->closed()->first, close_code::kRoomClosed) << p->id();
  }
  EXPECT_TRUE(hub_->members("room-1").empty()) << "la sala se olvida";
  EXPECT_FALSE(other->closed().has_value()) << "otras salas no se tocan";
  EXPECT_EQ(hub_->members("room-2").size(), 1u);
}

TEST_F(RoomClosedHubTest, ClosingAnUnknownRoomIsANoOp) {
  auto other = join("p-otro", claims("otro"));
  hub_->close_room("room-9");
  EXPECT_FALSE(other->closed().has_value());
  hub_->close_room("room-1");
  hub_->close_room("room-1");  // un ROOM_CLOSED repetido no hace nada nuevo (§6.1)
  EXPECT_EQ(other->closed()->first, close_code::kRoomClosed);
  EXPECT_TRUE(hub_->members("room-1").empty());
}

TEST_F(RoomClosedHubTest, AfterClosingTheRoomLateDisconnectsAreNoOps) {
  auto ana = join("p-ana", claims("ana"));
  hub_->close_room("room-1");
  hub_->leave("room-1", "p-ana");
  hub_->handle_message("room-1", "p-ana", R"({"type":"leave","event_id":"e","occurred_at":1})");
  EXPECT_TRUE(hub_->members("room-1").empty());
}

// Carrera: el handshake leyó room:{id}:closed justo antes de que identity-api lo escribiera y
// el join llega después del ROOM_CLOSED. Igual se cierra con 4010.
TEST_F(RoomClosedHubTest, JoinRightAfterTheCloseIsClosedWith4010) {
  hub_->close_room("room-1");
  auto late = join("p-late", claims("late"));
  ASSERT_TRUE(late->closed().has_value());
  EXPECT_EQ(late->closed()->first, close_code::kRoomClosed);
  EXPECT_TRUE(late->of_type("voice_state").empty());
  EXPECT_TRUE(hub_->members("room-1").empty());
}

TEST_F(RoomClosedHubTest, TheClosedRoomMemoryExpires) {
  hub_->close_room("room-1");
  now_ += kClosedRoomMemoryMs;
  hub_->close_room("room-2");  // poda los cierres viejos
  auto ana = join("p-ana", claims("ana"));
  EXPECT_FALSE(ana->closed().has_value()) << "pasado el margen decide la clave de Redis en el handshake";
  auto luis = join("p-luis", claims("luis", "participant", "room-2"), "room-2");
  EXPECT_EQ(luis->closed()->first, close_code::kRoomClosed);
}

// --- Escenario: DELETE /stage/{user_id} --------------------------------------------------------

TEST_F(RoomClosedHubTest, RemoveFromStageClosesEveryConnectionOfThatUserWith4009) {
  auto host = join("p-host", claims("host", "host"));
  auto ana = join("p-ana", claims("ana"));
  auto tab2 = join("p-ana-2", claims("ana"));
  auto luis = join("p-luis", claims("luis"));
  host->clear();

  hub_->remove_from_stage("room-1", "ana");

  for (auto& p : {ana, tab2}) {
    ASSERT_TRUE(p->closed().has_value()) << p->id();
    EXPECT_EQ(p->closed()->first, close_code::kNotOnStage);
  }
  EXPECT_FALSE(luis->closed().has_value());
  EXPECT_FALSE(host->closed().has_value());
  EXPECT_EQ(host->of_type("peer_left").size(), 2u) << "los demás cierran esas RTCPeerConnection";
  EXPECT_EQ(hub_->members("room-1").size(), 2u);
}

TEST_F(RoomClosedHubTest, RemoveFromStageNeverKicksHostOrCohost) {
  auto host = join("p-host", claims("host", "host"));
  auto co = join("p-co", claims("co", "cohost"));
  hub_->remove_from_stage("room-1", "host");
  hub_->remove_from_stage("room-1", "co");
  hub_->remove_from_stage("room-9", "ana");
  EXPECT_FALSE(host->closed().has_value());
  EXPECT_FALSE(co->closed().has_value());
}

TEST_F(RoomClosedHubTest, RemovingTheLastMemberForgetsTheRoom) {
  auto ana = join("p-ana", claims("ana"));
  auto tab2 = join("p-ana-2", claims("ana"));
  hub_->remove_from_stage("room-1", "ana");
  EXPECT_TRUE(hub_->members("room-1").empty());
  EXPECT_EQ(tab2->closed()->first, close_code::kNotOnStage);
}

// --- Parseo de room:{id}:sync ----------------------------------------------------------------

using voice::redis::parse_sync_message;
using voice::redis::RevokedMessage;
using voice::redis::RoomClosedMessage;

// Formato de dominio-transmision §6.1 (fuente de verdad).
constexpr const char* kRoomClosed =
    R"({"type":"ROOM_CLOSED","event_id":"8f4e2c1a-0b7d-4e7a-9c3f-2d1b6a5e4f30","room_id":"abc-123",)"
    R"("reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"})";

TEST(ParseSyncMessage, RecognizesRoomClosed) {
  auto m = parse_sync_message("room:abc-123:sync", kRoomClosed);
  ASSERT_TRUE(m.has_value());
  auto* closed = std::get_if<RoomClosedMessage>(&*m);
  ASSERT_NE(closed, nullptr);
  EXPECT_EQ(closed->room_id, "abc-123");
  EXPECT_EQ(closed->reason, "host_ended");
}

TEST(ParseSyncMessage, RecognizesGraceExpired) {
  auto m = parse_sync_message(
      "room:r:sync",
      R"({"type":"ROOM_CLOSED","event_id":"e1","room_id":"r","reason":"grace_expired","occurred_at":"2026-11-01T18:00:00.000Z"})");
  ASSERT_TRUE(m.has_value());
  EXPECT_EQ(std::get<RoomClosedMessage>(*m).reason, "grace_expired");
}

// §6.1: un mensaje del bus que no cumple el formato se descarta.
TEST(ParseSyncMessage, DiscardsRoomClosedOutsideTheStandardFormat) {
  const std::string base = "room:r:sync";
  for (
      const char* payload : {
          R"({"type":"ROOM_CLOSED","room_id":"r"})",
          R"({"type":"ROOM_CLOSED","room_id":"r","reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"})",
          R"({"type":"ROOM_CLOSED","event_id":"","room_id":"r","reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"})",
          R"({"type":"ROOM_CLOSED","event_id":"e","room_id":"r","occurred_at":"2026-11-01T18:00:00.000Z"})",
          R"({"type":"ROOM_CLOSED","event_id":"e","room_id":"r","reason":"host_closed","occurred_at":"2026-11-01T18:00:00.000Z"})",
          R"({"type":"ROOM_CLOSED","event_id":"e","room_id":"r","reason":"host_ended"})",
          R"({"type":"ROOM_CLOSED","event_id":"e","room_id":"r","reason":"host_ended","occurred_at":1})",
      })
    EXPECT_FALSE(parse_sync_message(base, payload)) << payload;
}

TEST(ParseSyncMessage, StillRecognizesRevoked) {
  auto m = parse_sync_message("room:abc:sync", R"({"type":"REVOKED","jti":"j1"})");
  ASSERT_TRUE(m.has_value());
  auto* revoked = std::get_if<RevokedMessage>(&*m);
  ASSERT_NE(revoked, nullptr);
  EXPECT_EQ(revoked->room_id, "abc");
  EXPECT_EQ(revoked->jti, "j1");
}

TEST(ParseSyncMessage, IgnoresEverythingElse) {
  EXPECT_FALSE(parse_sync_message("room:a:sync", R"({"type":"PLAY"})"));
  EXPECT_FALSE(parse_sync_message("room:a:sync", kRoomClosed)) << "room_id del mensaje distinto del canal";
  EXPECT_FALSE(parse_sync_message(
      "room:a:sync",
      R"({"type":"ROOM_CLOSED","event_id":"e","room_id":5,"reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"})"));
  EXPECT_FALSE(parse_sync_message("room:abc-123:social", kRoomClosed));
  EXPECT_FALSE(parse_sync_message(
      "room::sync",
      R"({"type":"ROOM_CLOSED","event_id":"e","room_id":"","reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"})"));
  EXPECT_FALSE(parse_sync_message("room:a:sync", "no json"));
  EXPECT_FALSE(parse_sync_message("room:a:sync", R"({"type":"REVOKED","jti":""})"));
}
