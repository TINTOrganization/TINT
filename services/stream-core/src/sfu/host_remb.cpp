#include "sfu/host_remb.hpp"

#include <algorithm>
#include <cmath>

namespace stream::sfu {

std::uint64_t host_remb_target(const HostRembConfig& config) {
  std::uint64_t sum = 0;
  for (auto bps : config.layer_bps) sum += bps;
  return static_cast<std::uint64_t>(std::llround(static_cast<double>(sum) * config.headroom));
}

bool HostRembPacer::due(std::int64_t now_ms, std::uint64_t target_bps, std::span<const std::uint32_t> ssrcs) {
  if (ssrcs.empty()) return false;
  const bool changed = !sent_ || target_bps != last_target_ || !std::ranges::equal(ssrcs, last_ssrcs_);
  if (!changed && now_ms - last_ms_ < interval_ms_) return false;
  sent_ = true;
  last_ms_ = now_ms;
  last_target_ = target_bps;
  last_ssrcs_.assign(ssrcs.begin(), ssrcs.end());
  return true;
}

void HostRembPacer::reset() {
  sent_ = false;
  last_ssrcs_.clear();
}

}  // namespace stream::sfu
