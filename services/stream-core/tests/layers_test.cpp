// Simulcast: demux por rid, selector de capas, límite de PLI y buffer NACK (HU-LIVE-02, 04).
#include "sfu/layers.hpp"

#include <gtest/gtest.h>

#include <thread>

#include "support/rtp_builder.hpp"

using namespace stream::sfu;
using namespace stream::rtp;
using namespace stream::testing;

namespace {
const std::vector<std::string> kRids{"h", "m", "l"};
constexpr int kRidExt = 4;

Bytes pkt(std::uint32_t ssrc, std::string rid = "", std::uint16_t seq = 1) {
  RtpSpec s{.seq = seq, .ssrc = ssrc};
  if (!rid.empty()) s.extensions = {{kRidExt, rid}};
  return build_rtp(s);
}
std::optional<int> layer(SimulcastDemux& d, const Bytes& p, std::int64_t now) {
  auto v = parse_rtp(p);
  return d.layer_of(p, *v, now);
}
}  // namespace

// --- rid -> capa -------------------------------------------------------------------------

TEST(LayerForRid, KnownNamesAndPositionFallback) {
  EXPECT_EQ(layer_for_rid("l", kRids), 0);
  EXPECT_EQ(layer_for_rid("m", kRids), 1);
  EXPECT_EQ(layer_for_rid("h", kRids), 2);
  std::vector<std::string> ff{"q", "w", "e"};  // nombres libres: el primero es el de más calidad
  EXPECT_EQ(layer_for_rid("q", ff), 2);
  EXPECT_EQ(layer_for_rid("e", ff), 0);
  EXPECT_FALSE(layer_for_rid("x", ff));
  EXPECT_FALSE(layer_for_rid("h", {"m", "l"})) << "un rid que no estaba en la oferta";
}

// --- SimulcastDemux ------------------------------------------------------------------------

TEST(SimulcastDemux, LearnsSsrcFromRidExtension) {
  SimulcastDemux d(kRidExt, kRids);
  EXPECT_EQ(layer(d, pkt(0xA, "h"), 0), 2);
  EXPECT_EQ(layer(d, pkt(0xB, "l"), 0), 0);
  EXPECT_EQ(d.ssrc_of(2), 0xAu);
  EXPECT_EQ(d.ssrc_of(0), 0xBu);
  EXPECT_FALSE(d.ssrc_of(1));
}

TEST(SimulcastDemux, KeepsMappingAfterRidExtensionStops) {
  SimulcastDemux d(kRidExt, kRids);
  layer(d, pkt(0xA, "m"), 0);
  EXPECT_EQ(layer(d, pkt(0xA), 10), 1);
}

TEST(SimulcastDemux, UnknownSsrcWithoutRidIsDropped) {
  SimulcastDemux d(kRidExt, kRids);
  EXPECT_FALSE(layer(d, pkt(0xC), 0));
}

TEST(SimulcastDemux, RejectsRidNotInOffer) {
  SimulcastDemux d(kRidExt, {"m", "l"});
  EXPECT_FALSE(layer(d, pkt(0xD, "h"), 0));
}

TEST(SimulcastDemux, MarksLayerInactiveAfter1sWithoutPackets) {
  SimulcastDemux d(kRidExt, kRids);
  layer(d, pkt(0xA, "h"), 1000);
  layer(d, pkt(0xB, "l"), 1000);
  EXPECT_TRUE(d.active(2, 1500));
  layer(d, pkt(0xB), 2200);
  auto act = d.active_layers(2200);
  EXPECT_FALSE(act[2]) << "Chrome apaga la capa alta si le falta ancho de banda";
  EXPECT_FALSE(act[1]) << "nunca llegó";
  EXPECT_TRUE(act[0]);
}

TEST(SimulcastDemux, ResetClearsMappingsOnHostReplace) {
  SimulcastDemux d(kRidExt, kRids);
  layer(d, pkt(0xA, "h"), 0);
  d.reset();
  EXPECT_FALSE(layer(d, pkt(0xA), 1));
  EXPECT_FALSE(d.ssrc_of(2));
  EXPECT_FALSE(d.active(2, 1));
}

// --- PliThrottle -----------------------------------------------------------------------------

TEST(PliThrottle, FirstRequestSendsPliAndSecondWithin1sSuppressed) {
  PliThrottle t;
  EXPECT_TRUE(t.should_send(2, 10'000));
  EXPECT_FALSE(t.should_send(2, 10'500));
  EXPECT_TRUE(t.should_send(2, 11'000));
}

TEST(PliThrottle, LayersThrottledIndependently) {
  PliThrottle t;
  EXPECT_TRUE(t.should_send(0, 5));
  EXPECT_TRUE(t.should_send(1, 5));
  EXPECT_FALSE(t.should_send(0, 6));
}

TEST(PliThrottle, ConcurrentRequestsSendExactlyOne) {
  // 50 viewers entran a la vez: un solo keyframe (sin tormenta de PLI).
  PliThrottle t;
  std::atomic<int> sent{0};
  std::vector<std::thread> threads;
  for (int i = 0; i < 16; ++i)
    threads.emplace_back([&] {
      for (int k = 0; k < 100; ++k)
        if (t.should_send(1, 42)) ++sent;
    });
  for (auto& th : threads) th.join();
  EXPECT_EQ(sent.load(), 1);
}

// --- NackBuffer ------------------------------------------------------------------------------

TEST(NackBuffer, StoresAndRetrievesBySeq) {
  NackBuffer b(8);
  auto p = pkt(1, "", 100);
  EXPECT_TRUE(b.store(100, p));
  EXPECT_EQ(b.get(100), p);
  EXPECT_FALSE(b.get(101));
}

TEST(NackBuffer, OverwrittenSlotReturnsMiss) {
  NackBuffer b(8);
  b.store(1, pkt(1, "", 1));
  b.store(9, pkt(1, "", 9));  // mismo slot
  EXPECT_FALSE(b.get(1));
  EXPECT_TRUE(b.get(9));
}

TEST(NackBuffer, SeqWrapLookup) {
  NackBuffer b(8);
  b.store(65535, pkt(1, "", 65535));
  b.store(0, pkt(1, "", 0));
  EXPECT_TRUE(b.get(65535));
  EXPECT_TRUE(b.get(0));
}

TEST(NackBuffer, PacketsLargerThanSlotRejectedAndClear) {
  NackBuffer b(8, 100);
  EXPECT_FALSE(b.store(1, Bytes(101, 0)));
  EXPECT_FALSE(b.get(1));
  b.store(2, Bytes(10, 1));
  b.clear();
  EXPECT_FALSE(b.get(2));
}

TEST(NackBuffer, ConcurrentWriterAndNackReadersAreRaceFree) {
  NackBuffer b(64);
  std::atomic<bool> stop{false};
  std::thread writer([&] {
    for (std::uint16_t s = 0; s < 20'000; ++s) b.store(s, pkt(1, "", s));
    stop = true;
  });
  std::vector<std::thread> readers;
  for (int r = 0; r < 4; ++r)
    readers.emplace_back([&] {
      std::uint16_t s = 0;
      while (!stop) {
        if (auto got = b.get(s)) {
          EXPECT_EQ(parse_rtp(*got)->seq, s);
        }
        s = static_cast<std::uint16_t>(s + 7);
      }
    });
  writer.join();
  for (auto& r : readers) r.join();
}

// --- LayerSelector -----------------------------------------------------------------------------

namespace {
constexpr std::array<bool, kLayers> kAll{true, true, true};
}

TEST(LayerSelector, StartsAtLowLayerForFastFirstFrame) {
  LayerSelector s;
  EXPECT_EQ(s.layer(), 0);
}

TEST(LayerSelector, UpgradesWhenRembExceedsNextLayerTimes1_3For5s) {
  LayerSelector s;
  s.on_remb(5'000'000, 0);
  EXPECT_EQ(s.on_tick(kAll, 4'999), 0);
  EXPECT_EQ(s.on_tick(kAll, 5'000), 1);
  s.on_remb(5'000'000, 5'000);
  EXPECT_EQ(s.on_tick(kAll, 9'999), 1) << "una capa cada vez, con su propia espera";
  EXPECT_EQ(s.on_tick(kAll, 10'000), 2);
}

TEST(LayerSelector, RembCappedByWhatTheViewerReceivesDoesNotBlockUpgrade) {
  // E2E con Chrome: su REMB es una estimación del receptor que no pasa de ~1.5× lo que recibe
  // (161k → 331k recibiendo l a ~210 kbps). Sin sondeo del SFU nunca llega a 1.3 × 800k: exigirlo
  // dejaba a todos los viewers en 360p para siempre. Un REMB que sube no frena la subida.
  LayerSelector s;
  for (std::int64_t t = 0; t <= 5'000; t += 500) {
    s.on_remb(180'000 + static_cast<std::uint64_t>(t) * 30, t);
    if (t % 1'000 == 0) s.on_loss(0, t);
  }
  EXPECT_EQ(s.on_tick(kAll, 5'000), 1);
}

TEST(LayerSelector, RampingRembAfterUpgradeDoesNotDowngrade) {
  LayerSelector s;
  s.on_remb(330'000, 0);
  ASSERT_EQ(s.on_tick(kAll, 5'000), 1);
  EXPECT_EQ(s.on_remb(340'000, 5'500), 1) << "por debajo de 800k, pero sube: no es congestión";
  EXPECT_EQ(s.on_remb(370'000, 6'000), 1);
  EXPECT_EQ(s.on_remb(355'000, 6'500), 1) << "una variación pequeña tampoco";
}

TEST(LayerSelector, RembDropResetsUpgradeHold) {
  LayerSelector s;
  s.on_remb(400'000, 0);
  s.on_remb(300'000, 3'000);  // cae 25 %: congestión aunque ya esté en la capa baja
  EXPECT_EQ(s.on_tick(kAll, 5'000), 0);
  s.on_remb(310'000, 3'500);
  EXPECT_EQ(s.on_tick(kAll, 8'500), 1);
}

TEST(LayerSelector, DowngradesImmediatelyWhenRembFallsBelowCurrentBitrate) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  s.on_tick(kAll, 5'000);
  s.on_tick(kAll, 10'000);
  ASSERT_EQ(s.layer(), 2);
  EXPECT_EQ(s.on_remb(500'000, 10'100), 0) << "salta directo a la capa que cabe";
}

TEST(LayerSelector, DowngradesAfterTwoReportsAboveTenPercentLoss) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  s.on_tick(kAll, 5'000);
  s.on_tick(kAll, 10'000);
  ASSERT_EQ(s.layer(), 2);
  EXPECT_EQ(s.on_loss(40, 10'500), 2);
  EXPECT_EQ(s.on_loss(40, 11'000), 1);
  EXPECT_EQ(s.on_loss(0, 11'500), 1);
}

TEST(LayerSelector, DoesNotUpgradeDuringDwellAfterDowngrade) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  s.on_tick(kAll, 5'000);
  s.on_tick(kAll, 10'000);
  s.on_loss(60, 10'100);
  s.on_loss(60, 10'200);
  ASSERT_EQ(s.layer(), 1);
  s.on_remb(10'000'000, 10'300);
  EXPECT_EQ(s.on_tick(kAll, 16'000), 1) << "8 s de espera tras bajar";
  EXPECT_EQ(s.on_tick(kAll, 18'300), 2);
}

TEST(LayerSelector, FallsBackToLossOnlyWithoutRemb) {
  LayerSelector s;
  s.on_loss(0, 0);
  EXPECT_EQ(s.on_tick(kAll, 5'000), 1);
  s.on_loss(0, 5'000);
  EXPECT_EQ(s.on_tick(kAll, 10'000), 2);
}

TEST(LayerSelector, LossResetsUpgradeHold) {
  LayerSelector s;
  s.on_remb(5'000'000, 0);
  s.on_tick(kAll, 3'000);
  s.on_loss(60, 3'500);  // un informe malo reinicia la espera
  s.on_loss(0, 4'000);
  EXPECT_EQ(s.on_tick(kAll, 5'000), 0);
  EXPECT_EQ(s.on_tick(kAll, 9'000), 1);
}

TEST(LayerSelector, SkipsInactiveLayers) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  std::array<bool, kLayers> no_mid{true, false, true};
  EXPECT_EQ(s.on_tick(no_mid, 5'000), 2) << "salta m si no se está publicando";
  std::array<bool, kLayers> only_low{true, false, false};
  EXPECT_EQ(s.on_tick(only_low, 5'100), 0) << "la capa elegida dejó de llegar";
}

TEST(LayerSelector, ReturnsToBestAvailableWhenLayerReappears) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  std::array<bool, kLayers> only_low{true, false, false};
  EXPECT_EQ(s.on_tick(only_low, 5'000), 0);
  EXPECT_EQ(s.on_tick(kAll, 5'100), 0);
  EXPECT_EQ(s.on_tick(kAll, 10'100), 1);
}

TEST(LayerSelector, NoFlappingUnderOscillatingLoss) {
  LayerSelector s;
  s.on_remb(10'000'000, 0);
  s.on_tick(kAll, 5'000);
  s.on_tick(kAll, 10'000);
  int changes = 0;
  int last = s.layer();
  for (std::int64_t t = 10'000; t < 70'000; t += 500) {
    s.on_loss((t / 500) % 2 ? 40 : 0, t);  // malo, bueno, malo, bueno…
    s.on_tick(kAll, t);
    if (s.layer() != last) ++changes;
    last = s.layer();
  }
  EXPECT_LE(changes, 1) << "un informe malo aislado no baja la capa";
}
