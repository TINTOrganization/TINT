// Continuidad hacia el viewer entre capas y entre hosts (HU-LIVE-02 AC3, HU-LIVE-05 AC3).
#include "sfu/rtp_rewriter.hpp"

#include <gtest/gtest.h>

#include "rtp/vp8.hpp"
#include "support/rtp_builder.hpp"

using namespace stream::sfu;
using namespace stream::rtp;
using namespace stream::testing;

namespace {

constexpr std::uint32_t kOutSsrc = 0x5000;
constexpr int kAbsSendTime = 2;
constexpr std::uint32_t kL = 0x10, kM = 0x20, kH = 0x30;  // SSRC de cada capa del host

// Paquete VP8 de una capa del host.
struct Src {
  std::uint32_t ssrc;
  std::uint16_t seq;
  std::uint32_t ts;
  bool keyframe = false;
  std::uint16_t picture_id = 1;
  std::uint8_t tl0 = 1;
};

Bytes vp8_packet(const Src& s) {
  return build_rtp({.pt = 96,
                    .seq = s.seq,
                    .ts = s.ts,
                    .ssrc = s.ssrc,
                    .extensions = {{4, "h"}, {kAbsSendTime, "abc"}},
                    .payload = build_vp8_payload(
                        {.keyframe = s.keyframe, .picture_id = s.picture_id, .tl0picidx = s.tl0})});
}

RtpRewriter make(bool vp8 = true) {
  return RtpRewriter({.out_ssrc = kOutSsrc,
                      .out_payload_type = 100,
                      .first_seq = 1000,
                      .first_timestamp = 50'000,
                      .clock_rate = 90000,
                      .vp8 = vp8,
                      .extensions = {{kAbsSendTime, 3}}});
}

struct Out {
  std::uint16_t seq;
  std::uint32_t ts;
  std::uint16_t picture_id;
};

std::optional<Out> send(RtpRewriter& r, const Src& s, int layer, std::int64_t now) {
  auto p = vp8_packet(s);
  auto v = parse_rtp(p);
  auto out = r.rewrite(p, *v, layer, s.keyframe, now);
  if (!out) return std::nullopt;
  auto ov = parse_rtp(*out);
  EXPECT_TRUE(ov);
  EXPECT_EQ(ov->ssrc, kOutSsrc);
  EXPECT_EQ(ov->payload_type, 100);
  auto d = parse_vp8(std::span(*out).subspan(ov->payload_offset, ov->payload_size));
  return Out{ov->seq, ov->timestamp, d && d->picture_id ? *d->picture_id : std::uint16_t{0}};
}

}  // namespace

TEST(RtpRewriter, WaitsForKeyframeOfTargetBeforeSending) {
  auto r = make();
  r.set_target(0);
  EXPECT_FALSE(send(r, {kL, 10, 900}, 0, 0));
  EXPECT_FALSE(send(r, {kH, 50, 9000, true}, 2, 0)) << "keyframe de otra capa";
  auto out = send(r, {kL, 11, 1800, true}, 0, 0);
  ASSERT_TRUE(out);
  EXPECT_FALSE(r.current() == std::nullopt);
}

TEST(RtpRewriter, FirstPacketStartsAtConfiguredSeqAndTs) {
  auto r = make();
  auto out = send(r, {0xA, 500, 123'456, true}, 0, 0);
  ASSERT_TRUE(out);
  EXPECT_EQ(out->seq, 1000);
  EXPECT_EQ(out->ts, 50'000u);
  auto next = send(r, {0xA, 501, 123'456 + 3000}, 0, 33);
  EXPECT_EQ(next->seq, 1001);
  EXPECT_EQ(next->ts, 53'000u);
}

TEST(RtpRewriter, UsesOwnSsrcPayloadTypeAndExtensionIds) {
  auto r = make();
  auto p = vp8_packet({0xA, 1, 1, true});
  auto out = r.rewrite(p, *parse_rtp(p), 0, true, 0);
  ASSERT_TRUE(out);
  auto v = parse_rtp(*out);
  EXPECT_FALSE(find_extension(*out, *v, 4)) << "el rid del host no se reenvía";
  auto abs = find_extension(*out, *v, 3);
  ASSERT_TRUE(abs);
  EXPECT_EQ(std::string(abs->begin(), abs->end()), "abc");
}

TEST(RtpRewriter, SourceGapsArePreserved) {
  auto r = make();
  send(r, {0xA, 10, 0, true}, 0, 0);
  auto out = send(r, {0xA, 13, 3000}, 0, 10);  // se perdieron 11 y 12: el viewer pedirá NACK
  EXPECT_EQ(out->seq, 1003);
}

TEST(RtpRewriter, SequenceIsContiguousAcrossLayerSwitch) {
  auto r = make();
  send(r, {kL, 10, 1000, true, 7}, 0, 0);
  send(r, {kL, 11, 4000, false, 8}, 0, 33);
  r.set_target(2);
  EXPECT_TRUE(send(r, {kL, 12, 7000, false, 9}, 0, 66)) << "sigue con l hasta el keyframe de h";
  EXPECT_FALSE(send(r, {kH, 900, 7000, false, 300}, 2, 66));
  auto sw = send(r, {kH, 901, 10'000, true, 301}, 2, 100);
  ASSERT_TRUE(sw);
  EXPECT_EQ(sw->seq, 1003);
  EXPECT_EQ(sw->picture_id, 10) << "PictureID continúa";
  EXPECT_EQ(r.current(), 2);
  EXPECT_FALSE(send(r, {kL, 13, 10'000, false, 10}, 0, 100)) << "la capa vieja ya no se reenvía";
  auto next = send(r, {kH, 902, 13'000, false, 302}, 2, 133);
  EXPECT_EQ(next->seq, 1004);
  EXPECT_EQ(next->picture_id, 11);
}

TEST(RtpRewriter, TimestampMonotonicAcrossSwitchUsingWallclockDelta) {
  auto r = make();
  auto a = send(r, {kL, 10, 1'000'000, true}, 0, 1000);
  r.set_target(1);
  auto b = send(r, {kM, 1, 7, true}, 1, 1100);  // reloj RTP de la otra capa: arbitrario
  ASSERT_TRUE(a && b);
  EXPECT_EQ(b->ts - a->ts, 9000u) << "100 ms a 90 kHz";
}

TEST(RtpRewriter, SwitchOnlyAppliedOnKeyframeOfTargetLayer) {
  auto r = make();
  send(r, {kL, 1, 0, true}, 0, 0);
  r.set_target(1);
  EXPECT_FALSE(send(r, {kH, 1, 0, true}, 2, 1)) << "keyframe de una capa que no es el objetivo";
  EXPECT_EQ(r.current(), 0);
}

TEST(RtpRewriter, HandlesSeqWrapAt65535) {
  auto r = RtpRewriter({.out_ssrc = 1, .out_payload_type = 100, .first_seq = 65534, .first_timestamp = 0});
  auto p1 = vp8_packet({0xA, 10, 0, true});
  auto p2 = vp8_packet({0xA, 11, 0});
  auto p3 = vp8_packet({0xA, 12, 0});
  EXPECT_EQ(parse_rtp(*r.rewrite(p1, *parse_rtp(p1), 0, true, 0))->seq, 65534);
  EXPECT_EQ(parse_rtp(*r.rewrite(p2, *parse_rtp(p2), 0, false, 0))->seq, 65535);
  EXPECT_EQ(parse_rtp(*r.rewrite(p3, *parse_rtp(p3), 0, false, 0))->seq, 0);
}

TEST(RtpRewriter, HandlesTsWrapAt2Pow32) {
  auto r =
      RtpRewriter({.out_ssrc = 1, .out_payload_type = 100, .first_seq = 0, .first_timestamp = 0xFFFFFF00});
  auto p1 = vp8_packet({0xA, 1, 100, true});
  auto p2 = vp8_packet({0xA, 2, 100 + 3000});
  r.rewrite(p1, *parse_rtp(p1), 0, true, 0);
  EXPECT_EQ(parse_rtp(*r.rewrite(p2, *parse_rtp(p2), 0, false, 33))->timestamp, 3000u - 0x100u);
}

TEST(RtpRewriter, ReverseMapsNackSeqWithinCurrentEpoch) {
  auto r = make();
  send(r, {kL, 10, 0, true}, 0, 0);
  send(r, {kL, 11, 0}, 0, 0);
  auto src = r.source_of(1001);
  ASSERT_TRUE(src);
  EXPECT_EQ(src->layer, 0);
  EXPECT_EQ(src->seq, 11);
}

TEST(RtpRewriter, ReverseMapsNackSeqInPreviousEpoch) {
  auto r = make();
  send(r, {kL, 10, 0, true}, 0, 0);
  send(r, {kL, 11, 0}, 0, 0);
  r.set_target(2);
  send(r, {kH, 500, 0, true}, 2, 10);  // out 1002
  auto old = r.source_of(1001);
  ASSERT_TRUE(old);
  EXPECT_EQ(old->layer, 0);
  EXPECT_EQ(old->seq, 11);
  auto now = r.source_of(1002);
  EXPECT_EQ(now->layer, 2);
  EXPECT_EQ(now->seq, 500);
}

TEST(RtpRewriter, NackBeforeFirstEpochIsUnmappable) {
  auto r = make();
  EXPECT_FALSE(r.source_of(1000));
  send(r, {kL, 10, 0, true}, 0, 0);
  EXPECT_FALSE(r.source_of(999));
}

TEST(RtpRewriter, RetransmissionRewritesWithEpochOffsets) {
  auto r = make();
  send(r, {kL, 10, 5000, true, 40}, 0, 0);
  auto lost = vp8_packet({kL, 11, 8000, false, 41});
  send(r, {kL, 11, 8000, false, 41}, 0, 33);
  auto rtx = r.retransmission(lost, 1001);
  ASSERT_TRUE(rtx);
  auto v = parse_rtp(*rtx);
  EXPECT_EQ(v->seq, 1001);
  EXPECT_EQ(v->ssrc, kOutSsrc);
  EXPECT_EQ(v->timestamp, 53'000u);
}

TEST(RtpRewriter, HostReplaceKeepsViewerContinuity) {
  auto r = make();
  r.set_target(2);
  ASSERT_TRUE(send(r, {0xA, 10, 0, true, 5}, 2, 0));
  ASSERT_TRUE(send(r, {0xA, 11, 3000, false, 6}, 2, 33));
  r.resync();  // nuevo WHIP: nuevos SSRC, seq y timestamps
  EXPECT_FALSE(send(r, {0xB, 7, 777, false, 900}, 2, 1000)) << "espera el keyframe del nuevo host";
  auto out = send(r, {0xB, 8, 888, true, 901}, 2, 1033);
  ASSERT_TRUE(out);
  EXPECT_EQ(out->seq, 1002);
  EXPECT_EQ(out->picture_id, 7);
}

TEST(RtpRewriter, AudioSwitchesOnAnyPacket) {
  auto r = RtpRewriter({.out_ssrc = 9,
                        .out_payload_type = 109,
                        .first_seq = 1,
                        .first_timestamp = 0,
                        .clock_rate = 48000,
                        .vp8 = false});
  auto a = build_rtp({.pt = 111, .seq = 100, .ts = 960, .ssrc = 0xAA});
  auto out = r.rewrite(a, *parse_rtp(a), 0, false, 0);
  ASSERT_TRUE(out);
  EXPECT_EQ(parse_rtp(*out)->payload_type, 109);
  r.resync();
  auto b = build_rtp({.pt = 111, .seq = 5, .ts = 10, .ssrc = 0xBB});
  auto out2 = r.rewrite(b, *parse_rtp(b), 0, false, 20);
  ASSERT_TRUE(out2);
  EXPECT_EQ(parse_rtp(*out2)->seq, 2);
  EXPECT_EQ(parse_rtp(*out2)->timestamp, 960u) << "20 ms a 48 kHz";
}
