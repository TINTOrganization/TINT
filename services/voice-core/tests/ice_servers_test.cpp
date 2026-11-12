#include "ice/ice_servers.hpp"

#include <gtest/gtest.h>

using namespace voice::ice;
using nlohmann::json;

// Vector calculado aparte: base64(HMAC-SHA1("turn-secret", "1800003600:guest:ana")).
TEST(TurnCredential, MatchesTheTurnRestApi) {
  auto c = make_turn_credential("turn-secret", "guest:ana", 1'800'003'600);
  EXPECT_EQ(c.username, "1800003600:guest:ana");
  EXPECT_EQ(c.credential, "2rct7MAw1emw4TZgofj42cKf3M8=");
}

TEST(TurnCredential, DependsOnSecretUserAndExpiry) {
  auto base = make_turn_credential("s", "u", 100);
  EXPECT_NE(base.credential, make_turn_credential("otro", "u", 100).credential);
  EXPECT_NE(base.credential, make_turn_credential("s", "v", 100).credential);
  EXPECT_NE(base.credential, make_turn_credential("s", "u", 101).credential);
  EXPECT_EQ(base.credential, make_turn_credential("s", "u", 100).credential);
}

TEST(IceServers, StunAndTurnWithEphemeralCredential) {
  IceConfig config{{"stun:localhost:3478"},
                   {"turn:localhost:3478?transport=udp", "turn:localhost:3478?transport=tcp"},
                   "turn-secret",
                   std::chrono::seconds(3600)};
  json servers = make_ice_servers(config, "guest:ana", 1'800'000'000);
  ASSERT_EQ(servers.size(), 2u);
  EXPECT_EQ(servers[0], (json{{"urls", {"stun:localhost:3478"}}}));
  EXPECT_EQ(servers[1]["urls"],
            json::array({"turn:localhost:3478?transport=udp", "turn:localhost:3478?transport=tcp"}));
  EXPECT_EQ(servers[1]["username"], "1800003600:guest:ana");
  EXPECT_EQ(servers[1]["credential"], "2rct7MAw1emw4TZgofj42cKf3M8=");
}

TEST(IceServers, OnlyWhatIsConfigured) {
  EXPECT_EQ(make_ice_servers({}, "u", 1), json::array());
  auto stun_only = make_ice_servers({{"stun:x"}, {}, "", std::chrono::seconds(60)}, "u", 1);
  ASSERT_EQ(stun_only.size(), 1u);
  EXPECT_FALSE(stun_only[0].contains("username"));
  auto turn_only = make_ice_servers({{}, {"turn:x"}, "s", std::chrono::seconds(60)}, "u", 1);
  ASSERT_EQ(turn_only.size(), 1u);
  EXPECT_EQ(turn_only[0]["username"], "61:u");
}

// Sin secreto no se inventa una credencial que coturn rechazaría.
TEST(IceServers, TurnWithoutSecretIsLeftOut) {
  auto servers = make_ice_servers({{"stun:x"}, {"turn:x"}, "", std::chrono::seconds(60)}, "u", 1);
  ASSERT_EQ(servers.size(), 1u);
  EXPECT_EQ(servers[0]["urls"], json::array({"stun:x"}));
}
