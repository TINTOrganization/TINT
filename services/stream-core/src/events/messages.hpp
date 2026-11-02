#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "sfu/layers.hpp"
#include "sfu/stream_state.hpp"

namespace stream::events {

// Mensajes del DataChannel "stream-events" (dominio-transmision §4). JSON de una línea.
std::string stream_state(sfu::State state, std::optional<std::int64_t> grace_deadline_ms = std::nullopt,
                         std::string_view reason = {});
std::string viewer_count(int count);
std::string scene(std::string_view name);

struct HostStats {
  std::array<std::uint64_t, sfu::kLayers> bitrate_bps{};
  std::array<bool, sfu::kLayers> active{};
  std::array<int, sfu::kLayers> viewers_per_layer{};
  std::uint64_t nacks = 0;
  std::uint64_t plis = 0;
};
std::string host_stats(const HostStats& stats);

// Mensaje del host por su DataChannel: solo {"type":"scene","name":"live|starting_soon|brb"}.
std::optional<std::string> parse_scene_request(std::string_view json);

}  // namespace stream::events
