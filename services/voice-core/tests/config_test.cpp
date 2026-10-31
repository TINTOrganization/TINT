#include "config.hpp"

#include <map>

#include <gtest/gtest.h>

using voice::load_config;
using voice::split_csv;

namespace {
voice::EnvLookup env_of(std::map<std::string, std::string> vars) {
  return [vars](std::string_view key) -> std::optional<std::string> {
    auto it = vars.find(std::string(key));
    if (it == vars.end()) return std::nullopt;
    return it->second;
  };
}
std::map<std::string, std::string> minimal() {
  return {{"JWT_SECRET", "s"}, {"REDIS_URL", "redis://localhost:6379"}};
}
}  // namespace

TEST(SplitCsv, TrimsAndDropsEmpty) {
  EXPECT_EQ(split_csv(" a, b,,c ,"), (std::vector<std::string>{"a", "b", "c"}));
  EXPECT_TRUE(split_csv("").empty());
}

TEST(LoadConfig, UsesDefaults) {
  auto cfg = load_config(env_of(minimal()));
  ASSERT_TRUE(cfg.has_value()) << cfg.error();
  EXPECT_EQ(cfg->host, "0.0.0.0");
  EXPECT_EQ(cfg->port, 8085);
  EXPECT_EQ(cfg->jwt_issuer, "tint-identity");
  EXPECT_EQ(cfg->jwt_audience, "tint:room");
  EXPECT_EQ(cfg->max_members, 8u);
  EXPECT_EQ(cfg->turn_ttl_s, 3600);
  EXPECT_EQ(cfg->allowed_origins, (std::vector<std::string>{"localhost:5173", "127.0.0.1:5173"}));
}

TEST(LoadConfig, ReadsEveryVariable) {
  auto vars = minimal();
  vars["VOICE_CORE_ADDR"] = "127.0.0.1:9000";
  vars["JWT_ISSUER"] = "iss";
  vars["JWT_AUDIENCE"] = "aud";
  vars["ALLOWED_ORIGINS"] = "a:1,b:2";
  vars["VOICE_MAX_MEMBERS"] = "4";
  vars["STUN_URLS"] = "stun:x:3478";
  vars["TURN_URLS"] = "turn:x:3478?transport=udp,turn:x:3478?transport=tcp";
  vars["TURN_SECRET"] = "t";
  vars["TURN_TTL_SECONDS"] = "60";
  auto cfg = load_config(env_of(vars));
  ASSERT_TRUE(cfg.has_value()) << cfg.error();
  EXPECT_EQ(cfg->host, "127.0.0.1");
  EXPECT_EQ(cfg->port, 9000);
  EXPECT_EQ(cfg->jwt_issuer, "iss");
  EXPECT_EQ(cfg->jwt_audience, "aud");
  EXPECT_EQ(cfg->allowed_origins, (std::vector<std::string>{"a:1", "b:2"}));
  EXPECT_EQ(cfg->max_members, 4u);
  EXPECT_EQ(cfg->stun_urls, (std::vector<std::string>{"stun:x:3478"}));
  EXPECT_EQ(cfg->turn_urls.size(), 2u);
  EXPECT_EQ(cfg->turn_secret, "t");
  EXPECT_EQ(cfg->turn_ttl_s, 60);
}

TEST(LoadConfig, AcceptsPortOnlyAddress) {
  auto vars = minimal();
  vars["VOICE_CORE_ADDR"] = ":8090";
  auto cfg = load_config(env_of(vars));
  ASSERT_TRUE(cfg.has_value());
  EXPECT_EQ(cfg->host, "0.0.0.0");
  EXPECT_EQ(cfg->port, 8090);
}

TEST(LoadConfig, RequiresSecretAndRedis) {
  auto vars = minimal();
  vars.erase("JWT_SECRET");
  EXPECT_FALSE(load_config(env_of(vars)).has_value());
  vars = minimal();
  vars["JWT_SECRET"] = "";
  EXPECT_FALSE(load_config(env_of(vars)).has_value());
  vars = minimal();
  vars.erase("REDIS_URL");
  EXPECT_FALSE(load_config(env_of(vars)).has_value());
}

TEST(LoadConfig, RejectsInvalidNumbers) {
  for (auto [key, value] : std::vector<std::pair<std::string, std::string>>{{"VOICE_CORE_ADDR", "localhost"},
                                                                            {"VOICE_CORE_ADDR", "x:99999"},
                                                                            {"VOICE_CORE_ADDR", "x:abc"},
                                                                            {"VOICE_MAX_MEMBERS", "1"},
                                                                            {"VOICE_MAX_MEMBERS", "17"},
                                                                            {"VOICE_MAX_MEMBERS", "ocho"},
                                                                            {"TURN_TTL_SECONDS", "0"},
                                                                            {"TURN_TTL_SECONDS", "-5"}}) {
    auto vars = minimal();
    vars[key] = value;
    auto cfg = load_config(env_of(vars));
    EXPECT_FALSE(cfg.has_value()) << key << "=" << value;
    if (!cfg) {
      EXPECT_NE(cfg.error().find(key), std::string::npos) << cfg.error();
    }
  }
}

TEST(LoadConfig, TurnUrlsNeedSecret) {
  auto vars = minimal();
  vars["TURN_URLS"] = "turn:x:3478";
  auto cfg = load_config(env_of(vars));
  ASSERT_FALSE(cfg.has_value());
  EXPECT_NE(cfg.error().find("TURN_SECRET"), std::string::npos);
}
