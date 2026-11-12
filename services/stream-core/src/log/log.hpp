#pragma once

#include <chrono>
#include <cstdint>
#include <expected>
#include <string>
#include <string_view>

// Logs JSON a stdout con nivel configurable (ADR 0021). Una línea por evento:
// {"timestamp":"...","level":"info","service":"stream-core","message":"..."}
namespace stream::logging {

enum class Level : std::uint8_t { kDebug = 0, kInfo = 1, kWarn = 2, kError = 3 };

// `LOG_LEVEL`: debug|info|warn|error, sin distinguir mayúsculas; vacío = info.
std::expected<Level, std::string> parse_level(std::string_view raw);

std::string_view level_name(Level level);

// Entrada JSON completa (con salto de línea final). `at` se inyecta para las pruebas.
std::string format_entry(std::string_view service, Level level, std::string_view message,
                         std::chrono::system_clock::time_point at);

// Fija el nombre del servicio y el umbral. Se llama una vez, antes de arrancar los hilos.
void configure(std::string_view service, Level level);
void set_threshold(Level level);
Level threshold();
std::string_view service();

bool enabled(Level level);

// Escribe la entrada si el nivel alcanza el umbral; nunca lanza.
void write(Level level, std::string_view message);

inline void debug(std::string_view message) { write(Level::kDebug, message); }
inline void info(std::string_view message) { write(Level::kInfo, message); }
inline void warn(std::string_view message) { write(Level::kWarn, message); }
inline void error(std::string_view message) { write(Level::kError, message); }

}  // namespace stream::logging
