// Ciclo de vida de la transmisión (HU-LIVE-05). La gracia del host es de 60 s.
#include "sfu/stream_state.hpp"

#include <gtest/gtest.h>

using namespace stream::sfu;
using namespace std::chrono_literals;

namespace {
constexpr std::int64_t kGraceMs = 60'000;
StreamState make() { return StreamState(60s); }
}  // namespace

TEST(StreamState, StartsWaiting) {
  auto s = make();
  EXPECT_EQ(s.state(), State::Waiting);
  EXPECT_EQ(to_string(s.state()), "waiting");
  EXPECT_FALSE(s.grace_deadline_ms());
}

TEST(StreamState, IdleToLiveOnFirstHostKeyframe) {
  auto s = make();
  auto e = s.on_host_publish(1000);
  EXPECT_EQ(s.state(), State::Waiting) << "hasta el primer keyframe no hay imagen";
  EXPECT_TRUE(e.request_keyframe);
  e = s.on_host_rtp(1100, /*keyframe=*/false);
  EXPECT_EQ(s.state(), State::Waiting);
  e = s.on_host_rtp(1200, /*keyframe=*/true);
  EXPECT_EQ(s.state(), State::Live);
  EXPECT_TRUE(e.notify_state);
  EXPECT_TRUE(e.publish_stream_started);
}

TEST(StreamState, StreamStartedEmittedOnlyOnFirstLive) {
  auto s = make();
  s.on_host_publish(0);
  EXPECT_TRUE(s.on_host_rtp(10, true).publish_stream_started);
  EXPECT_FALSE(s.on_host_rtp(20, true).publish_stream_started);
  s.on_host_lost(30);
  s.on_host_publish(40);
  EXPECT_FALSE(s.on_host_rtp(50, true).publish_stream_started) << "una reconexión no reinicia el reloj";
}

TEST(StreamState, HostLostEntersGraceAndNotifiesReconnecting) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(10, true);
  auto e = s.on_host_lost(5'000);
  EXPECT_EQ(s.state(), State::HostGrace);
  EXPECT_EQ(to_string(s.state()), "reconnecting");
  EXPECT_TRUE(e.notify_state);
  EXPECT_FALSE(e.teardown) << "los viewers se conservan durante la gracia";
  EXPECT_EQ(s.grace_deadline_ms(), 5'000 + kGraceMs);
}

TEST(StreamState, HostRepublishWithinGraceReturnsLive) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(10, true);
  s.on_host_lost(1'000);
  EXPECT_FALSE(s.on_tick(1'000 + kGraceMs - 1).request_disable);
  auto e = s.on_host_publish(1'000 + kGraceMs - 1);
  EXPECT_EQ(s.state(), State::Live);
  EXPECT_TRUE(e.notify_state);
  EXPECT_TRUE(e.request_keyframe) << "los viewers necesitan un keyframe del nuevo host";
  EXPECT_FALSE(s.grace_deadline_ms());
  EXPECT_FALSE(s.on_tick(1'000 + 2 * kGraceMs).request_disable);
}

TEST(StreamState, GraceExpiryAfter60sEmitsDisableRoomOnce) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(10, true);
  s.on_host_lost(1'000);
  auto e = s.on_tick(1'000 + kGraceMs);
  EXPECT_EQ(s.state(), State::Ended);
  EXPECT_EQ(s.end_reason(), EndReason::GraceExpired);
  EXPECT_TRUE(e.request_disable);
  EXPECT_TRUE(e.teardown);
  EXPECT_TRUE(e.notify_state);
  auto again = s.on_tick(1'000 + kGraceMs + 500);
  EXPECT_FALSE(again.request_disable);
  EXPECT_FALSE(again.teardown);
}

TEST(StreamState, RepublishAfterExpiryRejected) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_lost(1);
  s.on_tick(1 + kGraceMs);
  auto e = s.on_host_publish(2 + kGraceMs);
  EXPECT_TRUE(e.rejected);
  EXPECT_EQ(s.state(), State::Ended);
}

TEST(StreamState, RoomClosedEndsFromAnyState) {
  for (int start = 0; start < 3; ++start) {
    auto s = make();
    if (start >= 1) {
      s.on_host_publish(0);
      s.on_host_rtp(1, true);
    }
    if (start == 2) s.on_host_lost(2);
    auto e = s.on_room_closed();
    EXPECT_EQ(s.state(), State::Ended);
    EXPECT_EQ(s.end_reason(), EndReason::HostEnded);
    EXPECT_TRUE(e.teardown);
    EXPECT_FALSE(e.request_disable) << "identity-api ya la deshabilitó";
    EXPECT_FALSE(s.on_room_closed().teardown) << "idempotente";
  }
}

TEST(StreamState, RoomClosedKeepsTheReasonOfTheMessage) {
  auto s = make();
  s.on_room_closed(EndReason::GraceExpired);
  EXPECT_EQ(s.end_reason(), EndReason::GraceExpired);
  s.on_room_closed(EndReason::HostEnded);
  EXPECT_EQ(s.end_reason(), EndReason::GraceExpired) << "el primer cierre manda";
}

TEST(StreamState, EndReasonNames) {
  EXPECT_EQ(to_string(EndReason::HostEnded), "host_ended");
  EXPECT_EQ(to_string(EndReason::GraceExpired), "grace_expired");
  EXPECT_EQ(parse_end_reason("grace_expired"), EndReason::GraceExpired);
  EXPECT_EQ(parse_end_reason("host_ended"), EndReason::HostEnded);
  EXPECT_EQ(parse_end_reason("room_closed"), std::nullopt);
}

TEST(StreamState, MediaWatchdog3sTriggersHostLost) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(100, true);
  s.on_host_rtp(2'000, false);
  EXPECT_EQ(s.on_tick(4'999).notify_state, false);
  EXPECT_EQ(s.state(), State::Live);
  auto e = s.on_tick(5'001);
  EXPECT_EQ(s.state(), State::HostGrace);
  EXPECT_TRUE(e.notify_state);
  EXPECT_EQ(s.grace_deadline_ms(), 5'001 + kGraceMs);
}

TEST(StreamState, HostThatNeverSentMediaGoesToGraceAfterTimeout) {
  auto s = make();
  s.on_host_publish(0);
  EXPECT_EQ(s.state(), State::Waiting);
  s.on_tick(3'001);
  EXPECT_EQ(s.state(), State::HostGrace);
}

TEST(StreamState, WaitingWithoutHostDoesNotExpire) {
  // Los viewers pueden llegar antes que el host: la sala espera sin gracia.
  auto s = make();
  EXPECT_FALSE(s.on_tick(10 * kGraceMs).request_disable);
  EXPECT_EQ(s.state(), State::Waiting);
}

TEST(StreamState, HostLostWhileAlreadyInGraceKeepsDeadline) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(1, true);
  s.on_host_lost(1'000);
  auto e = s.on_host_lost(30'000);
  EXPECT_FALSE(e.notify_state);
  EXPECT_EQ(s.grace_deadline_ms(), 1'000 + kGraceMs);
}

TEST(StreamState, RtpWithoutHostIsIgnored) {
  auto s = make();
  EXPECT_FALSE(s.on_host_rtp(1, true).publish_stream_started);
  EXPECT_EQ(s.state(), State::Waiting);
}

TEST(StreamState, StateNames) {
  EXPECT_EQ(to_string(State::Live), "live");
  EXPECT_EQ(to_string(State::Ended), "ended");
}

// Un parón de media (CPU del host saturada, pestaña en segundo plano, arranque lento del
// codificador) no es una desconexión: si la misma sesión vuelve a mandar RTP, la gracia se
// cancela. Antes la sala se quedaba en "reconnecting" y se deshabilitaba a los 60 s aunque el
// host siguiera transmitiendo (E2E por el gateway, 2026-11-02).
TEST(StreamState, MediaStallRecoversWhenRtpResumesOnTheSameSession) {
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(100, true);
  s.on_tick(5'001);
  ASSERT_EQ(s.state(), State::HostGrace);
  auto e = s.on_host_rtp(6'000, /*keyframe=*/false);
  EXPECT_EQ(s.state(), State::Live);
  EXPECT_TRUE(e.notify_state);
  EXPECT_TRUE(e.request_keyframe) << "los viewers se resincronizan con un keyframe";
  EXPECT_FALSE(e.publish_stream_started) << "no reinicia el reloj de la trivia";
  EXPECT_FALSE(s.grace_deadline_ms());
  EXPECT_FALSE(s.on_tick(5'001 + kGraceMs).request_disable);
}

TEST(StreamState, SlowStartRecoversFromGraceOnFirstKeyframe) {
  auto s = make();
  s.on_host_publish(0);
  s.on_tick(3'001);
  ASSERT_EQ(s.state(), State::HostGrace);
  auto e = s.on_host_rtp(5'000, /*keyframe=*/true);
  EXPECT_EQ(s.state(), State::Live);
  EXPECT_TRUE(e.notify_state);
  EXPECT_TRUE(e.publish_stream_started);
}

TEST(StreamState, SlowStartWithoutKeyframeGoesBackToWaiting) {
  auto s = make();
  s.on_host_publish(0);
  s.on_tick(3'001);
  auto e = s.on_host_rtp(5'000, /*keyframe=*/false);
  EXPECT_EQ(s.state(), State::Waiting) << "sin keyframe todavía no hay imagen";
  EXPECT_TRUE(e.notify_state);
  EXPECT_TRUE(e.request_keyframe);
  EXPECT_FALSE(s.on_tick(5'001 + kGraceMs).request_disable);
  EXPECT_EQ(s.on_host_rtp(5'100, true).publish_stream_started, true);
  EXPECT_EQ(s.state(), State::Live);
}

TEST(StreamState, RtpAfterHostConnectionLostStaysInGrace) {
  // La PeerConnection del host se cerró: solo un WHIP nuevo lo devuelve (paquetes rezagados no).
  auto s = make();
  s.on_host_publish(0);
  s.on_host_rtp(1, true);
  s.on_host_lost(1'000);
  EXPECT_FALSE(s.on_host_rtp(1'100, true).notify_state);
  EXPECT_EQ(s.state(), State::HostGrace);
}
