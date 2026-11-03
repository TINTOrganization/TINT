cmake_minimum_required(VERSION 3.25)
project(stream_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(STREAM_BUILD_TESTS "Compilar las pruebas (GoogleTest)" ON)
option(STREAM_BUILD_RTC "Compilar el adaptador WebRTC (libdatachannel) y el binario" ON)
option(STREAM_COVERAGE "Instrumentar para cobertura (gcov/gcovr)" OFF)
set(STREAM_SANITIZE "" CACHE STRING "Sanitizer: address (ASan+UBSan) o thread (TSan)")

find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Boost 1.83 REQUIRED CONFIG)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(HIREDIS REQUIRED IMPORTED_TARGET hiredis)

# Los warnings se aplican por target (ADR 0018): no deben alcanzar a libdatachannel.
set(STREAM_WARNINGS -Wall -Wextra -Wpedantic -Werror)

if(STREAM_SANITIZE STREQUAL "address")
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_link_options(-fsanitize=address,undefined)
elseif(STREAM_SANITIZE STREQUAL "thread")
  # -Wno-tsan: GCC 14 avisa de atomic_thread_fence dentro de libstdc++/Boost.Asio, no de nuestro código
  # (igual que voice-core). Con -Werror, sin esto el build de TSan no compila.
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer -Wno-tsan)
  add_link_options(-fsanitize=thread)
endif()

if(STREAM_COVERAGE)
  add_compile_options(--coverage -O0 -fno-inline)
  add_link_options(--coverage)
endif()

# Lógica pura y adaptadores de Redis/HTTP: sin libdatachannel, la prueban las suites unitarias.
# Todo src/ salvo el adaptador WebRTC (src/rtc/) y main.cpp.
file(GLOB_RECURSE STREAM_LIB_SOURCES CONFIGURE_DEPENDS src/*.cpp)
list(FILTER STREAM_LIB_SOURCES EXCLUDE REGEX "/src/(rtc/|main\.cpp$)")
add_library(stream_core_lib ${STREAM_LIB_SOURCES})
target_include_directories(stream_core_lib PUBLIC src)
target_compile_options(stream_core_lib PRIVATE ${STREAM_WARNINGS})
target_compile_definitions(stream_core_lib PUBLIC BOOST_ASIO_NO_DEPRECATED)
target_link_libraries(stream_core_lib PUBLIC
  Boost::headers OpenSSL::Crypto nlohmann_json::nlohmann_json PkgConfig::HIREDIS Threads::Threads)

if(STREAM_BUILD_RTC)
  # Adaptador WebRTC: el único código que enlaza libdatachannel (ADR 0018).
  find_package(LibDataChannel 0.24 REQUIRED)
  file(GLOB STREAM_RTC_SOURCES CONFIGURE_DEPENDS src/rtc/*.cpp)
  add_library(stream_core_rtc ${STREAM_RTC_SOURCES})
  target_compile_options(stream_core_rtc PRIVATE ${STREAM_WARNINGS})
  target_link_libraries(stream_core_rtc PUBLIC stream_core_lib LibDataChannel::LibDataChannel)
  if(EXISTS ${CMAKE_SOURCE_DIR}/src/main.cpp)
    add_executable(stream-core src/main.cpp)
    target_compile_options(stream-core PRIVATE ${STREAM_WARNINGS})
    target_link_libraries(stream-core PRIVATE stream_core_rtc)
  endif()

  # Spike S2 (make load-stream): bots WHIP/WHEP con libdatachannel. No es una prueba ni cuenta en la
  # cobertura (gcovr filtra src/).
  option(STREAM_BUILD_LOADBOT "Compilar el bot de carga (loadtest/loadbot.cpp)" OFF)
  if(STREAM_BUILD_LOADBOT)
    add_executable(stream_core_loadbot loadtest/loadbot.cpp)
    target_include_directories(stream_core_loadbot PRIVATE tests)
    target_compile_options(stream_core_loadbot PRIVATE ${STREAM_WARNINGS} -Wno-missing-field-initializers)
    target_link_libraries(stream_core_loadbot PRIVATE stream_core_lib LibDataChannel::LibDataChannel)
  endif()
endif()

if(STREAM_BUILD_TESTS)
  enable_testing()
  find_package(GTest REQUIRED)
  file(GLOB STREAM_TEST_SOURCES CONFIGURE_DEPENDS tests/*_test.cpp)
  list(FILTER STREAM_TEST_SOURCES EXCLUDE REGEX "/tests/rtc_.*_test\.cpp$")
  add_executable(stream_core_tests ${STREAM_TEST_SOURCES})
  target_include_directories(stream_core_tests PRIVATE tests)
  # Las pruebas usan inicializadores designados parciales a propósito.
  target_compile_options(stream_core_tests PRIVATE ${STREAM_WARNINGS} -Wno-missing-field-initializers)
  target_link_libraries(stream_core_tests PRIVATE stream_core_lib GTest::gtest GTest::gmock GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(stream_core_tests DISCOVERY_TIMEOUT 30)

  if(STREAM_BUILD_RTC)
    # Integración con libdatachannel real (loopback en el mismo proceso).
    file(GLOB STREAM_RTC_TEST_SOURCES CONFIGURE_DEPENDS tests/rtc_*_test.cpp)
    add_executable(stream_core_rtc_tests ${STREAM_RTC_TEST_SOURCES})
    target_include_directories(stream_core_rtc_tests PRIVATE tests)
    target_compile_options(stream_core_rtc_tests PRIVATE ${STREAM_WARNINGS} -Wno-missing-field-initializers)
    target_link_libraries(stream_core_rtc_tests PRIVATE stream_core_rtc GTest::gtest GTest::gtest_main)
    gtest_discover_tests(stream_core_rtc_tests DISCOVERY_TIMEOUT 30)
  endif()

  # Microbenchmark del camino caliente (no es una prueba; ver loadtest/README en AGENTS.md).
  add_executable(stream_core_bench loadtest/forward_bench.cpp)
  target_include_directories(stream_core_bench PRIVATE tests)
  target_compile_options(stream_core_bench PRIVATE ${STREAM_WARNINGS} -Wno-missing-field-initializers)
  target_link_libraries(stream_core_bench PRIVATE stream_core_lib)
endif()
