#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/thread_pool.hpp>

#include "auth/token_verifier.hpp"
#include "hub/hub.hpp"
#include "net/handshake.hpp"

namespace voice::net {

struct ServerShared;

struct ServerOptions {
  std::vector<std::string> allowed_origins;
};

// HTTP (/healthz) y WebSocket (/ws/voice) sobre Boost.Beast. La consulta de revocación
// (bloqueante, Redis) corre en un pool aparte para no frenar el io_context.
class Server {
 public:
  Server(boost::asio::io_context& ioc, ServerOptions options, std::shared_ptr<auth::TokenVerifier> verifier,
         std::shared_ptr<RevocationChecker> revocation, std::shared_ptr<hub::Hub> hub);
  ~Server();

  // Abre el puerto (0 = cualquiera libre) y empieza a aceptar. Devuelve el puerto real.
  std::uint16_t listen(const std::string& host, std::uint16_t port);
  void stop();

 private:
  void do_accept();

  boost::asio::io_context& ioc_;
  boost::asio::thread_pool blocking_pool_{2};
  std::shared_ptr<ServerShared> shared_;
  boost::asio::ip::tcp::acceptor acceptor_;
};

}  // namespace voice::net
