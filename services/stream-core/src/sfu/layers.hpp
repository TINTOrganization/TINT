#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "rtp/packet.hpp"

namespace stream::sfu {

// Capas de simulcast: 0 = l (360p15), 1 = m (720p30), 2 = h (1080p30).
inline constexpr int kLayers = 3;

// Estadísticas para el host (DataChannel host_stats, dominio-transmision §4).
struct HostStats {
  std::array<std::uint64_t, kLayers> bitrate_bps{};  // de la última ventana
  std::array<bool, kLayers> active{};
  std::array<int, kLayers> viewers_per_layer{};
  std::uint64_t nacks = 0;  // secuencias pedidas por los viewers (acumulado)
  std::uint64_t plis = 0;   // PLI enviados al host (acumulado)
};

// rid -> capa: "l"/"m"/"h"; cualquier otro nombre se ordena por su posición en la oferta
// (la primera codificación es la de más calidad, como en sendEncodings).
std::optional<int> layer_for_rid(const std::string& rid, const std::vector<std::string>& offered_rids);

// Aprende SSRC -> capa con la extensión rtp-stream-id y la conserva cuando el navegador
// deja de enviarla (Chrome la quita tras recibir RR). Solo lo usa el hilo de ingesta.
class SimulcastDemux {
 public:
  SimulcastDemux(int rid_extension_id, std::vector<std::string> offered_rids,
                 std::int64_t inactive_after_ms = 1000);

  // Capa del paquete, o nullopt si su SSRC es desconocido y no trae un rid válido.
  std::optional<int> layer_of(rtp::ByteView packet, const rtp::RtpView& view, std::int64_t now_ms);
  std::optional<std::uint32_t> ssrc_of(int layer) const;
  bool active(int layer, std::int64_t now_ms) const;
  std::array<bool, kLayers> active_layers(std::int64_t now_ms) const;
  void reset();  // el host se reemplazó: nuevos SSRC

 private:
  int rid_extension_id_;
  std::vector<std::string> offered_rids_;
  std::int64_t inactive_after_ms_;
  std::unordered_map<std::uint32_t, int> layer_by_ssrc_;
  std::array<std::atomic<std::uint32_t>, kLayers> ssrc_by_layer_{};
  std::array<std::atomic<std::int64_t>, kLayers> last_seen_ms_{};
  std::array<std::atomic<bool>, kLayers> seen_{};
};

// Un PLI por capa y por segundo como máximo, compartido por todos los viewers (sin locks).
class PliThrottle {
 public:
  explicit PliThrottle(std::int64_t interval_ms = 1000) : interval_ms_(interval_ms) {
    for (auto& t : last_ms_) t.store(kNever);
  }
  bool should_send(int layer, std::int64_t now_ms);

 private:
  static constexpr std::int64_t kNever = INT64_MIN / 2;
  std::int64_t interval_ms_;
  std::array<std::atomic<std::int64_t>, kLayers> last_ms_{};
};

// Últimos paquetes de una capa para responder NACK. Un escritor (ingesta) y lectores NACK:
// un mutex por buffer, sin contención en la práctica (los NACK son raros). Excepción documentada
// a "sin locks en el camino caliente" (ADR 0018).
class NackBuffer {
 public:
  explicit NackBuffer(std::size_t capacity = 512, std::size_t max_packet = 1500);
  bool store(std::uint16_t seq, rtp::ByteView packet);  // false si el paquete no cabe en un slot
  std::optional<rtp::Bytes> get(std::uint16_t seq) const;
  void clear();

 private:
  struct Slot {
    bool used = false;
    std::uint16_t seq = 0;
    rtp::Bytes data;
  };
  std::size_t max_packet_;
  mutable std::mutex mu_;
  std::vector<Slot> slots_;
};

struct LayerSelectorConfig {
  std::array<std::uint64_t, kLayers> bitrate_bps{250'000, 800'000, 2'500'000};
  double upgrade_margin = 1.3;
  std::int64_t upgrade_hold_ms = 5000;
  std::uint8_t loss_threshold = 26;  // 10 % en fracción /256
  int loss_reports_to_downgrade = 2;
  std::int64_t dwell_after_downgrade_ms = 8000;
};

// Elige la capa de un viewer con histéresis (HU-LIVE-02 AC3). Empieza en la más baja para que
// el primer frame llegue rápido (AC1) y sube cuando el ancho de banda lo sostiene.
class LayerSelector {
 public:
  explicit LayerSelector(LayerSelectorConfig config = {});

  int layer() const { return layer_; }
  int on_remb(std::uint64_t bitrate_bps, std::int64_t now_ms);
  int on_loss(std::uint8_t fraction_lost, std::int64_t now_ms);
  int on_tick(const std::array<bool, kLayers>& active, std::int64_t now_ms);

 private:
  void move_to(int layer, std::int64_t now_ms, bool downgrade);
  std::optional<int> next_active_above(const std::array<bool, kLayers>& active) const;

  LayerSelectorConfig config_;
  int layer_ = 0;
  std::optional<std::uint64_t> remb_bps_;
  int lossy_reports_ = 0;
  std::int64_t good_since_ms_ = -1;
  std::int64_t last_downgrade_ms_ = INT64_MIN / 2;
};

}  // namespace stream::sfu
