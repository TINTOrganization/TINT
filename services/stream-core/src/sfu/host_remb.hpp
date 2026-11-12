#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <vector>

#include "sfu/layers.hpp"

namespace stream::sfu {

// REMB del SFU hacia el host (dominio-transmision §7.1). Sin transport-cc ni REMB, Chrome se queda
// con una estimación de salida de 300 kbps y rellena con padding. El objetivo es CONSTANTE: la suma de
// las capas con un margen, haya o no viewers (HU-LIVE-02 AC2: la subida no depende de la audiencia).
// Bajarlo apagaría las capas altas y el viewer que sube a `h` esperaría a que Chrome las reactive.
// El techo real lo siguen poniendo los maxBitrate por capa de la web.
struct HostRembConfig {
  std::array<std::uint64_t, kLayers> layer_bps{250'000, 800'000, 2'500'000};
  double headroom = 1.2;
  std::int64_t interval_ms = 1000;
};

std::uint64_t host_remb_target(const HostRembConfig& config);

// Cuándo enviar: en cuanto se conocen SSRC del host, cada `interval_ms` y enseguida si cambian los
// SSRC o el objetivo. Plano de control (lo usa Room::tick bajo su mutex).
class HostRembPacer {
 public:
  explicit HostRembPacer(std::int64_t interval_ms = 1000) : interval_ms_(interval_ms) {}
  bool due(std::int64_t now_ms, std::uint64_t target_bps, std::span<const std::uint32_t> ssrcs);
  void reset();

 private:
  std::int64_t interval_ms_;
  bool sent_ = false;
  std::int64_t last_ms_ = 0;
  std::uint64_t last_target_ = 0;
  std::vector<std::uint32_t> last_ssrcs_;
};

}  // namespace stream::sfu
