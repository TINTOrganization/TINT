cmake_minimum_required(VERSION 3.25)
project(voice_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(VOICE_BUILD_TESTS "Compilar las pruebas (GoogleTest)" ON)
option(VOICE_COVERAGE "Instrumentar para cobertura (gcov/gcovr)" OFF)
set(VOICE_SANITIZE "" CACHE STRING "Sanitizer: address (ASan+UBSan) o thread (TSan)")

find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Boost 1.83 REQUIRED CONFIG)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(HIREDIS REQUIRED IMPORTED_TARGET hiredis)

add_compile_options(-Wall -Wextra -Wpedantic -Werror)

if(VOICE_SANITIZE STREQUAL "address")
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_link_options(-fsanitize=address,undefined)
elseif(VOICE_SANITIZE STREQUAL "thread")
  # -Wno-tsan: GCC avisa de atomic_thread_fence dentro de libstdc++/Boost, no de nuestro código.
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer -Wno-tsan)
  add_link_options(-fsanitize=thread)
endif()

if(VOICE_COVERAGE)
  add_compile_options(--coverage -O0 -fno-inline)
  add_link_options(--coverage)
endif()

# Lógica del servicio en una biblioteca: el binario y las pruebas la comparten.
add_library(voice_core_lib
  src/auth/base64url.cpp
  src/auth/token_verifier.cpp
  src/config.cpp
  src/domain/voice_room.cpp
  src/hub/hub.cpp
  src/ice/ice_servers.cpp
  src/net/handshake.cpp
  src/net/mute_api.cpp
  src/net/server.cpp
  src/protocol/messages.cpp
  src/redis/connection.cpp
  src/redis/mute_store.cpp
  src/redis/redis_url.cpp
  src/redis/revocation.cpp
  src/util/uuid.cpp
)
target_include_directories(voice_core_lib PUBLIC src)
target_compile_definitions(voice_core_lib PUBLIC BOOST_ASIO_NO_DEPRECATED)
target_link_libraries(voice_core_lib PUBLIC
  Boost::headers OpenSSL::Crypto nlohmann_json::nlohmann_json PkgConfig::HIREDIS Threads::Threads)

add_executable(voice-core src/main.cpp)
target_link_libraries(voice-core PRIVATE voice_core_lib)

if(VOICE_BUILD_TESTS)
  enable_testing()
  find_package(GTest REQUIRED)
  add_executable(voice_core_tests
    tests/base64url_test.cpp
    tests/token_verifier_test.cpp
    tests/config_test.cpp
    tests/voice_room_test.cpp
    tests/messages_test.cpp
    tests/hub_test.cpp
    tests/ice_servers_test.cpp
    tests/handshake_test.cpp
    tests/mute_api_test.cpp
    tests/mute_store_test.cpp
    tests/redis_url_test.cpp
    tests/revocation_test.cpp
    tests/server_test.cpp
    tests/uuid_test.cpp
  )
  target_include_directories(voice_core_tests PRIVATE tests)
  target_link_libraries(voice_core_tests PRIVATE voice_core_lib GTest::gtest GTest::gmock GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(voice_core_tests DISCOVERY_TIMEOUT 30)
endif()
