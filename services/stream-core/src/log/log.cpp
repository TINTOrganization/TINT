#include "log/log.hpp"

#include <atomic>
#include <cctype>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>

namespace stream::logging {
namespace {

std::atomic<Level> g_threshold{Level::kInfo};
std::mutex g_write_mutex;
std::string g_service{"stream-core"};

std::string escape(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  for (const char ch : text) {
    switch (ch) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          constexpr char kHex[] = "0123456789abcdef";
          out += "\\u00";
          out += kHex[static_cast<unsigned char>(ch) >> 4];
          out += kHex[static_cast<unsigned char>(ch) & 0x0F];
        } else {
          out += ch;
        }
    }
  }
  return out;
}

std::string format_time(std::chrono::system_clock::time_point at) {
  const auto seconds = std::chrono::floor<std::chrono::seconds>(at);
  const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(at - seconds).count();
  const std::time_t raw = std::chrono::system_clock::to_time_t(seconds);
  std::tm utc{};
  gmtime_r(&raw, &utc);
  std::ostringstream out;
  out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setfill('0') << std::setw(3) << millis
      << 'Z';
  return out.str();
}

}  // namespace

std::expected<Level, std::string> parse_level(std::string_view raw) {
  std::string value;
  value.reserve(raw.size());
  for (const char ch : raw) {
    if (ch != ' ' && ch != '\t') value += static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  }
  if (value.empty() || value == "info") return Level::kInfo;
  if (value == "debug") return Level::kDebug;
  if (value == "warn") return Level::kWarn;
  if (value == "error") return Level::kError;
  return std::unexpected("LOG_LEVEL inválido: usa debug|info|warn|error");
}

std::string_view level_name(Level level) {
  switch (level) {
    case Level::kDebug:
      return "debug";
    case Level::kInfo:
      return "info";
    case Level::kWarn:
      return "warn";
    case Level::kError:
      return "error";
  }
  return "info";
}

std::string format_entry(std::string_view service_name, Level level, std::string_view message,
                         std::chrono::system_clock::time_point at) {
  std::string out;
  out.reserve(message.size() + 96);
  out += R"({"timestamp":")";
  out += format_time(at);
  out += R"(","level":")";
  out += level_name(level);
  out += R"(","service":")";
  out += escape(service_name);
  out += R"(","message":")";
  out += escape(message);
  out += "\"}\n";
  return out;
}

void configure(std::string_view name, Level level) {
  g_service.assign(name);
  g_threshold.store(level);
}

void set_threshold(Level level) { g_threshold.store(level); }

Level threshold() { return g_threshold.load(); }

std::string_view service() { return g_service; }

bool enabled(Level level) { return static_cast<int>(level) >= static_cast<int>(g_threshold.load()); }

void write(Level level, std::string_view message) {
  if (!enabled(level)) return;
  const std::string line = format_entry(g_service, level, message, std::chrono::system_clock::now());
  const std::lock_guard<std::mutex> lock(g_write_mutex);
  std::cout << line << std::flush;
}

}  // namespace stream::logging
