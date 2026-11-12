#include "redis/redis_url.hpp"

#include <gtest/gtest.h>

using voice::redis::parse_redis_url;

TEST(RedisUrl, ParsesHostAndDefaultPort) {
  auto ep = parse_redis_url("redis://redis");
  ASSERT_TRUE(ep.has_value());
  EXPECT_EQ(ep->host, "redis");
  EXPECT_EQ(ep->port, 6379);
  EXPECT_EQ(ep->password, "");
  EXPECT_EQ(ep->db, 0);
}

TEST(RedisUrl, ParsesEverything) {
  auto ep = parse_redis_url("redis://user:p%40ss@cache.local:6380/2");
  ASSERT_TRUE(ep.has_value()) << ep.error();
  EXPECT_EQ(ep->host, "cache.local");
  EXPECT_EQ(ep->port, 6380);
  EXPECT_EQ(ep->password, "p@ss");
  EXPECT_EQ(ep->db, 2);

  auto only_pass = parse_redis_url("redis://:secreto@localhost:6379/");
  ASSERT_TRUE(only_pass.has_value());
  EXPECT_EQ(only_pass->password, "secreto");
  EXPECT_EQ(only_pass->db, 0);
}

TEST(RedisUrl, RejectsInvalidUrls) {
  for (const char* url :
       {"", "http://redis", "redis://", "redis://h:abc", "redis://h:70000", "redis://h/x", "rediss://h"}) {
    EXPECT_FALSE(parse_redis_url(url).has_value()) << url;
  }
}
