// ADR 0019: ROOM_CLOSED en room:{id}:sync cierra con 4010 todas las conexiones de la sala.
//
// PRUEBAS EN ROJO. Lo que se espera de la implementación:
//   - src/redis/sync_message.hpp:
//       struct RevokedMessage { std::string room_id; std::string jti; };
//       struct RoomClosedMessage { std::string room_id; std::string reason; };
//       using SyncMessage = std::variant<RevokedMessage, RoomClosedMessage>;
//       std::optional<SyncMessage> parse_sync_message(std::string_view channel, std::string_view payload);
//     (RevokedListener entrega ambos mensajes; parse_revoked_message puede quedar como envoltorio).
//   - hub::Hub::close_room(room_id): cierra con 4010 a todos los peers de la sala y la olvida.
// Para que el resto de la suite compile mientras tanto, las pruebas detectan si existen y, si
// no, fallan en tiempo de ejecución con un mensaje claro. Al implementar, quitar la detección
// (`__has_include` y `try_close_room`) y llamar directamente.

#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "hub/hub.hpp"
#include "support/fake_peer.hpp"

#if __has_include("redis/sync_message.hpp")
#include "redis/sync_message.hpp"
#define VOICE_HAS_SYNC_MESSAGE 1
#else
#define VOICE_HAS_SYNC_MESSAGE 0
#endif

using namespace voice::hub;
using nlohmann::json;
using voice::auth::Claims;
using voice::testing::FakePeer;

namespace {

constexpr std::uint16_t kRoomDisabled = 4010;  // close_code::kRoomClosed (aún no existe)

// true si Hub::close_room existe (y la llamó).
template <typename H>
bool try_close_room(H& hub, const std::string& room_id) {
  if constexpr (requires { hub.close_room(room_id); }) {
    hub.close_room(room_id);
    return true;
  } else {
    return false;
  }
}

Claims claims(std::string sub, std::string role = "participant", std::string room = "room-1") {
  return {sub, room, role, "Nick " + sub, "jti-" + sub, 0};
}

class RoomClosedHubTest : public ::testing::Test {
 protected:
  RoomClosedHubTest() {
    HubOptions o;
    o.now_ms = [] { return 5000; };
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
  std::unique_ptr<Hub> hub_;
};

}  // namespace

// HU-LIVE-09 AC1: voz cierra con 4010 a todos (también al host) al terminar el evento.
TEST_F(RoomClosedHubTest, ClosesEveryPeerOfTheRoomWith4010) {
  auto host = join("p-host", claims("host", "host"));
  auto ana = join("p-ana", claims("ana"));
  auto tab2 = join("p-ana-2", claims("ana"));
  auto other = join("p-otro", claims("otro", "participant", "room-2"), "room-2");

  ASSERT_TRUE(try_close_room(*hub_, "room-1")) << "falta hub::Hub::close_room(room_id)";

  for (auto& p : {host, ana, tab2}) {
    ASSERT_TRUE(p->closed().has_value()) << p->id();
    EXPECT_EQ(p->closed()->first, kRoomDisabled) << p->id();
  }
  EXPECT_TRUE(hub_->members("room-1").empty()) << "la sala se olvida";
  EXPECT_FALSE(other->closed().has_value()) << "otras salas no se tocan";
  EXPECT_EQ(hub_->members("room-2").size(), 1u);
}

TEST_F(RoomClosedHubTest, ClosingAnUnknownRoomIsANoOp) {
  auto other = join("p-otro", claims("otro"));
  ASSERT_TRUE(try_close_room(*hub_, "room-9")) << "falta hub::Hub::close_room(room_id)";
  EXPECT_FALSE(other->closed().has_value());
  EXPECT_TRUE(try_close_room(*hub_, "room-9")) << "idempotente";
}

// --- Parseo de room:{id}:sync ----------------------------------------------------------------

#if VOICE_HAS_SYNC_MESSAGE

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

#else

TEST(ParseSyncMessage, RecognizesRoomClosed) {
  FAIL() << "falta src/redis/sync_message.hpp con parse_sync_message (ROOM_CLOSED y REVOKED)";
}

#endif
