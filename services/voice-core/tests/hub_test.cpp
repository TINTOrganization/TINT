#include "hub/hub.hpp"

#include <atomic>
#include <thread>

#include <gtest/gtest.h>

#include "support/fake_peer.hpp"

using namespace voice::hub;
using nlohmann::json;
using voice::auth::Claims;
using voice::testing::FakePeer;

namespace {

Claims claims(std::string sub, std::string role = "participant", std::string jti = "") {
  return {sub, "room-1", role, "Nick " + sub, jti.empty() ? "jti-" + sub : jti, 0};
}

class HubTest : public ::testing::Test {
 protected:
  HubOptions options(std::size_t max = 8) {
    HubOptions o;
    o.max_members = max;
    o.now_ms = [] { return 5000; };
    o.new_event_id = [this] { return "evt-" + std::to_string(++ids_); };
    o.ice_servers = [](const Claims& c) { return json::array({{{"urls", {"stun:x"}}, {"for", c.sub}}}); };
    return o;
  }

  std::shared_ptr<FakePeer> join(Hub& hub, const std::string& peer_id, const Claims& c,
                                 const std::string& room = "room-1") {
    auto peer = std::make_shared<FakePeer>(peer_id);
    hub.join(room, c, peer);
    return peer;
  }

  std::atomic<int> ids_{0};
};

}  // namespace

// AC1: al unirse recibe a quienes ya están (para iniciar WebRTC) y los demás lo ven llegar.
TEST_F(HubTest, JoinSendsStateAndAnnouncesThePeer) {
  Hub hub(options());
  auto host = join(hub, "p-host", claims("host", "host"));
  auto ana = join(hub, "p-ana", claims("ana"));

  auto states = ana->of_type("voice_state");
  ASSERT_EQ(states.size(), 1u);
  EXPECT_EQ(states[0]["room_id"], "room-1");
  EXPECT_EQ(states[0]["self"]["peer_id"], "p-ana");
  EXPECT_EQ(states[0]["self"]["user_id"], "ana");
  ASSERT_EQ(states[0]["peers"].size(), 1u);
  EXPECT_EQ(states[0]["peers"][0]["peer_id"], "p-host");
  EXPECT_EQ(states[0]["max_members"], 8);
  EXPECT_EQ(states[0]["ice_servers"][0]["for"], "ana") << "credenciales ICE por usuario";
  EXPECT_FALSE(states[0]["event_id"].get<std::string>().empty());
  EXPECT_EQ(states[0]["received_at"], 5000);

  auto joined = host->of_type("peer_joined");
  ASSERT_EQ(joined.size(), 1u);
  EXPECT_EQ(joined[0]["peer"]["peer_id"], "p-ana");
  EXPECT_TRUE(ana->of_type("peer_joined").empty()) << "no se anuncia a sí mismo";
}

TEST_F(HubTest, RoomsAreIsolated) {
  Hub hub(options());
  auto a = join(hub, "p-a", claims("a"), "room-1");
  auto b = join(hub, "p-b", claims("b"), "room-2");
  EXPECT_TRUE(a->of_type("peer_joined").empty());
  EXPECT_EQ(b->of_type("voice_state")[0]["peers"].size(), 0u);
  EXPECT_EQ(hub.members("room-1").size(), 1u);
  EXPECT_EQ(hub.members("room-2").size(), 1u);
  EXPECT_TRUE(hub.members("room-3").empty());
}

TEST_F(HubTest, FullRoomRefusesWithErrorAndClose) {
  Hub hub(options(2));
  join(hub, "p-a", claims("a"));
  join(hub, "p-b", claims("b"));
  auto c = std::make_shared<FakePeer>("p-c");
  EXPECT_FALSE(hub.join("room-1", claims("c"), c));
  ASSERT_EQ(c->of_type("error").size(), 1u);
  EXPECT_EQ(c->of_type("error")[0]["code"], "VOICE_FULL");
  ASSERT_TRUE(c->closed().has_value());
  EXPECT_EQ(c->closed()->first, close_code::kFull);
  EXPECT_EQ(hub.members("room-1").size(), 2u);
}

TEST_F(HubTest, DuplicatePeerIdIsRefused) {
  Hub hub(options());
  join(hub, "p-a", claims("a"));
  auto dup = std::make_shared<FakePeer>("p-a");
  EXPECT_FALSE(hub.join("room-1", claims("a"), dup));
  EXPECT_TRUE(dup->closed().has_value());
}

// La señalización (offer/answer/ICE) solo llega al destinatario, con el remitente real.
TEST_F(HubTest, RelaysSignalToTheTargetOnly) {
  Hub hub(options());
  auto host = join(hub, "p-host", claims("host", "host"));
  auto ana = join(hub, "p-ana", claims("ana"));
  auto luis = join(hub, "p-luis", claims("luis"));
  host->clear();
  luis->clear();

  hub.handle_message(
      "room-1", "p-ana",
      R"({"type":"signal","event_id":"e1","occurred_at":77,"to":"p-host","data":{"sdp":"offer"}})");

  auto signals = host->of_type("signal");
  ASSERT_EQ(signals.size(), 1u);
  EXPECT_EQ(signals[0]["from"], "p-ana");
  EXPECT_EQ(signals[0]["data"]["sdp"], "offer");
  EXPECT_EQ(signals[0]["event_id"], "e1");
  EXPECT_EQ(signals[0]["occurred_at"], 77);
  EXPECT_EQ(signals[0]["received_at"], 5000);
  EXPECT_TRUE(luis->sent().empty());
}

TEST_F(HubTest, SignalToUnknownOrSelfIsAnError) {
  Hub hub(options());
  auto ana = join(hub, "p-ana", claims("ana"));
  join(hub, "p-x", claims("x"), "room-2");
  ana->clear();

  hub.handle_message("room-1", "p-ana",
                     R"({"type":"signal","event_id":"e1","occurred_at":1,"to":"p-x","data":{}})");
  hub.handle_message("room-1", "p-ana",
                     R"({"type":"signal","event_id":"e2","occurred_at":1,"to":"p-ana","data":{}})");

  auto errors = ana->of_type("error");
  ASSERT_EQ(errors.size(), 2u);
  EXPECT_EQ(errors[0]["code"], "PEER_NOT_FOUND") << "no se puede señalizar a otra sala";
  EXPECT_EQ(errors[0]["event_id_ref"], "e1");
  EXPECT_EQ(errors[1]["code"], "PEER_NOT_FOUND");
}

TEST_F(HubTest, InvalidMessagesAnswerWithErrorWithoutClosing) {
  Hub hub(options());
  auto ana = join(hub, "p-ana", claims("ana"));
  ana->clear();
  hub.handle_message("room-1", "p-ana", "{roto");
  hub.handle_message("room-1", "p-ana", R"({"type":"bailar","event_id":"e"})");
  auto errors = ana->of_type("error");
  ASSERT_EQ(errors.size(), 2u);
  EXPECT_EQ(errors[0]["code"], "INVALID_MESSAGE");
  EXPECT_EQ(errors[1]["code"], "UNKNOWN_TYPE");
  EXPECT_FALSE(ana->closed().has_value());
}

TEST_F(HubTest, MessagesFromUnknownPeersAreIgnored) {
  Hub hub(options());
  auto ana = join(hub, "p-ana", claims("ana"));
  ana->clear();
  hub.handle_message("room-1", "p-ghost",
                     R"({"type":"signal","event_id":"e","occurred_at":1,"to":"p-ana","data":{}})");
  hub.handle_message("room-9", "p-ghost", "{}");
  EXPECT_TRUE(ana->sent().empty());
}

// AC3: al desconectarse, los demás reciben peer_left (y cierran su RTCPeerConnection).
TEST_F(HubTest, LeaveAnnouncesPeerLeft) {
  Hub hub(options());
  auto host = join(hub, "p-host", claims("host", "host"));
  auto ana = join(hub, "p-ana", claims("ana"));
  host->clear();

  hub.leave("room-1", "p-ana");
  auto left = host->of_type("peer_left");
  ASSERT_EQ(left.size(), 1u);
  EXPECT_EQ(left[0]["peer_id"], "p-ana");
  EXPECT_EQ(hub.members("room-1").size(), 1u);

  hub.leave("room-1", "p-ana");
  EXPECT_EQ(host->of_type("peer_left").size(), 1u) << "idempotente";
  hub.leave("room-9", "p-x");
}

TEST_F(HubTest, LeaveMessageClosesNormally) {
  Hub hub(options());
  auto host = join(hub, "p-host", claims("host", "host"));
  auto ana = join(hub, "p-ana", claims("ana"));
  hub.handle_message("room-1", "p-ana", R"({"type":"leave","event_id":"e","occurred_at":1})");
  ASSERT_TRUE(ana->closed().has_value());
  EXPECT_EQ(ana->closed()->first, close_code::kNormal);
  EXPECT_EQ(host->of_type("peer_left").size(), 1u);
}

TEST_F(HubTest, EmptyRoomsAreForgotten) {
  Hub hub(options(1));
  join(hub, "p-a", claims("a"));
  hub.leave("room-1", "p-a");
  auto b = std::make_shared<FakePeer>("p-b");
  EXPECT_TRUE(hub.join("room-1", claims("b"), b));
}

// AC2 (en vivo): un bloqueo revoca el jti y cierra con 4001 todas sus conexiones de voz.
TEST_F(HubTest, RevokeClosesEveryConnectionOfTheTokenAndAnnouncesIt) {
  Hub hub(options());
  auto host = join(hub, "p-host", claims("host", "host"));
  auto tab1 = join(hub, "p-tab1", claims("ana", "participant", "jti-x"));
  auto tab2 = join(hub, "p-tab2", claims("ana", "participant", "jti-x"));
  host->clear();

  hub.revoke("room-1", "jti-x");

  for (auto& tab : {tab1, tab2}) {
    ASSERT_TRUE(tab->closed().has_value());
    EXPECT_EQ(tab->closed()->first, close_code::kRevoked);
  }
  EXPECT_EQ(host->of_type("peer_left").size(), 2u);
  EXPECT_FALSE(host->closed().has_value());
  EXPECT_EQ(hub.members("room-1").size(), 1u);

  hub.revoke("room-1", "jti-otro");
  hub.revoke("room-9", "jti-x");
}

TEST_F(HubTest, IsSafeUnderConcurrentJoinsAndLeaves) {
  Hub hub(options(16));
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; ++t) {
    threads.emplace_back([&, t] {
      for (int i = 0; i < 50; ++i) {
        std::string id = "p-" + std::to_string(t) + "-" + std::to_string(i);
        auto peer = std::make_shared<FakePeer>(id);
        hub.join("room-1", claims(id), peer);
        hub.handle_message("room-1", id,
                           R"({"type":"signal","event_id":"e","occurred_at":1,"to":"x","data":{}})");
        hub.leave("room-1", id);
      }
    });
  }
  for (auto& th : threads) th.join();
  EXPECT_TRUE(hub.members("room-1").empty());
}
