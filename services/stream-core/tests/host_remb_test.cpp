// REMB del SFU hacia el host (dominio-transmision §7.1, "Padding del host").
#include "sfu/host_remb.hpp"

#include <gtest/gtest.h>

#include <vector>

using namespace stream::sfu;

TEST(HostRemb, TargetIsSumOfLayerTargetsPlusHeadroom) {
  // 2.5 + 0.8 + 0.25 Mbps = 3.55 Mbps × 1.2 ≈ 4.26 Mbps: Chrome no limita por estimación baja, y sus
  // maxBitrate por capa (streamProtocol.ts) siguen poniendo el techo real de lo que envía.
  EXPECT_EQ(host_remb_target(HostRembConfig{}), 4'260'000u);
  HostRembConfig custom;
  custom.layer_bps = {100'000, 200'000, 700'000};
  custom.headroom = 1.0;
  EXPECT_EQ(host_remb_target(custom), 1'000'000u);
}

TEST(HostRemb, PacerSendsAsSoonAsSsrcsAreKnownThenOncePerInterval) {
  HostRembPacer pacer(1000);
  const std::vector<std::uint32_t> none;
  const std::vector<std::uint32_t> three{0x10, 0x20, 0x30};
  EXPECT_FALSE(pacer.due(0, 4'260'000, none)) << "sin SSRC del host no hay a quién informar";
  EXPECT_TRUE(pacer.due(100, 4'260'000, three)) << "primera capa aprendida: enseguida";
  EXPECT_FALSE(pacer.due(350, 4'260'000, three));
  EXPECT_FALSE(pacer.due(1099, 4'260'000, three));
  EXPECT_TRUE(pacer.due(1100, 4'260'000, three)) << "≈1 s después";
  EXPECT_FALSE(pacer.due(1350, 4'260'000, three));
}

TEST(HostRemb, PacerSendsImmediatelyWhenSsrcsOrTargetChange) {
  HostRembPacer pacer(1000);
  const std::vector<std::uint32_t> one{0x10};
  const std::vector<std::uint32_t> two{0x10, 0x20};
  const std::vector<std::uint32_t> reconnected{0x11, 0x21};
  EXPECT_TRUE(pacer.due(0, 4'260'000, one));
  EXPECT_TRUE(pacer.due(250, 4'260'000, two)) << "capa nueva";
  EXPECT_TRUE(pacer.due(500, 4'260'000, reconnected)) << "el host reconectó con otros SSRC";
  EXPECT_TRUE(pacer.due(750, 3'000'000, reconnected)) << "cambió el objetivo";
  EXPECT_FALSE(pacer.due(1000, 3'000'000, reconnected));
}

TEST(HostRemb, PacerResetForgetsThePreviousHost) {
  HostRembPacer pacer(1000);
  const std::vector<std::uint32_t> ssrcs{0x10};
  EXPECT_TRUE(pacer.due(0, 4'260'000, ssrcs));
  pacer.reset();
  EXPECT_TRUE(pacer.due(10, 4'260'000, ssrcs)) << "mismo SSRC tras un host nuevo: se informa igual";
}
