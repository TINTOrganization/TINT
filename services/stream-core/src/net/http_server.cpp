#include "net/http_server.hpp"

#include <boost/asio/dispatch.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/strand.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <chrono>

namespace stream::net {

namespace beast = boost::beast;
namespace bhttp = beast::http;
using tcp = boost::asio::ip::tcp;

namespace {

http::Method to_method(bhttp::verb v) {
  switch (v) {
    case bhttp::verb::get:
      return http::Method::Get;
    case bhttp::verb::post:
      return http::Method::Post;
    case bhttp::verb::patch:
      return http::Method::Patch;
    case bhttp::verb::delete_:
      return http::Method::Delete;
    case bhttp::verb::options:
      return http::Method::Options;
    default:
      return http::Method::Other;
  }
}

class Session : public std::enable_shared_from_this<Session> {
 public:
  Session(tcp::socket socket, boost::asio::thread_pool& workers, const HttpServer::HandleFn& handle,
          std::size_t body_limit)
      : stream_(std::move(socket)), workers_(workers), handle_(handle), body_limit_(body_limit) {}

  void start() { read(); }

 private:
  void read() {
    parser_.emplace();
    parser_->body_limit(body_limit_);
    stream_.expires_after(std::chrono::seconds(30));
    bhttp::async_read(stream_, buffer_, *parser_,
                      [self = shared_from_this()](beast::error_code ec, std::size_t) { self->on_read(ec); });
  }

  void on_read(beast::error_code ec) {
    if (ec == bhttp::error::body_limit) {
      http::Response r{413,
                       {{"Content-Type", "application/json"}},
                       R"({"error":"PAYLOAD_TOO_LARGE","message":"El cuerpo supera el límite."})"};
      write(std::move(r), /*keep_alive=*/false);
      return;
    }
    if (ec) return;  // el cliente cerró o se agotó el tiempo
    auto req = parser_->release();
    http::Request request;
    request.method = to_method(req.method());
    const std::string target(req.target());
    const auto q = target.find('?');
    request.path = target.substr(0, q);
    if (q != std::string::npos) request.query = target.substr(q + 1);
    request.authorization = std::string(req[bhttp::field::authorization]);
    request.content_type = std::string(req[bhttp::field::content_type]);
    request.origin = std::string(req[bhttp::field::origin]);
    request.body = std::move(req.body());
    const bool keep_alive = req.keep_alive();

    // El handler puede esperar la recolección ICE: corre fuera del io_context.
    boost::asio::post(workers_, [self = shared_from_this(), request = std::move(request), keep_alive] {
      auto response = self->handle_(request);
      boost::asio::dispatch(self->stream_.get_executor(),
                            [self, response = std::move(response), keep_alive]() mutable {
                              self->write(std::move(response), keep_alive);
                            });
    });
  }

  void write(http::Response response, bool keep_alive) {
    auto res = std::make_shared<bhttp::response<bhttp::string_body>>(
        static_cast<bhttp::status>(response.status), 11);
    res->set(bhttp::field::server, "stream-core");
    for (auto& [name, value] : response.headers) res->insert(name, value);
    res->body() = std::move(response.body);
    res->keep_alive(keep_alive);
    res->prepare_payload();
    bhttp::async_write(stream_, *res,
                       [self = shared_from_this(), res, keep_alive](beast::error_code ec, std::size_t) {
                         if (ec) return;
                         if (keep_alive)
                           self->read();
                         else {
                           beast::error_code ignored;
                           self->stream_.socket().shutdown(tcp::socket::shutdown_send, ignored);
                         }
                       });
  }

  beast::tcp_stream stream_;
  boost::asio::thread_pool& workers_;
  const HttpServer::HandleFn& handle_;
  std::size_t body_limit_;
  beast::flat_buffer buffer_;
  std::optional<bhttp::request_parser<bhttp::string_body>> parser_;
};

}  // namespace

HttpServer::HttpServer(boost::asio::io_context& io, boost::asio::thread_pool& workers, HandleFn handle,
                       std::size_t body_limit)
    : io_(io), workers_(workers), handle_(std::move(handle)), body_limit_(body_limit), acceptor_(io) {}

bool HttpServer::listen(const std::string& host, unsigned short port) {
  beast::error_code ec;
  tcp::endpoint endpoint(boost::asio::ip::make_address(host, ec), port);
  if (ec) return false;
  acceptor_.open(endpoint.protocol(), ec);
  if (ec) return false;
  acceptor_.set_option(boost::asio::socket_base::reuse_address(true), ec);
  acceptor_.bind(endpoint, ec);
  if (ec) return false;
  acceptor_.listen(boost::asio::socket_base::max_listen_connections, ec);
  if (ec) return false;
  port_ = acceptor_.local_endpoint().port();
  accept();
  return true;
}

void HttpServer::accept() {
  acceptor_.async_accept(boost::asio::make_strand(io_), [this](beast::error_code ec, tcp::socket socket) {
    if (ec) return;  // el acceptor se cerró
    std::make_shared<Session>(std::move(socket), workers_, handle_, body_limit_)->start();
    accept();
  });
}

void HttpServer::stop() {
  boost::asio::post(io_, [this] {
    beast::error_code ec;
    acceptor_.close(ec);
  });
}

}  // namespace stream::net
