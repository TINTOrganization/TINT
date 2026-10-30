#include "net/server.hpp"

#include <chrono>
#include <deque>

#include <boost/asio/dispatch.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/strand.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include "net/mute_api.hpp"
#include "protocol/messages.hpp"
#include "util/uuid.hpp"

namespace voice::net {

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
using tcp = asio::ip::tcp;

// Lo que comparten todas las sesiones.
struct ServerShared {
  ServerOptions options;
  std::shared_ptr<auth::TokenVerifier> verifier;
  std::shared_ptr<RevocationChecker> revocation;
  std::shared_ptr<moderation::MuteStore> mutes;
  std::shared_ptr<hub::Hub> hub;
  asio::thread_pool::executor_type blocking;
};

namespace {

std::int64_t now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// Conexión WebSocket ya aceptada. Es el Peer del Hub: send/close encolan en su strand.
class VoiceSession : public hub::Peer, public std::enable_shared_from_this<VoiceSession> {
 public:
  VoiceSession(beast::tcp_stream&& stream, std::shared_ptr<ServerShared> shared)
      : ws_(std::move(stream)), shared_(std::move(shared)), id_(util::new_uuid()) {}

  const std::string& id() const override { return id_; }

  // Upgrade y entrada a la voz.
  void accept_and_join(http::request<http::string_body> req, Accept accept) {
    room_id_ = std::move(accept.room_id);
    configure();
    ws_.async_accept(req, [self = shared_from_this(), claims = std::move(accept.claims),
                           host_muted = accept.host_muted](beast::error_code ec) {
      if (ec) return;
      self->do_read();
      self->joined_ = self->shared_->hub->join(self->room_id_, claims, self, host_muted);
    });
  }

  // Upgrade y cierre inmediato con un código 4xxx (estado terminal, ADR 0014).
  void accept_and_close(http::request<http::string_body> req, std::uint16_t code, std::string reason) {
    configure();
    ws_.async_accept(req,
                     [self = shared_from_this(), code, reason = std::move(reason)](beast::error_code ec) {
                       if (ec) return;
                       self->do_read();
                       self->close(code, reason);
                     });
  }

  void send(std::string text) override {
    asio::post(ws_.get_executor(), [self = shared_from_this(), text = std::move(text)]() mutable {
      if (self->closing_) return;
      self->queue_.push_back(std::move(text));
      if (!self->writing_) self->do_write();
    });
  }

  void close(std::uint16_t code, std::string reason) override {
    asio::post(ws_.get_executor(), [self = shared_from_this(), code, reason = std::move(reason)]() mutable {
      if (self->closing_ || self->close_requested_) return;
      self->close_requested_ = true;
      self->close_reason_ = websocket::close_reason(static_cast<websocket::close_code>(code), reason);
      if (!self->writing_) self->do_close();
    });
  }

 private:
  void configure() {
    // Pings de keep-alive: una red caída se detecta en ≤ 20 s aunque no llegue FIN (AC3).
    websocket::stream_base::timeout timeout =
        websocket::stream_base::timeout::suggested(beast::role_type::server);
    timeout.idle_timeout = std::chrono::seconds(20);
    timeout.keep_alive_pings = true;
    ws_.set_option(timeout);
    ws_.read_message_max(protocol::kMaxMessageBytes);
    ws_.text(true);
  }

  void do_read() {
    ws_.async_read(buffer_, [self = shared_from_this()](beast::error_code ec, std::size_t) {
      if (ec) return self->on_disconnect();
      std::string text = beast::buffers_to_string(self->buffer_.data());
      self->buffer_.consume(self->buffer_.size());
      if (self->joined_) self->shared_->hub->handle_message(self->room_id_, self->id_, text);
      self->do_read();
    });
  }

  void do_write() {
    writing_ = true;
    ws_.async_write(asio::buffer(queue_.front()),
                    [self = shared_from_this()](beast::error_code ec, std::size_t) {
                      self->writing_ = false;
                      if (ec) return self->on_disconnect();
                      self->queue_.pop_front();
                      if (!self->queue_.empty()) return self->do_write();
                      if (self->close_requested_) self->do_close();
                    });
  }

  void do_close() {
    closing_ = true;
    queue_.clear();
    ws_.async_close(close_reason_, [self = shared_from_this()](beast::error_code) {
      // La lectura pendiente termina con error y llama a on_disconnect.
    });
  }

  void on_disconnect() {
    if (disconnected_) return;
    disconnected_ = true;
    if (joined_) shared_->hub->leave(room_id_, id_);
  }

  websocket::stream<beast::tcp_stream> ws_;
  std::shared_ptr<ServerShared> shared_;
  std::string id_;
  std::string room_id_;
  beast::flat_buffer buffer_;
  std::deque<std::string> queue_;
  websocket::close_reason close_reason_;
  bool joined_ = false;
  bool writing_ = false;
  bool close_requested_ = false;
  bool closing_ = false;
  bool disconnected_ = false;
};

// Primera petición HTTP: /healthz o el upgrade a /ws/voice.
class HttpSession : public std::enable_shared_from_this<HttpSession> {
 public:
  HttpSession(tcp::socket&& socket, std::shared_ptr<ServerShared> shared)
      : stream_(std::move(socket)), shared_(std::move(shared)) {}

  void run() {
    asio::dispatch(stream_.get_executor(), [self = shared_from_this()] { self->do_read(); });
  }

 private:
  void do_read() {
    parser_.emplace();
    parser_->body_limit(8 * 1024);
    stream_.expires_after(std::chrono::seconds(30));
    http::async_read(stream_, buffer_, *parser_,
                     [self = shared_from_this()](beast::error_code ec, std::size_t) {
                       if (ec) return;
                       self->on_request(self->parser_->release());
                     });
  }

  void on_request(http::request<http::string_body> req) {
    req_ = std::move(req);
    if (!websocket::is_upgrade(req_)) {
      if (req_.method() == http::verb::get && req_.target() == "/healthz")
        return respond(http::status::ok, R"({"status":"ok"})");
      if (parse_mute_path(req_.target())) return on_mute_request();
      return respond(http::status::not_found, R"({"error":"not found"})");
    }
    // decide_handshake consulta Redis (bloqueante): fuera del io_context.
    asio::post(shared_->blocking, [self = shared_from_this()] {
      std::optional<std::string_view> origin;
      if (auto it = self->req_.find(http::field::origin); it != self->req_.end()) origin = it->value();
      auto decision = decide_handshake({self->req_.target(), origin}, *self->shared_->verifier,
                                       *self->shared_->revocation, *self->shared_->mutes,
                                       self->shared_->options.allowed_origins, now_s());
      asio::post(self->stream_.get_executor(), [self, decision = std::move(decision)]() mutable {
        self->on_decision(std::move(decision));
      });
    });
  }

  // REST de silencios del host (HU-VOZ-04). CORS solo para los orígenes permitidos.
  void on_mute_request() {
    if (auto it = req_.find(http::field::origin); it != req_.end()) {
      if (!origin_allowed(it->value(), shared_->options.allowed_origins))
        return respond(http::status::forbidden, R"({"error":"origin not allowed"})");
      cors_origin_ = it->value();
    }
    if (req_.method() == http::verb::options) return respond_preflight();
    asio::post(shared_->blocking, [self = shared_from_this()] {
      std::optional<std::string_view> authorization;
      if (auto it = self->req_.find(http::field::authorization); it != self->req_.end())
        authorization = it->value();
      auto decision = decide_mute_request({self->req_.method_string(), self->req_.target(), authorization},
                                          *self->shared_->verifier, *self->shared_->revocation, now_s());
      if (auto* reject = std::get_if<Reject>(&decision)) {
        nlohmann::json body{{"error", reject->reason}};
        return self->respond_from_pool(static_cast<http::status>(reject->status), body.dump());
      }
      auto& command = std::get<MuteCommand>(decision);
      // Falla cerrado: solo se anuncia lo que quedó guardado.
      if (!self->shared_->mutes->set_muted(command.room_id, command.user_id, command.muted))
        return self->respond_from_pool(http::status::service_unavailable,
                                       R"({"error":"mute store unavailable"})");
      self->shared_->hub->apply_host_mute(command.room_id, command.user_id, command.muted);
      self->respond_from_pool(http::status::no_content, "");
    });
  }

  void respond_from_pool(http::status status, std::string body) {
    asio::post(stream_.get_executor(), [self = shared_from_this(), status, body = std::move(body)]() mutable {
      self->respond(status, std::move(body));
    });
  }

  void respond_preflight() {
    auto res = std::make_shared<http::response<http::string_body>>(http::status::no_content, req_.version());
    if (!cors_origin_.empty()) {
      res->set(http::field::access_control_allow_origin, cors_origin_);
      res->set(http::field::vary, "Origin");
    }
    res->set(http::field::access_control_allow_methods, "PUT, DELETE");
    res->set(http::field::access_control_allow_headers, "Authorization");
    res->set(http::field::access_control_max_age, "600");
    write(std::move(res));
  }

  void on_decision(HandshakeDecision decision) {
    stream_.expires_never();
    if (auto* reject = std::get_if<Reject>(&decision)) {
      nlohmann::json body{{"error", reject->reason}};
      return respond(static_cast<http::status>(reject->status), body.dump());
    }
    auto session = std::make_shared<VoiceSession>(std::move(stream_), shared_);
    if (auto* close = std::get_if<AcceptThenClose>(&decision))
      return session->accept_and_close(std::move(req_), close->code, close->reason);
    session->accept_and_join(std::move(req_), std::move(std::get<Accept>(decision)));
  }

  void respond(http::status status, std::string body) {
    auto res = std::make_shared<http::response<http::string_body>>(status, req_.version());
    if (!body.empty()) res->set(http::field::content_type, "application/json");
    if (!cors_origin_.empty()) {
      res->set(http::field::access_control_allow_origin, cors_origin_);
      res->set(http::field::vary, "Origin");
    }
    res->body() = std::move(body);
    write(std::move(res));
  }

  void write(std::shared_ptr<http::response<http::string_body>> res) {
    res->keep_alive(false);
    res->prepare_payload();
    http::async_write(stream_, *res, [self = shared_from_this(), res](beast::error_code, std::size_t) {
      beast::error_code ec;
      self->stream_.socket().shutdown(tcp::socket::shutdown_send, ec);
    });
  }

  beast::tcp_stream stream_;
  std::shared_ptr<ServerShared> shared_;
  beast::flat_buffer buffer_;
  std::optional<http::request_parser<http::string_body>> parser_;
  http::request<http::string_body> req_;
  std::string cors_origin_;
};

}  // namespace

Server::Server(asio::io_context& ioc, ServerOptions options, std::shared_ptr<auth::TokenVerifier> verifier,
               std::shared_ptr<RevocationChecker> revocation, std::shared_ptr<moderation::MuteStore> mutes,
               std::shared_ptr<hub::Hub> hub)
    : ioc_(ioc), acceptor_(asio::make_strand(ioc)) {
  shared_ = std::make_shared<ServerShared>(ServerShared{std::move(options), std::move(verifier),
                                                        std::move(revocation), std::move(mutes),
                                                        std::move(hub), blocking_pool_.get_executor()});
}

Server::~Server() {
  blocking_pool_.stop();
  blocking_pool_.join();
}

std::uint16_t Server::listen(const std::string& host, std::uint16_t port) {
  tcp::endpoint endpoint(asio::ip::make_address(host), port);
  acceptor_.open(endpoint.protocol());
  acceptor_.set_option(asio::socket_base::reuse_address(true));
  acceptor_.bind(endpoint);
  acceptor_.listen(asio::socket_base::max_listen_connections);
  const auto bound = acceptor_.local_endpoint().port();
  do_accept();
  return bound;
}

void Server::stop() {
  asio::post(acceptor_.get_executor(), [this] {
    beast::error_code ec;
    acceptor_.close(ec);
  });
}

void Server::do_accept() {
  acceptor_.async_accept(asio::make_strand(ioc_), [this](beast::error_code ec, tcp::socket socket) {
    if (ec == asio::error::operation_aborted || !acceptor_.is_open()) return;
    if (!ec) std::make_shared<HttpSession>(std::move(socket), shared_)->run();
    do_accept();
  });
}

}  // namespace voice::net
