#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <sstream>
#include <string>

#include "log/log.hpp"

namespace {

using stream::logging::Level;

std::string render(Level level, std::string_view message) {
  return stream::logging::format_entry("stream-core", level, message,
                                       std::chrono::system_clock::time_point{});
}

class LogTest : public ::testing::Test {
 protected:
  void SetUp() override { stream::logging::configure("stream-core", Level::kInfo); }
  void TearDown() override { stream::logging::set_threshold(Level::kInfo); }
};

TEST(ParseLevel, AcceptsTheDocumentedValuesCaseInsensitivelyAndEmptyAsInfo) {
  EXPECT_EQ(stream::logging::parse_level("debug"), Level::kDebug);
  EXPECT_EQ(stream::logging::parse_level("INFO"), Level::kInfo);
  EXPECT_EQ(stream::logging::parse_level("Warn"), Level::kWarn);
  EXPECT_EQ(stream::logging::parse_level(" error "), Level::kError);
  EXPECT_EQ(stream::logging::parse_level(""), Level::kInfo);
}

TEST(ParseLevel, RejectsUnknownValuesMentioningLogLevel) {
  auto parsed = stream::logging::parse_level("verbose");
  ASSERT_FALSE(parsed.has_value());
  EXPECT_NE(parsed.error().find("LOG_LEVEL"), std::string::npos);
}

TEST_F(LogTest, FormatEntryIsOneLineJsonWithTheContractFields) {
  const std::string line = render(Level::kWarn, "algo pasó");
  EXPECT_EQ(line.back(), '\n');
  EXPECT_NE(line.find("\"level\":\"warn\""), std::string::npos);
  EXPECT_NE(line.find("\"service\":\"stream-core\""), std::string::npos);
  EXPECT_NE(line.find("\"message\":\"algo pasó\""), std::string::npos);
  EXPECT_NE(line.find("\"timestamp\":\""), std::string::npos);
  EXPECT_LT(line.find("\"timestamp\""), line.find("\"level\""));
  EXPECT_EQ(std::count(line.begin(), line.end(), '\n'), 1);
}

TEST_F(LogTest, FormatEntryEscapesQuotesBackslashesAndControlCharacters) {
  const std::string line = render(Level::kInfo, "di \"hola\"\\\n\tfin");
  EXPECT_NE(line.find(R"("message":"di \"hola\"\\\n\tfin")"), std::string::npos);
}

TEST_F(LogTest, EnabledFollowsTheConfiguredThreshold) {
  stream::logging::set_threshold(Level::kWarn);
  EXPECT_FALSE(stream::logging::enabled(Level::kDebug));
  EXPECT_FALSE(stream::logging::enabled(Level::kInfo));
  EXPECT_TRUE(stream::logging::enabled(Level::kWarn));
  EXPECT_TRUE(stream::logging::enabled(Level::kError));
  EXPECT_EQ(stream::logging::threshold(), Level::kWarn);
}

TEST_F(LogTest, WriteFiltersBelowTheThresholdAndEmitsJsonAbove) {
  stream::logging::set_threshold(Level::kWarn);
  std::ostringstream captured;
  auto* previous = std::cout.rdbuf(captured.rdbuf());

  stream::logging::info("oculto");
  EXPECT_EQ(captured.str(), "");

  stream::logging::warn("visible");
  std::cout.rdbuf(previous);

  const std::string output = captured.str();
  EXPECT_NE(output.find("\"level\":\"warn\""), std::string::npos);
  EXPECT_NE(output.find("\"message\":\"visible\""), std::string::npos);
}

}  // namespace
