// voice-core: Canal de Voz de TINT. Une las piezas y atiende señales de parada.
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

#include <boost/asio/io_context.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/signal_set.hpp>
#include <boost/asio/thread_pool.hpp>

#include "auth/token_verifier.hpp"
#include "config.hpp"
#include "hub/hub.hpp"
#include "net/server.hpp"
#include "redis/mute_store.hpp"
#include "redis/redis_url.hpp"
#include "redis/revocation.hpp"
#include "util/uuid.hpp"

int main() {
  using namespace voice;
  auto config = load_config([](std::string_view key) -> std::optional<std::string> {
    const char* value = std::getenv(std::string(key).c_str());
    return value ? std::optional<std::string>(value) : std::nullopt;
  });
  if (!config) {
    std::cerr << "voice-core: configuración inválida: " << config.error() << "\n";
    return 2;
  }
  auto endpoint = redis::parse_redis_url(config->redis_url);
  if (!endpoint) {
    std::cerr << "voice-core: " << endpoint.error() << "\n";
    return 2;
  }

  auto mutes = std::make_shared<redis::RedisMuteStore>(*endpoint, std::chrono::milliseconds(500));
  // host_mute por WebSocket escribe en Redis: fuera de los hilos del io_context.
  boost::asio::thread_pool moderation_pool(1);

  hub::HubOptions options;
  options.mutes = mutes;
  options.run_blocking = [&moderation_pool](std::function<void()> task) {
    boost::asio::post(moderation_pool, std::move(task));
  };
  options.max_members = config->max_members;
  options.now_ms = [] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  };
  options.new_event_id = util::new_uuid;
  // Fase 1: solo STUN. Las credenciales TURN efímeras llegan en la Fase 3.
  const auto stun_urls = config->stun_urls;
  options.ice_servers = [stun_urls](const auth::Claims&) {
    nlohmann::json servers = nlohmann::json::array();
    if (!stun_urls.empty()) servers.push_back({{"urls", stun_urls}});
    return servers;
  };
  auto hub = std::make_shared<hub::Hub>(std::move(options));

  auto verifier =
      std::make_shared<auth::TokenVerifier>(config->jwt_secret, config->jwt_issuer, config->jwt_audience);
  auto revocation =
      std::make_shared<redis::RedisRevocationChecker>(*endpoint, std::chrono::milliseconds(500));

  boost::asio::io_context ioc;
  net::Server server(ioc, {config->allowed_origins}, verifier, revocation, mutes, hub);
  const auto port = server.listen(config->host, config->port);

  redis::RevokedListener listener(
      *endpoint, [hub](const std::string& room_id, const std::string& jti) { hub->revoke(room_id, jti); });
  listener.start();

  boost::asio::signal_set signals(ioc, SIGINT, SIGTERM);
  signals.async_wait([&](const boost::system::error_code&, int) {
    server.stop();
    ioc.stop();
  });

  std::cout << "voice-core escuchando en " << config->host << ":" << port << " (/ws/voice, /healthz)"
            << std::endl;
  const unsigned threads = std::max(2u, std::thread::hardware_concurrency());
  std::vector<std::thread> workers;
  for (unsigned i = 1; i < threads; ++i) workers.emplace_back([&ioc] { ioc.run(); });
  ioc.run();
  for (auto& w : workers) w.join();
  listener.stop();
  moderation_pool.join();
  return 0;
}
