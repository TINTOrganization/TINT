#include "net/handshake.hpp"

#include <gtest/gtest.h>

#include "support/fake_mute_store.hpp"
#include "support/fake_revocation.hpp"
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
