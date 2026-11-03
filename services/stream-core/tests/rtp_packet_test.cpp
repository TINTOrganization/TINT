#include "rtp/packet.hpp"

#include <gtest/gtest.h>

#include "support/rtp_builder.hpp"

using namespace stream::rtp;
using namespace stream::testing;

TEST(RtpPacket, ParsesFixedHeaderAndCsrcs) {
  auto pkt = build_rtp({.pt = 96,
                        .marker = true,
                        .seq = 65000,
                        .ts = 0xDEADBEEF,
                        .ssrc = 0xCAFEBABE,
                        .csrcs = {1, 2},
                        .payload = {1, 2, 3}});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  EXPECT_EQ(v->payload_type, 96);
  EXPECT_TRUE(v->marker);
  EXPECT_EQ(v->seq, 65000);
  EXPECT_EQ(v->timestamp, 0xDEADBEEFu);
  EXPECT_EQ(v->ssrc, 0xCAFEBABEu);
  EXPECT_EQ(v->payload_offset, 12u + 8u);
  EXPECT_EQ(v->payload_size, 3u);
}

TEST(RtpPacket, ReadsOneByteExtensionById) {
  auto pkt = build_rtp({.extensions = {{4, "h"}, {1, "0"}}});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  auto rid = find_extension(pkt, *v, 4);
  ASSERT_TRUE(rid);
  EXPECT_EQ(std::string(rid->begin(), rid->end()), "h");
  EXPECT_EQ(std::string(find_extension(pkt, *v, 1)->begin(), find_extension(pkt, *v, 1)->end()), "0");
  EXPECT_FALSE(find_extension(pkt, *v, 9));
  EXPECT_EQ(v->payload_size, 2u);
}

TEST(RtpPacket, ReadsTwoByteExtensionById) {
  auto pkt = build_rtp({.extensions = {{20, "mid"}, {4, "l"}}, .two_byte_extensions = true});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  auto ext = find_extension(pkt, *v, 4);
  ASSERT_TRUE(ext);
  EXPECT_EQ(std::string(ext->begin(), ext->end()), "l");
  EXPECT_EQ(std::string(find_extension(pkt, *v, 20)->begin(), find_extension(pkt, *v, 20)->end()), "mid");
}

TEST(RtpPacket, PaddingIsExcludedFromPayload) {
  auto pkt = build_rtp({.payload = {9, 9, 9}, .padding = 4});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  EXPECT_EQ(v->payload_size, 3u);
}

TEST(RtpPacket, RejectsPaddingLongerThanPacket) {
  auto pkt = build_rtp({.payload = {1}});
  pkt[0] |= 0x20;
  pkt.back() = 200;
  EXPECT_FALSE(parse_rtp(pkt));
}

TEST(RtpPacket, RejectsVersionOtherThan2AndTruncated) {
  auto pkt = build_rtp({});
  pkt[0] = (pkt[0] & 0x3F) | 0x40;
  EXPECT_FALSE(parse_rtp(pkt));
  auto good = build_rtp({.csrcs = {1, 2, 3}});
  EXPECT_FALSE(parse_rtp(ByteView(good).first(14)));
  auto ext = build_rtp({.extensions = {{4, "h"}}});
  EXPECT_FALSE(parse_rtp(ByteView(ext).first(15)));
  EXPECT_FALSE(parse_rtp(ByteView{}));
}

TEST(RtpPacket, DetectsRtcpByPayloadType) {
  std::vector<std::uint8_t> rr{0x81, 201, 0, 7, 0, 0, 0, 1};
  EXPECT_TRUE(looks_like_rtcp(rr));
  EXPECT_FALSE(looks_like_rtcp(build_rtp({.pt = 96})));
  EXPECT_FALSE(looks_like_rtcp(build_rtp({.pt = 111, .marker = true})));
  EXPECT_FALSE(looks_like_rtcp(ByteView{}));
}

TEST(RtpPacket, InPlaceSetters) {
  auto pkt = build_rtp({.pt = 96, .marker = true, .seq = 1, .ts = 2, .ssrc = 3});
  set_payload_type(pkt, 100);
  set_sequence(pkt, 4000);
  set_timestamp(pkt, 123456789);
  set_ssrc(pkt, 0xABCDEF01);
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  EXPECT_EQ(v->payload_type, 100);
  EXPECT_TRUE(v->marker) << "cambiar el PT conserva la marca";
  EXPECT_EQ(v->seq, 4000);
  EXPECT_EQ(v->timestamp, 123456789u);
  EXPECT_EQ(v->ssrc, 0xABCDEF01u);
}

TEST(RtpPacket, RewriteExtensionsKeepsOnlyRequestedWithNewIds) {
  auto pkt = build_rtp({.extensions = {{4, "h"}, {2, "abc"}, {3, "zz"}}, .payload = {7, 8, 9}});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  auto out = rewrite_extensions(pkt, *v, {{2, 5}});
  auto ov = parse_rtp(out);
  ASSERT_TRUE(ov);
  EXPECT_FALSE(find_extension(out, *ov, 4)) << "el rid no se reenvía";
  auto abs = find_extension(out, *ov, 5);
  ASSERT_TRUE(abs);
  EXPECT_EQ(std::string(abs->begin(), abs->end()), "abc");
  EXPECT_EQ(ov->payload_size, 3u);
  EXPECT_EQ(out[ov->payload_offset], 7);
}

TEST(RtpPacket, StripExtensionsKeepsPayloadIntact) {
  auto pkt =
      build_rtp({.marker = true, .seq = 9, .extensions = {{4, "h"}}, .payload = {1, 2, 3, 4}, .padding = 2});
  auto v = parse_rtp(pkt);
  ASSERT_TRUE(v);
  auto out = rewrite_extensions(pkt, *v, {});
  auto ov = parse_rtp(out);
  ASSERT_TRUE(ov);
  EXPECT_EQ(ov->extension_size, 0u);
  EXPECT_EQ(out[0] & 0x30, 0) << "sin bit X ni padding";
  EXPECT_EQ(ov->seq, 9);
  EXPECT_TRUE(ov->marker);
  EXPECT_EQ(std::vector<std::uint8_t>(out.begin() + ov->payload_offset, out.end()),
            (std::vector<std::uint8_t>{1, 2, 3, 4}));
}
