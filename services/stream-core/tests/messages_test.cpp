#include "events/messages.hpp"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

using namespace stream;
using namespace stream::events;
using nlohmann::json;

TEST(Messages, StreamStateShape) {
  auto j = json::parse(stream_state(sfu::State::Live));
  EXPECT_EQ(j, (json{{"type", "stream_state"}, {"state", "live"}}));
}

TEST(Messages, ReconnectingCarriesGraceDeadline) {
  auto j = json::parse(stream_state(sfu::State::HostGrace, 61'000));
  EXPECT_EQ(j["state"], "reconnecting");
  EXPECT_EQ(j["grace_deadline_ms"], 61'000);
}

TEST(Messages, EndedCarriesReason) {
  auto j = json::parse(stream_state(sfu::State::Ended, std::nullopt, "grace_expired"));
  EXPECT_EQ(j["state"], "ended");
  EXPECT_EQ(j["reason"], "grace_expired");
}

TEST(Messages, ReasonOnlyWithEndedAndDeadlineOnlyWithReconnecting) {
  auto live = json::parse(stream_state(sfu::State::Live, 61'000, "host_ended"));
  EXPECT_FALSE(live.contains("reason"));
  EXPECT_FALSE(live.contains("grace_deadline_ms"));
  auto grace = json::parse(stream_state(sfu::State::HostGrace, 61'000, "grace_expired"));
  EXPECT_FALSE(grace.contains("reason"));
  auto ended = json::parse(stream_state(sfu::State::Ended, 61'000, "host_ended"));
  EXPECT_FALSE(ended.contains("grace_deadline_ms"));
  EXPECT_EQ(ended["reason"], "host_ended");
}

TEST(Messages, ViewerCountAndScene) {
  EXPECT_EQ(json::parse(viewer_count(12)), (json{{"type", "viewer_count"}, {"count", 12}}));
  EXPECT_EQ(json::parse(scene("brb")), (json{{"type", "scene"}, {"name", "brb"}}));
}

TEST(Messages, HostStatsIncludesPerLayerBitrateAndViewers) {
  HostStats s;
  s.bitrate_bps = {250'000, 0, 2'400'000};
  s.active = {true, false, true};
  s.viewers_per_layer = {3, 0, 7};
  s.nacks = 4;
  s.plis = 2;
  auto j = json::parse(host_stats(s));
  EXPECT_EQ(j["type"], "host_stats");
  ASSERT_EQ(j["layers"].size(), 3u);
  EXPECT_EQ(j["layers"][0], (json{{"rid", "l"}, {"bitrate_bps", 250'000}, {"active", true}, {"viewers", 3}}));
  EXPECT_EQ(j["layers"][2]["rid"], "h");
  EXPECT_EQ(j["nacks"], 4);
  EXPECT_EQ(j["plis"], 2);
}

TEST(Messages, ParsesOnlyValidSceneRequests) {
  EXPECT_EQ(parse_scene_request(R"({"type":"scene","name":"starting_soon"})"), "starting_soon");
  EXPECT_EQ(parse_scene_request(R"({"type":"scene","name":"live"})"), "live");
  EXPECT_FALSE(parse_scene_request(R"({"type":"scene","name":"<script>"})"));
  EXPECT_FALSE(parse_scene_request(R"({"type":"otro","name":"brb"})"));
  EXPECT_FALSE(parse_scene_request("no es json"));
  EXPECT_FALSE(parse_scene_request(R"(["scene"])"));
}
