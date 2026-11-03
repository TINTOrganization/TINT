#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <sstream>
#include <string>

#include "log/log.hpp"

namespace {

using voice::logging::Level;

std::string render(Level level, std::string_view message) {
  return voice::logging::format_entry("voice-core", level, message, std::chrono::system_clock::time_point{});
}

class LogTest : public ::testing::Test {
 protected:
  void SetUp() override { voice::logging::configure("voice-core", Level::kInfo); }
  void TearDown() override { voice::logging::set_threshold(Level::kInfo); }
};

TEST(ParseLevel, AcceptsTheDocumentedValuesCaseInsensitivelyAndEmptyAsInfo) {
  EXPECT_EQ(voice::logging::parse_level("debug"), Level::kDebug);
  EXPECT_EQ(voice::logging::parse_level("INFO"), Level::kInfo);
  EXPECT_EQ(voice::logging::parse_level("Warn"), Level::kWarn);
  EXPECT_EQ(voice::logging::parse_level(" error "), Level::kError);
  EXPECT_EQ(voice::logging::parse_level(""), Level::kInfo);
}

TEST(ParseLevel, RejectsUnknownValuesMentioningLogLevel) {
  auto parsed = voice::logging::parse_level("verbose");
  ASSERT_FALSE(parsed.has_value());
  EXPECT_NE(parsed.error().find("LOG_LEVEL"), std::string::npos);
}

TEST_F(LogTest, FormatEntryIsOneLineJsonWithTheContractFields) {
  const std::string line = render(Level::kWarn, "algo pasó");
  EXPECT_EQ(line.back(), '\n');
  EXPECT_NE(line.find("\"level\":\"warn\""), std::string::npos);
  EXPECT_NE(line.find("\"service\":\"voice-core\""), std::string::npos);
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
  voice::logging::set_threshold(Level::kWarn);
  EXPECT_FALSE(voice::logging::enabled(Level::kDebug));
  EXPECT_FALSE(voice::logging::enabled(Level::kInfo));
  EXPECT_TRUE(voice::logging::enabled(Level::kWarn));
  EXPECT_TRUE(voice::logging::enabled(Level::kError));
  EXPECT_EQ(voice::logging::threshold(), Level::kWarn);
}

TEST_F(LogTest, WriteFiltersBelowTheThresholdAndEmitsJsonAbove) {
  voice::logging::set_threshold(Level::kWarn);
  std::ostringstream captured;
  auto* previous = std::cout.rdbuf(captured.rdbuf());

  voice::logging::info("oculto");
  EXPECT_EQ(captured.str(), "");

  voice::logging::warn("visible");
  std::cout.rdbuf(previous);

  const std::string output = captured.str();
  EXPECT_NE(output.find("\"level\":\"warn\""), std::string::npos);
  EXPECT_NE(output.find("\"message\":\"visible\""), std::string::npos);
}

}  // namespace
