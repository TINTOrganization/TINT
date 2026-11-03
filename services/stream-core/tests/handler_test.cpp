// Respuestas HTTP de WHIP/WHEP y rutas internas (HU-LIVE-01, 03, 06, 07).
#include "http/handler.hpp"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "support/fakes.hpp"
#include "support/jwt.hpp"
#include "support/sdp_fixtures.hpp"
#include "support/service_fakes.hpp"

using namespace stream;
using namespace stream::http;
using namespace stream::testing;
using nlohmann::json;

namespace {

class HandlerTest : public ::testing::Test {
 protected:
  HandlerTest() { store.enabled.insert("room-1"); }

  Response run(Request r) { return handler.handle(r); }
  Request whep(std::string origin = "") {
    return {Method::Post,
            "/api/v1/stream/rooms/room-1/whep",
            "",
            "Bearer " + sign_jwt(guest_claims()),
            "application/sdp",
            std::move(origin),
            kChromeWhepOffer};
  }

  auth::TokenVerifier verifier{kSecret, kIssuer, kAudience};
  FakeRevocation revocation;
  FakePeerFactory factory;
  FakeRoomStore store;
  FakeIdentityClient identity;
  service::StreamService svc{{}, factory, store, identity, [] { return kNow * 1000; }};
  Handler handler{HandlerDeps{verifier,
                              revocation,
                              store,
                              svc,
                              ice::IceConfig{{"stun:stun.example:3478"},
                                             {"turn:turn.example:3478?transport=udp"},
                                             "turn-secret",
                                             std::chrono::seconds(3600)},
                              {"localhost:5173"},
                              50,
                              [] { return kNow; }}};
};

}  // namespace

TEST_F(HandlerTest, HealthzReturnsOk) {
  auto r = run({Method::Get, "/healthz", "", "", "", "", ""});
  EXPECT_EQ(r.status, 200);
  EXPECT_EQ(json::parse(r.body), (json{{"status", "ok"}, {"service", "stream-core"}}));
}

TEST_F(HandlerTest, WhepReturns201WithSdpLocationAndIceLinks) {
  auto r = run(whep());
  ASSERT_EQ(r.status, 201) << r.body;
  EXPECT_EQ(r.header("Content-Type"), "application/sdp");
  EXPECT_EQ(r.body, "v=0\r\n");
  EXPECT_TRUE(r.header("Location").starts_with("/api/v1/stream/sessions/"));
  auto links = r.all("Link");
  ASSERT_EQ(links.size(), 2u);
  EXPECT_EQ(links[0], R"(<stun:stun.example:3478>; rel="ice-server")");
  EXPECT_TRUE(
      links[1].starts_with(R"(<turn:turn.example:3478?transport=udp>; rel="ice-server"; username=")"));
  EXPECT_NE(links[1].find(R"(credential-type="password")"), std::string::npos);
}

TEST_F(HandlerTest, WhipCreatesHostSession) {
  Request r{Method::Post,
            "/api/v1/stream/rooms/room-1/whip",
            "",
            "Bearer " + sign_jwt(host_claims()),
            "application/sdp",
            "",
            kChromeWhipVideoOffer};
  EXPECT_EQ(run(r).status, 201);
}

TEST_F(HandlerTest, ProblemsAreJsonWithErrorAndMessage) {
  auto r = whep();
  r.authorization.clear();
  auto res = run(r);
  EXPECT_EQ(res.status, 401);
  EXPECT_EQ(res.header("Content-Type"), "application/json");
  auto j = json::parse(res.body);
  EXPECT_EQ(j["error"], "UNAUTHORIZED");
  EXPECT_FALSE(j["message"].get<std::string>().empty());
}

TEST_F(HandlerTest, ServiceProblemIsReturned) {
  store.closed.insert("room-1");
  auto r = run(whep());
  EXPECT_EQ(r.status, 410);
  EXPECT_EQ(json::parse(r.body)["error"], "ROOM_DISABLED");
}

TEST_F(HandlerTest, CorsForAllowedOriginExposesLocationAndLink) {
  auto r = run(whep("http://localhost:5173"));
  EXPECT_EQ(r.header("Access-Control-Allow-Origin"), "http://localhost:5173");
  EXPECT_EQ(r.header("Access-Control-Expose-Headers"), "Location, Link");
  EXPECT_EQ(r.header("Vary"), "Origin");
}

TEST_F(HandlerTest, PreflightAllowsMethodsAndHeaders) {
  auto r =
      run({Method::Options, "/api/v1/stream/rooms/room-1/whep", "", "", "", "http://localhost:5173", ""});
  EXPECT_EQ(r.status, 204);
  EXPECT_EQ(r.header("Access-Control-Allow-Methods"), "GET, POST, PATCH, DELETE, OPTIONS");
  EXPECT_EQ(r.header("Access-Control-Allow-Headers"), "Authorization, Content-Type");
}

TEST_F(HandlerTest, IceServersEachCallIssuesFreshCredentials) {
  Request r{Method::Get, "/api/v1/stream/rooms/room-1/ice-servers",
            "",          "Bearer " + sign_jwt(guest_claims()),
            "",          "",
            ""};
  auto res = run(r);
  ASSERT_EQ(res.status, 200);
  auto servers = json::parse(res.body)["ice_servers"];
  ASSERT_EQ(servers.size(), 2u);
  EXPECT_TRUE(servers[1]["username"].get<std::string>().ends_with(":guest:ana"));
  EXPECT_EQ(res.all("Link").size(), 2u);
}

TEST_F(HandlerTest, PatchAndDeleteSession) {
  auto created = run(whep());
  auto location = created.header("Location");
  const auto token = "Bearer " + sign_jwt(guest_claims());
  auto patch = run({Method::Patch, location, "", token, "application/trickle-ice-sdpfrag", "",
                    "a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n"});
  EXPECT_EQ(patch.status, 204);
  EXPECT_EQ(run({Method::Delete, location, "", token, "", "", ""}).status, 200);
  EXPECT_EQ(run({Method::Delete, location, "", token, "", "", ""}).status, 404);
}

TEST_F(HandlerTest, InternalEventsStartEnablesRoom) {
  auto r = run({Method::Post, "/internal/events/start/room-9", "", "", "application/json", "",
                R"({"roomId":"room-9","hostId":"u"})"});
  EXPECT_EQ(r.status, 200);
  EXPECT_TRUE(store.enabled.contains("room-9"));
  EXPECT_EQ(json::parse(r.body)["room_id"], "room-9");
}

TEST_F(HandlerTest, InternalEventsStopDisablesRoom) {
  EXPECT_EQ(run({Method::Delete, "/internal/events/start/room-1", "", "", "", "", ""}).status, 204);
  EXPECT_FALSE(store.enabled.contains("room-1"));
}

TEST_F(HandlerTest, InternalStoreDown503) {
  store.unavailable = true;
  EXPECT_EQ(run({Method::Post, "/internal/events/start/room-9", "", "", "", "", ""}).status, 503);
}

TEST_F(HandlerTest, InternalBadPathOrMethod) {
  EXPECT_EQ(run({Method::Get, "/internal/events/start/room-9", "", "", "", "", ""}).status, 405);
  EXPECT_EQ(run({Method::Post, "/internal/events/start/", "", "", "", "", ""}).status, 404);
}

TEST(IceLinkHeaders, EscapesCredentials) {
  json servers =
      json::array({{{"urls", {"turn:a:3478"}}, {"username", "1:guest:\"x\""}, {"credential", "c\\d"}}});
  auto links = ice_link_headers(servers);
  ASSERT_EQ(links.size(), 1u);
  EXPECT_EQ(links[0], R"(<turn:a:3478>; rel="ice-server"; username="1:guest:\"x\""; credential="c\\d"; )"
                      R"(credential-type="password")");
}
