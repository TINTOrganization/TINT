#include "events/messages.hpp"

#include <nlohmann/json.hpp>

namespace stream::events {

using nlohmann::json;

std::string stream_state(sfu::State state, std::optional<std::int64_t> grace_deadline_ms,
                         std::string_view reason) {
  json j{{"type", "stream_state"}, {"state", sfu::to_string(state)}};
  // §4: grace_deadline_ms solo con reconnecting y reason solo con ended.
  if (grace_deadline_ms && state == sfu::State::HostGrace) j["grace_deadline_ms"] = *grace_deadline_ms;
  if (!reason.empty() && state == sfu::State::Ended) j["reason"] = reason;
  return j.dump();
}

std::string viewer_count(int count) { return json{{"type", "viewer_count"}, {"count", count}}.dump(); }

std::string scene(std::string_view name) { return json{{"type", "scene"}, {"name", name}}.dump(); }

std::string host_stats(const HostStats& s) {
  static constexpr const char* kRid[sfu::kLayers] = {"l", "m", "h"};
  json layers = json::array();
  for (int l = 0; l < sfu::kLayers; ++l)
    layers.push_back({{"rid", kRid[l]},
                      {"bitrate_bps", s.bitrate_bps[l]},
                      {"active", s.active[l]},
                      {"viewers", s.viewers_per_layer[l]}});
  return json{{"type", "host_stats"}, {"layers", layers}, {"nacks", s.nacks}, {"plis", s.plis}}.dump();
}

std::optional<std::string> parse_scene_request(std::string_view text) {
  json j = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::nullopt;
  auto type = j.find("type");
  auto name = j.find("name");
  if (type == j.end() || *type != "scene" || name == j.end() || !name->is_string()) return std::nullopt;
  const auto& value = name->get_ref<const std::string&>();
  if (value != "live" && value != "starting_soon" && value != "brb") return std::nullopt;
  return value;
}

}  // namespace stream::events
