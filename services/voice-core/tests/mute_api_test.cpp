#include "net/mute_api.hpp"

#include <gtest/gtest.h>

#include "support/fake_revocation.hpp"
#include "support/jwt.hpp"

using namespace voice::net;
using namespace voice::testing;

namespace {

class MuteApiTest : public ::testing::Test {
 protected:
  MuteDecision decide(std::string_view method, const std::string& target,
                      std::optional<std::string> authorization) {
    std::optional<std::string_view> auth;
    if (authorization) auth = *authorization;
    return decide_mute_request({method, target, auth}, verifier, revocation, kNow);
  }
  static std::string bearer(const nlohmann::json& claims) { return "Bearer " + sign_jwt(claims); }
  static constexpr const char* kPath = "/api/v1/voice/rooms/room-1/mutes/guest%3Aana";
  unsigned status(const MuteDecision& d) {
    auto* r = std::get_if<Reject>(&d);
    return r ? r->status : 0;
  }

  voice::auth::TokenVerifier verifier{kSecret, kIssuer, kAudience};
  FakeRevocation revocation;
};

}  // namespace

TEST(ParseMutePath, ExtractsRoomAndUser) {
  auto p = parse_mute_path("/api/v1/voice/rooms/room-1/mutes/guest%3Aana");
  ASSERT_TRUE(p);
  EXPECT_EQ(p->first, "room-1");
  EXPECT_EQ(p->second, "guest:ana");
  EXPECT_TRUE(parse_mute_path("/api/v1/voice/rooms/r/mutes/u?x=1")) << "ignora la query";
}

TEST(ParseMutePath, RejectsOtherPaths) {
  for (const char* t : {"/api/v1/voice/rooms/r/mutes/", "/api/v1/voice/rooms//mutes/u",
                        "/api/v1/voice/rooms/r/bans/u", "/api/v1/voice/rooms/r/mutes/u/extra",
                        "/api/v1/voice/rooms/r", "/healthz", "/api/v1/voice/rooms/r/mutes"})
    EXPECT_FALSE(parse_mute_path(t)) << t;
}

// HU-VOZ-04: el host silencia (PUT) y levanta el silencio (DELETE).
TEST_F(MuteApiTest, HostCanMuteAndUnmute) {
  auto put = decide("PUT", kPath, bearer(host_claims()));
  auto* cmd = std::get_if<MuteCommand>(&put);
  ASSERT_NE(cmd, nullptr);
  EXPECT_EQ(cmd->room_id, "room-1");
  EXPECT_EQ(cmd->user_id, "guest:ana");
  EXPECT_TRUE(cmd->muted);
  EXPECT_EQ(revocation.calls, 1) << "revisa la revocación del host";

  auto del = decide("DELETE", kPath, bearer(host_claims()));
  ASSERT_NE(std::get_if<MuteCommand>(&del), nullptr);
  EXPECT_FALSE(std::get<MuteCommand>(del).muted);
}

TEST_F(MuteApiTest, CohostCanMute) {
  auto c = host_claims();
  c["role"] = "cohost";
  EXPECT_TRUE(std::holds_alternative<MuteCommand>(decide("PUT", kPath, bearer(c))));
}

TEST_F(MuteApiTest, AcceptsLowercaseBearer) {
  EXPECT_TRUE(std::holds_alternative<MuteCommand>(decide("PUT", kPath, "bearer " + sign_jwt(host_claims()))));
}

// HU-VOZ-04 AC3: un no-host recibe 403.
TEST_F(MuteApiTest, ParticipantGets403) {
  EXPECT_EQ(status(decide("PUT", kPath, bearer(guest_claims()))), 403u);
  EXPECT_EQ(status(decide("DELETE", kPath, bearer(guest_claims()))), 403u);
}

TEST_F(MuteApiTest, HostOfAnotherRoomGets403) {
  EXPECT_EQ(status(decide("PUT", kPath, bearer(host_claims("room-2")))), 403u);
}

TEST_F(MuteApiTest, MissingOrBadTokenGets401) {
  EXPECT_EQ(status(decide("PUT", kPath, std::nullopt)), 401u);
  EXPECT_EQ(status(decide("PUT", kPath, "Basic abc")), 401u);
  EXPECT_EQ(status(decide("PUT", kPath, "Bearer ")), 401u);
  EXPECT_EQ(status(decide("PUT", kPath, "Bearer basura")), 401u);
  EXPECT_EQ(status(decide("PUT", kPath, "Bearer " + sign_jwt(host_claims(), "otro"))), 401u);
  auto expired = host_claims();
  expired["exp"] = kNow - 1;
  EXPECT_EQ(status(decide("PUT", kPath, bearer(expired))), 401u);
  EXPECT_EQ(revocation.calls, 0);
}

TEST_F(MuteApiTest, RevokedHostGets401AndRedisDownGets503) {
  revocation.revoke("jti-host");
  EXPECT_EQ(status(decide("PUT", kPath, bearer(host_claims()))), 401u);
  revocation.unavailable = true;
  EXPECT_EQ(status(decide("PUT", kPath, bearer(host_claims()))), 503u);
}

TEST_F(MuteApiTest, WrongMethodOrPath) {
  EXPECT_EQ(status(decide("GET", kPath, bearer(host_claims()))), 405u);
  EXPECT_EQ(status(decide("POST", kPath, bearer(host_claims()))), 405u);
  EXPECT_EQ(status(decide("PUT", "/api/v1/voice/rooms/room-1", bearer(host_claims()))), 404u);
}
