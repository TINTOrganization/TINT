#include "util/uuid.hpp"

#include <regex>
#include <set>
#include <thread>

#include <gtest/gtest.h>

TEST(Uuid, IsVersion4) {
  const std::regex v4("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  for (int i = 0; i < 100; ++i) EXPECT_TRUE(std::regex_match(voice::util::new_uuid(), v4));
}

TEST(Uuid, IsUniqueAcrossThreads) {
  std::set<std::string> all;
  std::mutex mu;
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t)
    threads.emplace_back([&] {
      for (int i = 0; i < 500; ++i) {
        auto id = voice::util::new_uuid();
        std::lock_guard lock(mu);
        all.insert(id);
      }
    });
  for (auto& th : threads) th.join();
  EXPECT_EQ(all.size(), 2000u);
}
