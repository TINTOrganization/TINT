// Orquestación de sesiones y ciclo de vida (HU-LIVE-01, 04, 05, 08) sin red: peers falsos y reloj manual.
#include "service/stream_service.hpp"

#include <gtest/gtest.h>

#include "support/rtp_builder.hpp"
#include "support/sdp_fixtures.hpp"
#include "support/service_fakes.hpp"

using namespace stream;
using namespace stream::service;
using namespace stream::testing;

namespace {

auth::Claims claims(std::string sub, std::string role, std::string jti) {
  return {std::move(sub), "room-1", std::move(role), "Nick", std::move(jti), 0};
}
auth::Claims host() { return claims("user-host", "host", "jti-host"); }
auth::Claims guest(std::string n) { return claims("guest:" + n, "participant", "jti-" + n); }

rtp::Bytes keyframe(std::uint16_t seq = 1) {
  return build_rtp({.pt = 96,
                    .seq = seq,
                    .ssrc = 0x10,
                    .extensions = {{4, "l"}},
                    .payload = build_vp8_payload({.keyframe = true})});
}

class StreamServiceTest : public ::testing::Test {
 protected:
  StreamServiceTest() { store.enabled.insert("room-1"); }

  StreamService svc{ServiceConfig{.max_viewers = 3}, factory, store, identity, [this] { return now; }};

  SessionAnswer publish_host() {
    auto a = svc.publish({"room-1", host(), http::PublishMedia::Video, kChromeWhipVideoOffer});
    EXPECT_TRUE(a);
    return *a;
  }
  SessionAnswer watch(std::string name) {
    auto a = svc.watch({"room-1", guest(name), kChromeWhepOffer});
    EXPECT_TRUE(a) << (a ? "" : a.error().code);
    return a ? *a : SessionAnswer{};
  }
  FakePeerFactory::Created& peer(const std::string& session) { return factory.created.at(session); }
  void host_sends_keyframe(const std::string& session, std::uint16_t seq = 1) {
    auto pkt = keyframe(seq);
    peer(session).callbacks.on_rtp(pkt);
  }

  std::int64_t now = 1'000'000;
  FakePeerFactory factory;
  FakeRoomStore store;
  FakeIdentityClient identity;
};

}  // namespace

TEST_F(StreamServiceTest, PublishCreatesHostSessionWithAnswer) {
  auto a = publish_host();
  EXPECT_FALSE(a.session_id.empty());
  EXPECT_EQ(a.sdp, "v=0\r\n");
  auto info = svc.session(a.session_id);
  ASSERT_TRUE(info);
  EXPECT_EQ(info->owner_sub, "user-host");
  EXPECT_EQ(info->ice_ufrag, "ufrag-" + a.session_id);
  EXPECT_EQ(peer(a.session_id).request.role, PeerRole::HostVideo);
}

TEST_F(StreamServiceTest, AudioPublishUsesSecondSession) {
  auto v = publish_host();
  auto a = svc.publish({"room-1", host(), http::PublishMedia::Audio, kChromeWhipAudioOffer});
  ASSERT_TRUE(a);
  EXPECT_NE(a->session_id, v.session_id);
  EXPECT_EQ(peer(a->session_id).request.role, PeerRole::HostAudio);
}

TEST_F(StreamServiceTest, StreamStartedPublishedOnFirstKeyframeOnly) {
  auto a = publish_host();
  EXPECT_EQ(svc.state_of("room-1"), sfu::State::Waiting);
  host_sends_keyframe(a.session_id);
  EXPECT_EQ(svc.state_of("room-1"), sfu::State::Live);
  EXPECT_EQ(store.started.at("room-1"), now);
}

TEST_F(StreamServiceTest, ViewerBeforeHostIsWaiting) {
  auto v = watch("ana");
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("state":"waiting")"));
}

TEST_F(StreamServiceTest, WatchGetsViewerOptionsFromOffer) {
  auto v = watch("ana");
  const auto& req = peer(v.session_id).request;
  EXPECT_EQ(req.role, PeerRole::Viewer);
  EXPECT_EQ(req.viewer.video_payload_type, 100) << "PT de VP8 en la oferta del viewer";
  EXPECT_EQ(req.viewer.audio_payload_type, 109);
  EXPECT_NE(req.viewer.video_ssrc, 0u);
  EXPECT_NE(req.viewer.video_ssrc, req.viewer.audio_ssrc);
}

TEST_F(StreamServiceTest, ViewersReceiveLiveStateAndCount) {
  auto h = publish_host();
  auto v = watch("ana");
  host_sends_keyframe(h.session_id);
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("state":"live")"));
  svc.tick();
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"({"count":1,"type":"viewer_count"})"));
  EXPECT_EQ(svc.viewer_count("room-1"), 1);
}

TEST_F(StreamServiceTest, RoomFullReturns409) {
  watch("a");
  watch("b");
  watch("c");
  auto extra = svc.watch({"room-1", guest("d"), kChromeWhepOffer});
  ASSERT_FALSE(extra);
  EXPECT_EQ(extra.error().status, 409);
  EXPECT_EQ(extra.error().code, "ROOM_FULL");
  EXPECT_EQ(factory.created.size(), 3u) << "se rechaza antes de crear la PeerConnection: no gasta recursos";
}

TEST_F(StreamServiceTest, ViewerDisconnectReleasesSession) {
  auto v = watch("ana");
  peer(v.session_id).callbacks.on_closed();
  EXPECT_FALSE(svc.session(v.session_id));
  EXPECT_EQ(svc.viewer_count("room-1"), 0);
}

TEST_F(StreamServiceTest, DeleteByViewerReleasesAndClosesPeer) {
  auto v = watch("ana");
  svc.end_session({v.session_id, guest("ana")});
  EXPECT_FALSE(svc.session(v.session_id));
  EXPECT_TRUE(peer(v.session_id).peer->closed);
}

TEST_F(StreamServiceTest, TrickleForwardsCandidates) {
  auto v = watch("ana");
  EXPECT_FALSE(svc.trickle({v.session_id, guest("ana"), "a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n"}));
  EXPECT_EQ(peer(v.session_id).peer->candidates.size(), 1u);
  auto missing = svc.trickle({"nope", guest("ana"), ""});
  ASSERT_TRUE(missing);
  EXPECT_EQ(missing->status, 404);
}

TEST_F(StreamServiceTest, HostLostThenGraceExpiryDisablesRoomOnce) {
  auto h = publish_host();
  auto v = watch("ana");
  host_sends_keyframe(h.session_id);
  peer(h.session_id).callbacks.on_closed();
  EXPECT_EQ(svc.state_of("room-1"), sfu::State::HostGrace);
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("state":"reconnecting")"));

  now += 59'999;
  svc.tick();
  EXPECT_TRUE(identity.calls.empty());
  now += 1;
  svc.tick();
  ASSERT_EQ(identity.calls.size(), 1u);
  EXPECT_EQ(identity.calls[0], (std::pair<std::string, std::string>{"room-1", "grace_expired"}));
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("state":"ended")"));
  EXPECT_TRUE(peer(v.session_id).peer->closed);
  EXPECT_FALSE(svc.session(v.session_id));
  ASSERT_EQ(store.ended.size(), 1u);
  now += 10'000;
  svc.tick();
  EXPECT_EQ(identity.calls.size(), 1u);
}

TEST_F(StreamServiceTest, HostReturnsWithinGraceKeepsViewers) {
  auto h = publish_host();
  auto v = watch("ana");
  host_sends_keyframe(h.session_id);
  peer(h.session_id).callbacks.on_closed();
  now += 30'000;
  auto again = publish_host();
  EXPECT_EQ(svc.state_of("room-1"), sfu::State::Live);
  EXPECT_TRUE(svc.session(v.session_id)) << "el viewer conserva su sesión (HU-LIVE-05 AC3)";
  EXPECT_FALSE(svc.session(h.session_id)) << "la sesión vieja del host se reemplazó";
  now += 60'000;
  host_sends_keyframe(again.session_id, 2);
  svc.tick();
  EXPECT_TRUE(identity.calls.empty());
}

TEST_F(StreamServiceTest, HostRepublishWhileLiveReplacesOldSession) {
  auto first = publish_host();
  auto second = publish_host();
  EXPECT_TRUE(peer(first.session_id).peer->closed);
  EXPECT_FALSE(svc.session(first.session_id));
  EXPECT_TRUE(svc.session(second.session_id));
}

TEST_F(StreamServiceTest, IdentityFailureStillEndsLocally) {
  identity.succeed = false;
  auto h = publish_host();
  host_sends_keyframe(h.session_id);
  peer(h.session_id).callbacks.on_closed();
  now += 60'000;
  svc.tick();
  EXPECT_EQ(svc.state_of("room-1"), sfu::State::Ended);
}

TEST_F(StreamServiceTest, PublishAfterEndRejected410) {
  auto h = publish_host();
  svc.on_room_closed("room-1");
  auto again = svc.publish({"room-1", host(), http::PublishMedia::Video, kChromeWhipVideoOffer});
  ASSERT_FALSE(again);
  EXPECT_EQ(again.error().status, 410);
  EXPECT_EQ(again.error().code, "ROOM_DISABLED");
  auto late = svc.watch({"room-1", guest("tarde"), kChromeWhepOffer});
  ASSERT_FALSE(late);
  EXPECT_EQ(late.error().status, 410);
}

TEST_F(StreamServiceTest, RoomClosedTearsDownEverything) {
  auto h = publish_host();
  auto v = watch("ana");
  svc.on_room_closed("room-1");
  EXPECT_TRUE(peer(h.session_id).peer->closed);
  EXPECT_TRUE(peer(v.session_id).peer->closed);
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("reason":"room_closed")"));
  EXPECT_FALSE(svc.session(h.session_id));
  EXPECT_TRUE(identity.calls.empty()) << "identity-api ya la deshabilitó";
}

TEST_F(StreamServiceTest, RevokedClosesSessionsWithThatJti) {
  auto a = watch("ana");
  auto b = watch("bob");
  svc.on_revoked("jti-ana");
  EXPECT_TRUE(peer(a.session_id).peer->closed);
  EXPECT_FALSE(svc.session(a.session_id));
  EXPECT_TRUE(svc.session(b.session_id));
}

TEST_F(StreamServiceTest, EventsStartEnablesAndStopTearsDown) {
  EXPECT_TRUE(svc.events_start("room-2"));
  EXPECT_TRUE(store.enabled.contains("room-2"));
  auto v = svc.watch({"room-1", guest("ana"), kChromeWhepOffer});
  EXPECT_TRUE(svc.events_stop("room-1"));
  EXPECT_FALSE(store.enabled.contains("room-1"));
  EXPECT_TRUE(peer(v->session_id).peer->closed);
}

TEST_F(StreamServiceTest, HostSceneMessageIsBroadcast) {
  auto h = publish_host();
  auto v = watch("ana");
  peer(h.session_id).callbacks.on_message(R"({"type":"scene","name":"brb"})");
  EXPECT_TRUE(peer(v.session_id).peer->has_event(R"("name":"brb")"));
  peer(h.session_id).callbacks.on_message(R"({"type":"scene","name":"<b>"})");
  EXPECT_FALSE(peer(v.session_id).peer->has_event("<b>"));
  auto late = watch("bob");
  EXPECT_TRUE(peer(late.session_id).peer->has_event(R"("name":"brb")")) << "quien llega ve la escena actual";
}

TEST_F(StreamServiceTest, PeerFactoryFailurePropagatesProblem) {
  factory.fail = true;
  auto a = svc.publish({"room-1", host(), http::PublishMedia::Video, kChromeWhipVideoOffer});
  ASSERT_FALSE(a);
  EXPECT_EQ(a.error().status, 400);
}

TEST_F(StreamServiceTest, HostMediaReachesViewer) {
  auto h = publish_host();
  auto v = watch("ana");
  host_sends_keyframe(h.session_id);
  EXPECT_EQ(peer(v.session_id).peer->video.size(), 1u);
}
