#include "sdp/munge.hpp"

#include <gtest/gtest.h>

#include "sdp/offer_inspect.hpp"
#include "support/sdp_fixtures.hpp"

using namespace stream::sdp;
using namespace stream::testing;

namespace {
bool has(const std::string& s, std::string_view needle) { return s.find(needle) != std::string::npos; }
int count(const std::string& s, std::string_view needle) {
  int n = 0;
  for (auto pos = s.find(needle); pos != std::string::npos; pos = s.find(needle, pos + 1)) ++n;
  return n;
}
}  // namespace

TEST(SdpMunge, SanitizeKeepsOnlyVp8AndDropsRtxRedUlpfecH264) {
  auto out = sanitize_offer(kChromeWhipVideoOffer);
  auto offer = parse_offer(out);
  ASSERT_TRUE(offer);
  const auto* video = offer->first("video");
  ASSERT_NE(video, nullptr);
  EXPECT_EQ(video->codecs.size(), 1u);
  EXPECT_EQ(video->payload_type_of("vp8"), 96);
  EXPECT_TRUE(has(out, "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"));
  EXPECT_FALSE(has(out, "apt=96"));
  EXPECT_FALSE(has(out, "a=rtcp-fb:98"));
  EXPECT_TRUE(has(out, "a=rtcp-fb:96 nack pli")) << "NACK y PLI se conservan";
  EXPECT_TRUE(has(out, "a=rid:h send")) << "el simulcast se conserva";
  EXPECT_TRUE(has(out, "m=application")) << "el DataChannel se conserva";
}

TEST(SdpMunge, SanitizeDropsTransportCc) {
  auto out = sanitize_offer(kChromeWhipVideoOffer);
  EXPECT_FALSE(has(out, "transport-wide-cc"));
  EXPECT_FALSE(has(out, "a=rtcp-fb:96 transport-cc"));
  EXPECT_TRUE(has(out, "a=rtcp-fb:96 goog-remb"));
}

TEST(SdpMunge, AudioWhipAcceptsOnlyOpus) {
  auto out = sanitize_offer(kChromeWhipAudioOffer);
  EXPECT_TRUE(has(out, "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
  EXPECT_FALSE(has(out, "PCMU"));
  EXPECT_FALSE(has(out, "red/48000"));
}

TEST(SdpMunge, FixSimulcastAnswerFlipsRidToRecv) {
  const std::string answer =
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rid:h send\r\na=rid:m send\r\na=rid:l send\r\n"
      "a=simulcast:send h;m;l\r\na=simulcast:send h;m;l\r\na=recvonly\r\n";
  auto out = fix_simulcast_answer(answer);
  EXPECT_EQ(count(out, "a=rid:"), 3);
  EXPECT_EQ(count(out, " recv\r\n"), 3);
  EXPECT_FALSE(has(out, " send\r\n"));
  EXPECT_EQ(count(out, "a=simulcast:"), 1) << "una sola línea de simulcast";
  EXPECT_TRUE(has(out, "a=simulcast:recv h;m;l\r\n"));
}

TEST(SdpMunge, FixSimulcastLeavesPlainAnswersAlone) {
  const std::string answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";
  EXPECT_EQ(fix_simulcast_answer(answer), answer);
}

TEST(SdpMunge, RewritesHostCandidateToPublicIp) {
  const std::string sdp =
      "a=candidate:1 1 UDP 2122317823 172.18.0.5 8087 typ host\r\n"
      "a=candidate:2 1 UDP 1686052607 203.0.113.9 8087 typ srflx raddr 172.18.0.5 rport 8087\r\n";
  auto out = rewrite_host_candidates(sdp, "192.168.1.20");
  EXPECT_TRUE(has(out, "a=candidate:1 1 UDP 2122317823 192.168.1.20 8087 typ host\r\n"));
  EXPECT_TRUE(has(out, "203.0.113.9 8087 typ srflx")) << "los demás candidatos no se tocan";
}

TEST(SdpMunge, RewriteWithEmptyIpIsNoop) {
  const std::string sdp = "a=candidate:1 1 UDP 1 10.0.0.1 1 typ host\r\n";
  EXPECT_EQ(rewrite_host_candidates(sdp, ""), sdp);
}

TEST(SdpMunge, AddsStartBitrateFmtp) {
  const std::string answer =
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\na=rtcp-fb:96 nack\r\n";
  auto out = add_start_bitrate(answer, 2500);
  EXPECT_TRUE(has(out, "a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=2500\r\n"));
  const std::string with_fmtp = "a=rtpmap:96 VP8/90000\r\na=fmtp:96 max-fr=30\r\n";
  EXPECT_TRUE(has(add_start_bitrate(with_fmtp, 2500), "a=fmtp:96 max-fr=30;x-google-start-bitrate=2500\r\n"));
}

TEST(SdpMunge, OpusAnswerKeepsStereo128k) {
  const std::string sdp = "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n";
  auto out = opus_stereo(sdp);
  EXPECT_TRUE(
      has(out, "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n"));
  const std::string bare = "a=rtpmap:109 opus/48000/2\r\n";
  EXPECT_TRUE(has(opus_stereo(bare), "a=fmtp:109 stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n"));
  EXPECT_EQ(opus_stereo(out), out) << "idempotente";
}

TEST(SdpMunge, AnswerAdvertisesGoogRembForVp8) {
  // Chrome solo usa el REMB del SFU como límite de su estimación si el feedback está negociado.
  const std::string answer =
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\na=rtcp-fb:96 nack\r\n"
      "a=rtcp-fb:96 nack pli\r\na=rid:h recv\r\n";
  auto out = add_goog_remb(answer);
  EXPECT_TRUE(has(out, "a=rtcp-fb:96 nack pli\r\na=rtcp-fb:96 goog-remb\r\na=rid:h recv\r\n"));
  EXPECT_EQ(count(out, "goog-remb"), 1);
  EXPECT_EQ(add_goog_remb(out), out) << "idempotente";
  const std::string bare = "m=video 9 UDP/TLS/RTP/SAVPF 97\r\na=rtpmap:97 VP8/90000\r\na=sendonly\r\n";
  EXPECT_TRUE(has(add_goog_remb(bare), "a=rtpmap:97 VP8/90000\r\na=rtcp-fb:97 goog-remb\r\na=sendonly\r\n"));
  const std::string audio = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
  EXPECT_EQ(add_goog_remb(audio), audio) << "solo vídeo";
}
