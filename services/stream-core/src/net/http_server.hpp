#pragma once

#include <atomic>
#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/thread_pool.hpp>
#include <cstddef>
#include <functional>
#include <memory>

#include "http/handler.hpp"

namespace stream::net {

// Servidor HTTP/1.1 (Boost.Beast) para /healthz, WHIP/WHEP y las rutas internas.
// La lectura y la escritura van en el io_context; Handler::handle (que puede esperar la
// recolección ICE, ≤ 1.5 s) corre en el pool de trabajo para no bloquear la red.
class HttpServer {
 public:
  using HandleFn = std::function<http::Response(const http::Request&)>;

  HttpServer(boost::asio::io_context& io, boost::asio::thread_pool& workers, HandleFn handle,
             std::size_t body_limit = 64 * 1024 + 4096);

  // Escucha en host:port (port 0 = efímero). Devuelve false si no pudo abrir el puerto.
  bool listen(const std::string& host, unsigned short port);
  unsigned short port() const { return port_; }
  void stop();

 private:
  void accept();

  boost::asio::io_context& io_;
  boost::asio::thread_pool& workers_;
  HandleFn handle_;
  std::size_t body_limit_;
  boost::asio::ip::tcp::acceptor acceptor_;
  unsigned short port_ = 0;
};

}  // namespace stream::net
