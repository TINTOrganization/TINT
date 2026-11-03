#include "rtp/rtcp.hpp"

#include <gtest/gtest.h>

#include "support/rtp_builder.hpp"

using namespace stream::rtp;
using stream::testing::put16;
using stream::testing::put32;

namespace {

Bytes header(std::uint8_t count_or_fmt, std::uint8_t pt, std::uint16_t words) {
  Bytes b{static_cast<std::uint8_t>(0x80 | count_or_fmt), pt};
  put16(b, words);
  return b;
}

Bytes report_block(std::uint32_t ssrc, std::uint8_t fraction) {
  Bytes b;
  put32(b, ssrc);
  b.push_back(fraction);
  b.insert(b.end(), 19, 0);  // pérdidas acumuladas, seq más alto, jitter, LSR, DLSR
  return b;
}

Bytes receiver_report(std::uint32_t sender, std::uint32_t media, std::uint8_t fraction) {
  Bytes b = header(1, 201, 7);
  put32(b, sender);
  auto rb = report_block(media, fraction);
  b.insert(b.end(), rb.begin(), rb.end());
  return b;
}

Bytes sender_report(std::uint32_t ssrc, std::uint64_t ntp, std::uint32_t rtp_ts) {
  Bytes b = header(0, 200, 6);
  put32(b, ssrc);
  put32(b, static_cast<std::uint32_t>(ntp >> 32));
  put32(b, static_cast<std::uint32_t>(ntp));
  put32(b, rtp_ts);
  put32(b, 10);   // paquetes
  put32(b, 100);  // octetos
  return b;
}

}  // namespace

TEST(Rtcp, ParsesCompoundSrRr) {
  auto sr = sender_report(0x10, 0x0102030405060708ULL, 90000);
  auto rr = receiver_report(0x20, 0x30, 64);
  Bytes compound(sr);
  compound.insert(compound.end(), rr.begin(), rr.end());
  auto info = parse_rtcp(compound);
  ASSERT_TRUE(info);
  ASSERT_EQ(info->sender_reports.size(), 1u);
  EXPECT_EQ(info->sender_reports[0].ssrc, 0x10u);
  EXPECT_EQ(info->sender_reports[0].ntp, 0x0102030405060708ULL);
  EXPECT_EQ(info->sender_reports[0].rtp_timestamp, 90000u);
  ASSERT_EQ(info->reports.size(), 1u);
}

TEST(Rtcp, ExtractsFractionLostPerSsrc) {
  auto info = parse_rtcp(receiver_report(1, 0xAAAA, 26));
  ASSERT_TRUE(info);
  ASSERT_EQ(info->reports.size(), 1u);
  EXPECT_EQ(info->reports[0].ssrc, 0xAAAAu);
  EXPECT_EQ(info->reports[0].fraction_lost, 26);  // ~10 %
}

TEST(Rtcp, ParsesGenericNackPidBlp) {
  // PID = 100, BLP = 0b1000000000000101 -> 100, 101, 103, 116
  Bytes b = header(1, 205, 3);
  put32(b, 1);
  put32(b, 0xBEEF);
  put16(b, 100);
  put16(b, 0x8005);
  auto info = parse_rtcp(b);
  ASSERT_TRUE(info);
  ASSERT_EQ(info->nacks.size(), 1u);
  EXPECT_EQ(info->nacks[0].media_ssrc, 0xBEEFu);
  EXPECT_EQ(info->nacks[0].sequences, (std::vector<std::uint16_t>{100, 101, 103, 116}));
}

TEST(Rtcp, NackHandlesSequenceWrap) {
  Bytes b = header(1, 205, 3);
  put32(b, 1);
  put32(b, 2);
  put16(b, 65535);
  put16(b, 0x0001);
  auto info = parse_rtcp(b);
  ASSERT_TRUE(info);
  EXPECT_EQ(info->nacks[0].sequences, (std::vector<std::uint16_t>{65535, 0}));
}

TEST(Rtcp, ParsesPliAndFir) {
  auto pli = build_pli(1, 0x1234);
  Bytes fir = header(4, 206, 4);
  put32(fir, 1);
  put32(fir, 0);
  put32(fir, 0x5678);      // FCI: SSRC
  put32(fir, 0x01000000);  // seq
  Bytes compound(pli);
  compound.insert(compound.end(), fir.begin(), fir.end());
  auto info = parse_rtcp(compound);
  ASSERT_TRUE(info);
  EXPECT_EQ(info->keyframe_requests, (std::vector<std::uint32_t>{0x1234, 0x5678}));
}

TEST(Rtcp, ParsesRembBitrateMantissaExponent) {
  // 2.5 Mbps: exp=4, mantissa=156250
  std::vector<std::uint32_t> ssrcs{0x11, 0x22};
  auto remb = build_remb(1, 2'500'000, ssrcs);
  auto info = parse_rtcp(remb);
  ASSERT_TRUE(info);
  ASSERT_TRUE(info->remb);
  EXPECT_EQ(info->remb->bitrate_bps, 2'500'000u);
  EXPECT_EQ(info->remb->ssrcs, ssrcs);
}

TEST(Rtcp, BuildsRembForLargeBitrateWithinMantissaPrecision) {
  std::vector<std::uint32_t> one{0x1};
  auto info = parse_rtcp(build_remb(1, 300'000'000, one));
  ASSERT_TRUE(info);
  EXPECT_LE(info->remb->bitrate_bps, 300'000'000u);
  EXPECT_GT(info->remb->bitrate_bps, 299'000'000u);
}

TEST(Rtcp, BuildsRembWireFormatForTheHost) {
  // draft-alvestrand-rmcat-remb: PSFB (206) FMT=15, media SSRC 0, "REMB", Num SSRC, Exp(6)/Mantissa(18).
  // 4.26 Mbps = 133125 × 2^5 (exacto en 18 bits de mantisa).
  std::vector<std::uint32_t> ssrcs{0x10, 0x20, 0x30};
  auto b = build_remb(0xABCD, 4'260'000, ssrcs);
  const Bytes expected{0x8F,
                       206,
                       0x00,
                       0x07,  // V=2 FMT=15, 8 palabras
                       0x00,
                       0x00,
                       0xAB,
                       0xCD,
                       0x00,
                       0x00,
                       0x00,
                       0x00,  // emisor, medio = 0
                       'R',
                       'E',
                       'M',
                       'B',
                       0x03,  // 3 SSRC
                       (5 << 2) | 0x02,
                       0x08,
                       0x05,  // exp 5, mantisa 0x20805
                       0x00,
                       0x00,
                       0x00,
                       0x10,
                       0x00,
                       0x00,
                       0x00,
                       0x20,
                       0x00,
                       0x00,
                       0x00,
                       0x30};
  EXPECT_EQ(b, expected);
  auto info = parse_rtcp(b);
  ASSERT_TRUE(info && info->remb);
  EXPECT_EQ(info->remb->bitrate_bps, 4'260'000u);
}

TEST(Rtcp, BuildsNackRoundTrip) {
  std::vector<std::uint16_t> seqs{10, 11, 26, 27, 100};
  auto info = parse_rtcp(build_nack(1, 0x99, seqs));
  ASSERT_TRUE(info);
  ASSERT_EQ(info->nacks.size(), 1u);
  EXPECT_EQ(info->nacks[0].sequences, seqs);
}

TEST(Rtcp, BuildsPliForMediaSsrc) {
  auto pli = build_pli(0xAAAA, 0xBBBB);
  ASSERT_EQ(pli.size(), 12u);
  EXPECT_EQ(pli[0], 0x81);
  EXPECT_EQ(pli[1], 206);
}

TEST(Rtcp, IgnoresUnknownPacketTypes) {
  Bytes sdes = header(0, 202, 1);
  put32(sdes, 0);
  Bytes bye = header(1, 203, 1);
  put32(bye, 7);
  Bytes compound(sdes);
  compound.insert(compound.end(), bye.begin(), bye.end());
  auto info = parse_rtcp(compound);
  ASSERT_TRUE(info);
  EXPECT_TRUE(info->reports.empty());
}

TEST(Rtcp, RejectsTruncatedLength) {
  auto rr = receiver_report(1, 2, 3);
  EXPECT_FALSE(parse_rtcp(ByteView(rr).first(rr.size() - 4)));
  EXPECT_FALSE(parse_rtcp(ByteView{}));
  Bytes bad = header(1, 201, 1);  // dice tener un report block pero no cabe
  put32(bad, 1);
  EXPECT_FALSE(parse_rtcp(bad));
  Bytes wrong_version{0x40, 201, 0, 1, 0, 0, 0, 1};
  EXPECT_FALSE(parse_rtcp(wrong_version));
}
