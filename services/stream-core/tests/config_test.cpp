#include "config.hpp"

#include <gtest/gtest.h>

#include <map>

using namespace stream;

namespace {

EnvLookup env(std::map<std::string, std::string> values) {
  values.try_emplace("JWT_SECRET", "s");
  values.try_emplace("REDIS_URL", "redis://redis:6379");
  values.try_emplace("STREAM_PUBLIC_IP", "127.0.0.1");
  values.try_emplace("IDENTITY_API_URL", "http://identity-api:8081");
  values.try_emplace("INTERNAL_API_SECRET", "internal");
  return [values](std::string_view key) -> std::optional<std::string> {
    auto it = values.find(std::string(key));
    if (it == values.end()) return std::nullopt;
    return it->second;
  };
}

}  // namespace

TEST(Config, Defaults) {
  auto c = load_config(env({}));
  ASSERT_TRUE(c) << c.error();
  EXPECT_EQ(c->port, 8086);
  EXPECT_EQ(c->udp_port, 8087);
  EXPECT_EQ(c->max_viewers, 50);
  EXPECT_EQ(c->host_grace_s, 60);
  EXPECT_EQ(c->jwt_issuer, "tint-identity");
  EXPECT_EQ(c->jwt_audience, "tint:room");
  EXPECT_EQ(c->allowed_origins, (std::vector<std::string>{"localhost:5173", "127.0.0.1:5173"}));
}

TEST(Config, RequiredVariablesFailClosed) {
  for (const char* key :
       {"JWT_SECRET", "REDIS_URL", "STREAM_PUBLIC_IP", "IDENTITY_API_URL", "INTERNAL_API_SECRET"}) {
    auto c = load_config(env({{key, ""}}));
    ASSERT_FALSE(c) << key;
    EXPECT_NE(c.error().find(key), std::string::npos);
  }
}

TEST(Config, ParsesAddressesAndLists) {
  auto c = load_config(env({{"STREAM_CORE_ADDR", ":9000"},
                            {"STREAM_UDP_PORT", "40000"},
                            {"ALLOWED_ORIGINS", " a.example , b.example:443 "},
                            {"STUN_URLS", "stun:x:3478"},
                            {"TURN_URLS", "turn:x:3478?transport=udp"},
                            {"TURN_SECRET", "t"},
                            {"TURN_TTL_SECONDS", "600"}}));
  ASSERT_TRUE(c) << c.error();
  EXPECT_EQ(c->port, 9000);
  EXPECT_EQ(c->host, "0.0.0.0");
  EXPECT_EQ(c->udp_port, 40000);
  EXPECT_EQ(c->allowed_origins, (std::vector<std::string>{"a.example", "b.example:443"}));
  EXPECT_EQ(c->turn_ttl_s, 600);
}

TEST(Config, ViewerCapacityRange) {
  EXPECT_EQ(load_config(env({{"STREAM_MAX_VIEWERS", "1"}}))->max_viewers, 1);
  EXPECT_FALSE(load_config(env({{"STREAM_MAX_VIEWERS", "0"}})));
  EXPECT_FALSE(load_config(env({{"STREAM_MAX_VIEWERS", "51"}}))) << "meta medida: 50 por sala (ADR 0017)";
  EXPECT_FALSE(load_config(env({{"STREAM_MAX_VIEWERS", "muchos"}})));
}

TEST(Config, GraceRange) {
  EXPECT_EQ(load_config(env({{"STREAM_HOST_GRACE_S", "10"}}))->host_grace_s, 10);
  EXPECT_EQ(load_config(env({{"STREAM_HOST_GRACE_S", "300"}}))->host_grace_s, 300);
  EXPECT_FALSE(load_config(env({{"STREAM_HOST_GRACE_S", "9"}})));
  EXPECT_FALSE(load_config(env({{"STREAM_HOST_GRACE_S", "301"}})));
}

TEST(Config, RejectsBadPortsAndTurnWithoutSecret) {
  EXPECT_FALSE(load_config(env({{"STREAM_CORE_ADDR", "sin-puerto"}})));
  EXPECT_FALSE(load_config(env({{"STREAM_CORE_ADDR", ":99999"}})));
  EXPECT_FALSE(load_config(env({{"STREAM_UDP_PORT", "0"}})));
  EXPECT_FALSE(load_config(env({{"TURN_URLS", "turn:x"}})));
  EXPECT_FALSE(load_config(env({{"TURN_TTL_SECONDS", "-1"}})));
}
