#include "sfu/layers.hpp"

#include <algorithm>

namespace stream::sfu {

std::optional<int> layer_for_rid(const std::string& rid, const std::vector<std::string>& offered) {
  auto it = std::ranges::find(offered, rid);
  if (it == offered.end()) return std::nullopt;
  if (rid == "l") return 0;
  if (rid == "m") return 1;
  if (rid == "h") return 2;
  // Nombres libres: la primera codificación es la de más calidad.
  const int position = static_cast<int>(it - offered.begin());
  const int layer = static_cast<int>(offered.size()) - 1 - position;
  if (layer < 0 || layer >= kLayers) return std::nullopt;
  return layer;
}

// --- SimulcastDemux ------------------------------------------------------------------------

SimulcastDemux::SimulcastDemux(int rid_extension_id, std::vector<std::string> offered_rids,
                               std::int64_t inactive_after_ms)
    : rid_extension_id_(rid_extension_id),
      offered_rids_(std::move(offered_rids)),
      inactive_after_ms_(inactive_after_ms) {}

std::optional<int> SimulcastDemux::layer_of(rtp::ByteView packet, const rtp::RtpView& view,
                                            std::int64_t now_ms) {
  int layer;
  if (auto known = layer_by_ssrc_.find(view.ssrc); known != layer_by_ssrc_.end()) {
    layer = known->second;
  } else {
    auto rid = rtp::find_extension(packet, view, rid_extension_id_);
    if (!rid) return std::nullopt;
    auto learned = layer_for_rid(std::string(rid->begin(), rid->end()), offered_rids_);
    if (!learned) return std::nullopt;
    layer = *learned;
    layer_by_ssrc_[view.ssrc] = layer;
    ssrc_by_layer_[layer].store(view.ssrc);
  }
  last_seen_ms_[layer].store(now_ms);
  seen_[layer].store(true);
  return layer;
}

std::optional<std::uint32_t> SimulcastDemux::ssrc_of(int layer) const {
  if (layer < 0 || layer >= kLayers || !seen_[layer].load()) return std::nullopt;
  return ssrc_by_layer_[layer].load();
}

bool SimulcastDemux::active(int layer, std::int64_t now_ms) const {
  if (layer < 0 || layer >= kLayers || !seen_[layer].load()) return false;
  return now_ms - last_seen_ms_[layer].load() <= inactive_after_ms_;
}

std::array<bool, kLayers> SimulcastDemux::active_layers(std::int64_t now_ms) const {
  std::array<bool, kLayers> out{};
  for (int l = 0; l < kLayers; ++l) out[l] = active(l, now_ms);
  return out;
}

void SimulcastDemux::reset() {
  layer_by_ssrc_.clear();
  for (int l = 0; l < kLayers; ++l) seen_[l].store(false);
}

// --- PliThrottle ---------------------------------------------------------------------------

bool PliThrottle::should_send(int layer, std::int64_t now_ms) {
  if (layer < 0 || layer >= kLayers) return false;
  auto& last = last_ms_[layer];
  std::int64_t prev = last.load();
  while (now_ms - prev >= interval_ms_) {
    if (last.compare_exchange_weak(prev, now_ms)) return true;
  }
  return false;
}

// --- NackBuffer ----------------------------------------------------------------------------

NackBuffer::NackBuffer(std::size_t capacity, std::size_t max_packet)
    : max_packet_(max_packet), slots_(capacity) {}

bool NackBuffer::store(std::uint16_t seq, rtp::ByteView packet) {
  if (packet.size() > max_packet_ || slots_.empty()) return false;
  std::lock_guard lock(mu_);
  auto& slot = slots_[seq % slots_.size()];
  slot.used = true;
  slot.seq = seq;
  slot.data.assign(packet.begin(), packet.end());
  return true;
}

std::optional<rtp::Bytes> NackBuffer::get(std::uint16_t seq) const {
  if (slots_.empty()) return std::nullopt;
  std::lock_guard lock(mu_);
  const auto& slot = slots_[seq % slots_.size()];
  if (!slot.used || slot.seq != seq) return std::nullopt;
  return slot.data;
}

void NackBuffer::clear() {
  std::lock_guard lock(mu_);
  for (auto& s : slots_) s.used = false;
}

// --- LayerSelector -------------------------------------------------------------------------

LayerSelector::LayerSelector(LayerSelectorConfig config) : config_(config) {}

void LayerSelector::move_to(int layer, std::int64_t now_ms, bool downgrade) {
  layer_ = std::clamp(layer, 0, kLayers - 1);
  good_since_ms_ = downgrade ? -1 : now_ms;
  lossy_reports_ = 0;
  if (downgrade) {
    last_downgrade_ms_ = now_ms;
    remb_peak_bps_ = 0;  // tras bajar, el REMB vuelve a tomar referencia (no baja dos veces)
  }
}

std::optional<int> LayerSelector::next_active_above(const std::array<bool, kLayers>& active) const {
  for (int l = layer_ + 1; l < kLayers; ++l)
    if (active[l]) return l;
  return std::nullopt;
}

int LayerSelector::on_remb(std::uint64_t bitrate_bps, std::int64_t now_ms) {
  const bool fell = remb_peak_bps_ > 0 && static_cast<double>(bitrate_bps) <
                                              config_.remb_drop_ratio * static_cast<double>(remb_peak_bps_);
  remb_peak_bps_ = std::max(remb_peak_bps_, bitrate_bps);
  if (!fell) {
    // Sube o se mantiene: sin congestión. Que esté por debajo de la capa siguiente no dice nada.
    if (good_since_ms_ < 0 && lossy_reports_ == 0) good_since_ms_ = now_ms;
    return layer_;
  }
  // Cayó: congestión. Si ya no cabe la capa actual, salta a la que cabe; si cabe, no sube por ahora.
  good_since_ms_ = -1;
  if (layer_ > 0 && bitrate_bps < config_.bitrate_bps[layer_]) {
    int fit = 0;
    for (int l = layer_ - 1; l >= 0; --l)
      if (config_.bitrate_bps[l] <= bitrate_bps) {
        fit = l;
        break;
      }
    move_to(fit, now_ms, /*downgrade=*/true);
  }
  remb_peak_bps_ = bitrate_bps;
  return layer_;
}

int LayerSelector::on_loss(std::uint8_t fraction_lost, std::int64_t now_ms) {
  if (fraction_lost > config_.loss_threshold) {
    good_since_ms_ = -1;
    if (++lossy_reports_ >= config_.loss_reports_to_downgrade && layer_ > 0)
      move_to(layer_ - 1, now_ms, /*downgrade=*/true);
    return layer_;
  }
  lossy_reports_ = 0;
  if (good_since_ms_ < 0) good_since_ms_ = now_ms;
  return layer_;
}

int LayerSelector::on_tick(const std::array<bool, kLayers>& active, std::int64_t now_ms) {
  // La capa elegida dejó de llegar (Chrome la apagó): la mejor disponible por debajo, o la más baja activa.
  if (!active[layer_]) {
    for (int l = layer_ - 1; l >= 0; --l)
      if (active[l]) {
        move_to(l, now_ms, /*downgrade=*/false);
        return layer_;
      }
    for (int l = layer_ + 1; l < kLayers; ++l)
      if (active[l]) {
        move_to(l, now_ms, /*downgrade=*/false);
        return layer_;
      }
    return layer_;
  }
  auto next = next_active_above(active);
  if (!next) {
    // Nada a qué subir: la espera empieza de nuevo cuando reaparezca una capa.
    if (good_since_ms_ >= 0) good_since_ms_ = now_ms;
    return layer_;
  }
  const bool held = good_since_ms_ >= 0 && now_ms - good_since_ms_ >= config_.upgrade_hold_ms;
  const bool dwell_over = now_ms - last_downgrade_ms_ >= config_.dwell_after_downgrade_ms;
  if (held && dwell_over) move_to(*next, now_ms, /*downgrade=*/false);
  return layer_;
}

}  // namespace stream::sfu
