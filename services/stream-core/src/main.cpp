// stream-core: ensamblado y señales (fuera de la cobertura; cada pieza tiene sus pruebas).
#include <boost/asio.hpp>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <rtc/rtc.hpp>
#include <thread>

#include "config.hpp"
#include "http/handler.hpp"
#include "identity/identity_client.hpp"
#include "log/log.hpp"
#include "net/http_server.hpp"
#include "redis/stores.hpp"
#include "rtc/peer_factory.hpp"
#include "service/stream_service.hpp"

using namespace stream;

namespace {

std::int64_t wall_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

int main() {
  const char* raw_level = std::getenv("LOG_LEVEL");
  auto level = logging::parse_level(raw_level == nullptr ? "" : raw_level);
  if (!level) {
    std::cerr << "stream-core: " << level.error() << std::endl;
    return 2;
  }
  logging::configure("stream-core", *level);
  auto config = load_config([](std::string_view key) -> std::optional<std::string> {
    if (const char* v = std::getenv(std::string(key).c_str())) return std::string(v);
    return std::nullopt;
  });
  if (!config) {
    logging::error("configuración inválida: " + config.error());
    return 2;
  }
  auto endpoint = redis::parse_redis_url(config->redis_url);
  auto identity_target = identity::parse_http_url(config->identity_api_url);
  if (!endpoint || !identity_target) {
    logging::error("REDIS_URL o IDENTITY_API_URL inválidas");
    return 2;
  }

  rtc::InitLogger(rtc::LogLevel::Warning);

  redis::RedisClient redis_client(*endpoint, std::chrono::milliseconds(500));
  redis::RedisRevocationChecker revocation(redis_client);
  redis::RedisRoomStore room_store(redis_client);
  identity::HttpIdentityClient identity_client(*identity_target, config->internal_api_secret);
  rtc_adapter::PeerFactoryConfig peer_config;
  peer_config.udp_port = config->udp_port;
  peer_config.public_ip = config->public_ip;
  rtc_adapter::LibDataChannelPeerFactory peers(peer_config);

  boost::asio::io_context io;
  boost::asio::thread_pool workers(4);

  service::ServiceConfig service_config;
  service_config.max_viewers = config->max_viewers;
  service_config.host_grace = std::chrono::seconds(config->host_grace_s);
  service::StreamService svc(
      service_config, peers, room_store, identity_client, wall_ms,
      [&workers](std::function<void()> job) { boost::asio::post(workers, std::move(job)); });

  auth::TokenVerifier verifier(config->jwt_secret, config->jwt_issuer, config->jwt_audience);
  http::Handler handler({verifier, revocation, room_store, svc,
                         ice::IceConfig{config->stun_urls, config->turn_urls, config->turn_secret,
                                        std::chrono::seconds(config->turn_ttl_s)},
                         config->allowed_origins, config->max_viewers, [] { return wall_ms() / 1000; }});

  net::HttpServer server(io, workers, [&handler](const http::Request& r) { return handler.handle(r); });
  if (!server.listen(config->host, config->port)) {
    logging::error("no se pudo escuchar en " + config->host + ":" + std::to_string(config->port));
    return 1;
  }

  redis::SyncListener listener(*endpoint, [&](const redis::SyncMessage& m) {
    boost::asio::post(workers, [&svc, m] {
      if (m.type == redis::SyncMessage::Type::RoomClosed)
        svc.on_room_closed(m.room_id, m.reason);
      else
        svc.on_revoked(m.jti);
    });
  });
  listener.start();

  // Gracia, watchdog, capas y viewer_count cada 250 ms.
  boost::asio::steady_timer timer(io);
  std::function<void()> schedule = [&] {
    timer.expires_after(std::chrono::milliseconds(250));
    timer.async_wait([&](boost::system::error_code ec) {
      if (ec) return;
      boost::asio::post(workers, [&svc] { svc.tick(); });
      schedule();
    });
  };
  schedule();

  boost::asio::signal_set signals(io, SIGINT, SIGTERM);
  signals.async_wait([&](auto, int) {
    logging::info("apagando");
    timer.cancel();
    server.stop();
    io.stop();
  });

  logging::info("escuchando en :" + std::to_string(server.port()) + " (UDP " +
                std::to_string(config->udp_port) + ")");
  std::thread second([&io] { io.run(); });
  io.run();
  second.join();
  listener.stop();
  workers.join();
  return 0;
}
