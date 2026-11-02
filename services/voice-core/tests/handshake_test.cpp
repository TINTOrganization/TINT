#include "net/handshake.hpp"

#include <gtest/gtest.h>

#include "support/fake_mute_store.hpp"
#include "support/fake_revocation.hpp"
#include "support/fake_room_state.hpp"
#include "support/jwt.hpp"

using namespace voice::net;
using namespace voice::testing;

namespace {

class HandshakeTest : public ::testing::Test {
 protected:
  HandshakeDecision decide(const std::string& target,
                           std::optional<std::string_view> origin = "http://localhost:5173") {
    return decide_handshake({target, origin}, verifier, revocation, mutes, allowed, kNow);
  }
  std::string target(const std::string& token, const std::string& room = "room-1") {
    return "/ws/voice?room_id=" + room + "&token=" + token;
  }
  unsigned rejected_status(const HandshakeDecision& d) {
    auto* r = std::get_if<Reject>(&d);
    return r ? r->status : 0;
  }

  voice::auth::TokenVerifier verifier{kSecret, kIssuer, kAudience};
  FakeRevocation revocation;
  FakeMuteStore mutes;
  std::vector<std::string> allowed{"localhost:5173", "127.0.0.1:5173"};
};

}  // namespace

TEST_F(HandshakeTest, AcceptsValidGuest) {
  auto d = decide(target(sign_jwt(guest_claims())));
  auto* ok = std::get_if<Accept>(&d);
  ASSERT_NE(ok, nullptr);
  EXPECT_EQ(ok->room_id, "room-1");
  EXPECT_EQ(ok->claims.jti, "jti-ana");
  EXPECT_EQ(revocation.calls, 1);
}

TEST_F(HandshakeTest, AcceptsMissingOriginFromNonBrowserClients) {
  EXPECT_TRUE(
      std::holds_alternative<Accept>(decide(target(sign_jwt(guest_claims()), "room-1"), std::nullopt)));
}

TEST_F(HandshakeTest, RejectsOtherPaths) {
  EXPECT_EQ(rejected_status(decide("/ws/sync?room_id=room-1&token=x")), 404u);
}

TEST_F(HandshakeTest, RejectsForeignOrigins) {
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims())), "https://evil.example")), 403u);
}

TEST_F(HandshakeTest, RequiresTokenAndRoom) {
  EXPECT_EQ(rejected_status(decide("/ws/voice?room_id=room-1")), 400u);
  EXPECT_EQ(rejected_status(decide("/ws/voice?token=" + sign_jwt(guest_claims()))), 400u);
  EXPECT_EQ(rejected_status(decide("/ws/voice")), 400u);
}

TEST_F(HandshakeTest, RejectsBadTokensBeforeUpgrade) {
  EXPECT_EQ(rejected_status(decide(target("basura"))), 401u);
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims(), "otro")))), 401u);
  EXPECT_EQ(revocation.calls, 0) << "no consulta Redis con un token sin firma válida";
}

TEST_F(HandshakeTest, RejectsTokensOfAnotherRoom) {
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims("room-2")), "room-1"))), 403u);
}

TEST_F(HandshakeTest, ExpiredTokenUpgradesAndCloses4003) {
  auto claims = guest_claims();
  claims["exp"] = kNow - 1;
  auto d = decide(target(sign_jwt(claims)));
  auto* close = std::get_if<AcceptThenClose>(&d);
  ASSERT_NE(close, nullptr);
  EXPECT_EQ(close->code, 4003);
}

// AC2: un invitado bloqueado (token revocado) no entra a la voz.
TEST_F(HandshakeTest, RevokedTokenUpgradesAndCloses4001) {
  revocation.revoke("jti-ana");
  auto d = decide(target(sign_jwt(guest_claims())));
  auto* close = std::get_if<AcceptThenClose>(&d);
  ASSERT_NE(close, nullptr);
  EXPECT_EQ(close->code, 4001);
}

TEST_F(HandshakeTest, FailsClosedWhenRevocationIsUnavailable) {
  revocation.unavailable = true;
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims())))), 503u);
}

TEST(OriginAllowed, MatchesHostAndPort) {
  std::vector<std::string> allowed{"localhost:5173", "tint.example"};
  EXPECT_TRUE(origin_allowed("http://localhost:5173", allowed));
  EXPECT_TRUE(origin_allowed("https://tint.example", allowed));
  EXPECT_TRUE(origin_allowed("HTTPS://TINT.EXAMPLE", allowed));
  EXPECT_FALSE(origin_allowed("http://localhost:3000", allowed));
  EXPECT_FALSE(origin_allowed("http://localhost:5173.evil.com", allowed));
  EXPECT_FALSE(origin_allowed("null", allowed));
  EXPECT_FALSE(origin_allowed("", allowed));
}

TEST(ParseQuery, DecodesValues) {
  auto q = parse_query("/ws/voice?room_id=a%2Fb&token=x.y.z&nick=Ana+Mar%C3%ADa&flag&bad=%zz");
  EXPECT_EQ(q["room_id"], "a/b");
  EXPECT_EQ(q["token"], "x.y.z");
  EXPECT_EQ(q["nick"], "Ana María");
  EXPECT_EQ(q["flag"], "");
  EXPECT_EQ(q["bad"], "%zz");
  EXPECT_TRUE(parse_query("/ws/voice").empty());
  EXPECT_EQ(target_path("/ws/voice?x=1"), "/ws/voice");
  EXPECT_EQ(target_path("/healthz"), "/healthz");
}

// --- Fase 2: silencio del host persistido -------------------------------------------------

TEST_F(HandshakeTest, AcceptCarriesPersistedHostMute) {
  auto d = decide(target(sign_jwt(guest_claims())));
  ASSERT_NE(std::get_if<Accept>(&d), nullptr);
  EXPECT_FALSE(std::get<Accept>(d).host_muted);

  mutes.set_muted("room-1", "guest:ana", true);
  d = decide(target(sign_jwt(guest_claims())));
  ASSERT_NE(std::get_if<Accept>(&d), nullptr);
  EXPECT_TRUE(std::get<Accept>(d).host_muted);
}

TEST_F(HandshakeTest, MuteStoreDownFailsClosedWith503) {
  mutes.unavailable = true;
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims())))), 503u);
}

TEST_F(HandshakeTest, RevokedWinsOverMuteLookup) {
  revocation.revoke("jti-ana");
  mutes.unavailable = true;
  auto d = decide(target(sign_jwt(guest_claims())));
  ASSERT_NE(std::get_if<AcceptThenClose>(&d), nullptr);
  EXPECT_EQ(std::get<AcceptThenClose>(d).code, 4001);
}

TEST(UrlDecode, DecodesPercentAndPlus) {
  EXPECT_EQ(url_decode("guest%3Aana"), "guest:ana");
  EXPECT_EQ(url_decode("a+b"), "a b");
  EXPECT_EQ(url_decode("100%"), "100%");
}

// --- ADR 0018: sala deshabilitada (ROOM_CLOSED, 4010) y modo escenario (4009) -------------
//
// PRUEBAS EN ROJO: decide_handshake todavía no recibe el estado de sala. Al implementar,
// `decide()` debe pasarle `rooms` (FakeRoomState heredará de la interfaz nueva).

namespace {

class RoomStateHandshakeTest : public HandshakeTest {
 protected:
  std::uint16_t close_code(const HandshakeDecision& d) {
    auto* c = std::get_if<AcceptThenClose>(&d);
    return c ? c->code : 0;
  }
  static nlohmann::json role_claims(const std::string& role, const std::string& sub) {
    auto c = guest_claims("room-1", sub, "jti-" + sub, sub);
    c["role"] = role;
    return c;
  }

  FakeRoomState rooms;
};

}  // namespace

// HU-LIVE-09 AC1 / HU-LIVE-08 AC3: quien llega o se reconecta a una sala deshabilitada ve 4010.
TEST_F(RoomStateHandshakeTest, ClosedRoomUpgradesAndCloses4010) {
  rooms.close("room-1");
  auto d = decide(target(sign_jwt(guest_claims())));
  EXPECT_EQ(close_code(d), 4010) << "room:{id}:closed existe: upgrade y cierre 4010 ROOM_DISABLED";
}

TEST_F(RoomStateHandshakeTest, ClosedRoomAlsoClosesTheHostWith4010) {
  rooms.close("room-1");
  EXPECT_EQ(close_code(decide(target(sign_jwt(host_claims())))), 4010);
}

TEST_F(RoomStateHandshakeTest, RoomStateUnavailableFailsClosedWith503) {
  rooms.unavailable = true;
  EXPECT_EQ(rejected_status(decide(target(sign_jwt(guest_claims())))), 503u)
      << "sin poder leer room:{id}:closed / room:{id}:kind no se entra";
}

TEST_F(RoomStateHandshakeTest, InvalidTokenDoesNotQueryRoomState) {
  rooms.close("room-1");
  EXPECT_EQ(rejected_status(decide(target("basura"))), 401u);
  EXPECT_EQ(rooms.calls, 0) << "no consulta Redis con un token sin firma válida";
}

TEST_F(RoomStateHandshakeTest, OpenWatchRoomIsUnchanged) {
  auto d = decide(target(sign_jwt(guest_claims())));
  EXPECT_TRUE(std::holds_alternative<Accept>(d)) << "sala watch sin cerrar: igual que hoy";
}

TEST_F(RoomStateHandshakeTest, ValidTokenQueriesRoomState) {
  decide(target(sign_jwt(guest_claims())));
  EXPECT_GE(rooms.calls, 1) << "cada handshake válido consulta room:{id}:closed (y kind)";
}

// Modo escenario (ADR 0018): en una sala live solo entran host/cohost y los invitados.
TEST_F(RoomStateHandshakeTest, LiveRoomParticipantNotOnStageUpgradesAndCloses4009) {
  rooms.make_live("room-1");
  auto d = decide(target(sign_jwt(guest_claims())));
  EXPECT_EQ(close_code(d), 4009) << "room:{id}:kind=live y guest:ana no está en room:{id}:voice:stage";
}

TEST_F(RoomStateHandshakeTest, LiveRoomStageGuestJoins) {
  rooms.make_live("room-1");
  rooms.set_on_stage("room-1", "guest:ana", true);
  EXPECT_TRUE(std::holds_alternative<Accept>(decide(target(sign_jwt(guest_claims())))));
}

TEST_F(RoomStateHandshakeTest, LiveRoomHostAndCohostJoinWithoutStage) {
  rooms.make_live("room-1");
  EXPECT_TRUE(std::holds_alternative<Accept>(decide(target(sign_jwt(role_claims("host", "user-h"))))));
  EXPECT_TRUE(std::holds_alternative<Accept>(decide(target(sign_jwt(role_claims("cohost", "user-c"))))));
}

TEST_F(RoomStateHandshakeTest, StageOfAnotherRoomDoesNotCount) {
  rooms.make_live("room-1");
  rooms.set_on_stage("room-2", "guest:ana", true);
  EXPECT_EQ(close_code(decide(target(sign_jwt(guest_claims())))), 4009);
}

TEST_F(RoomStateHandshakeTest, LeftTheStageCannotRejoin) {
  rooms.make_live("room-1");
  rooms.set_on_stage("room-1", "guest:ana", true);
  rooms.set_on_stage("room-1", "guest:ana", false);
  EXPECT_EQ(close_code(decide(target(sign_jwt(guest_claims())))), 4009);
}

TEST_F(RoomStateHandshakeTest, ClosedWinsOverNotOnStage) {
  rooms.make_live("room-1");
  rooms.close("room-1");
  EXPECT_EQ(close_code(decide(target(sign_jwt(guest_claims())))), 4010)
      << "'el evento terminó' es más informativo que 'no estás en el escenario'";
}

TEST_F(RoomStateHandshakeTest, WatchRoomIgnoresTheStage) {
  rooms.set_on_stage("room-1", "otro", true);
  EXPECT_TRUE(std::holds_alternative<Accept>(decide(target(sign_jwt(guest_claims())))));
}
