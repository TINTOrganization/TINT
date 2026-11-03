#include "sdp/offer_inspect.hpp"

#include <gtest/gtest.h>

#include "support/sdp_fixtures.hpp"

using namespace stream::sdp;
using namespace stream::testing;

TEST(OfferInspect, ParsesChromeWhipVideoOffer) {
  auto offer = parse_offer(kChromeWhipVideoOffer);
  ASSERT_TRUE(offer);
  ASSERT_EQ(offer->media.size(), 2u);
  const auto* video = offer->first("video");
  ASSERT_NE(video, nullptr);
  EXPECT_EQ(video->mid, "0");
  EXPECT_EQ(video->direction, Direction::SendOnly);
  EXPECT_EQ(video->payload_type_of("vp8"), 96);
  EXPECT_EQ(video->payload_type_of("h264"), 98);
  EXPECT_EQ(video->send_rids, (std::vector<std::string>{"h", "m", "l"}));
  EXPECT_EQ(video->extmaps.at(std::string(kRidExtension)), 4);
  EXPECT_EQ(video->extmaps.at(std::string(kAbsSendTimeExtension)), 2);
  EXPECT_EQ(offer->count("application"), 1);
}

TEST(OfferInspect, CodecNamesAreCaseInsensitive) {
  auto offer = parse_offer(kChromeWhipAudioOffer);
  ASSERT_TRUE(offer);
  const auto* audio = offer->first("audio");
  ASSERT_NE(audio, nullptr);
  EXPECT_EQ(audio->payload_type_of("opus"), 111);
  EXPECT_EQ(audio->payload_type_of("OPUS"), 111);
  EXPECT_EQ(audio->payload_type_of("pcmu"), 0);
  EXPECT_FALSE(audio->payload_type_of("vp8"));
}

TEST(OfferInspect, ParsesRecvonlyWhepOffer) {
  auto offer = parse_offer(kChromeWhepOffer);
  ASSERT_TRUE(offer);
  EXPECT_EQ(offer->first("video")->direction, Direction::RecvOnly);
  EXPECT_EQ(offer->first("audio")->direction, Direction::RecvOnly);
  EXPECT_TRUE(offer->first("video")->send_rids.empty());
}

TEST(OfferInspect, AcceptsBareLineFeeds) {
  std::string lf = kChromeWhipAudioOffer;
  std::erase(lf, '\r');
  auto offer = parse_offer(lf);
  ASSERT_TRUE(offer);
  EXPECT_EQ(offer->first("audio")->payload_type_of("opus"), 111);
}

TEST(OfferInspect, RejectsGarbage) {
  EXPECT_FALSE(parse_offer(""));
  EXPECT_FALSE(parse_offer("hola"));
  EXPECT_FALSE(parse_offer("v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"));   // sin m=
  EXPECT_FALSE(parse_offer("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"));  // sin v=0
}

TEST(OfferInspect, IgnoresMalformedAttributeLines) {
  const std::string sdp =
      "v=0\r\n"
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
      "a=rtpmap:abc VP8/90000\r\n"
      "a=rtpmap:96\r\n"
      "a=extmap:x urn:foo\r\n"
      "a=rid:\r\n"
      "a=rtpmap:96 VP8/90000\r\n";
  auto offer = parse_offer(sdp);
  ASSERT_TRUE(offer);
  EXPECT_EQ(offer->first("video")->payload_type_of("vp8"), 96);
  EXPECT_TRUE(offer->first("video")->extmaps.empty());
  EXPECT_TRUE(offer->first("video")->send_rids.empty());
}

TEST(OfferInspect, IgnoresRecvRidsAndExtmapDirections) {
  const std::string sdp =
      "v=0\r\n"
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
      "a=extmap:4/sendonly urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r\n"
      "a=rid:h recv\r\n"
      "a=rid:m send pt=96\r\n"
      "a=inactive\r\n";
  auto offer = parse_offer(sdp);
  ASSERT_TRUE(offer);
  const auto* v = offer->first("video");
  EXPECT_EQ(v->extmaps.at(std::string(kRidExtension)), 4);
  EXPECT_EQ(v->send_rids, (std::vector<std::string>{"m"}));
  EXPECT_EQ(v->direction, Direction::Inactive);
  EXPECT_EQ(offer->first("audio"), nullptr);
  EXPECT_EQ(offer->count("audio"), 0);
}
