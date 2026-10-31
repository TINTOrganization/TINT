#include "net/server.hpp"

#include "protocol/messages.hpp"

#include <chrono>
#include <thread>

#include <gtest/gtest.h>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include "support/fake_mute_store.hpp"
#include "support/fake_revocation.hpp"
#include "support/jwt.hpp"

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
using asio::ip::tcp;
using nlohmann::json;
using namespace voice;
using namespace voice::testing;
using namespace std::chrono_literals;

namespace {

std::int64_t real_now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

json token_claims(json c) {
  c["iat"] = real_now_s() - 10;
  c["exp"] = real_now_s() + 3600;
  return c;
}

// Cliente WebSocket síncrono con tiempo límite de lectura.
class Client {
 public:
  explicit Client(std::uint16_t port) : ws_(ioc_) { port_ = port; }

  // Devuelve el error del handshake (vacío si hizo upgrade).
  beast::error_code connect(const std::string& target, const std::string& origin = "http://localhost:5173") {
    beast::get_lowest_layer(ws_).connect(tcp::endpoint(asio::ip::make_address("127.0.0.1"), port_));
    ws_.set_option(websocket::stream_base::decorator([origin](websocket::request_type& req) {
      if (!origin.empty()) req.set(http::field::origin, origin);
    }));
    beast::error_code ec;
    ws_.handshake(response_, "127.0.0.1", target, ec);
    return ec;
  }

  void send(const json& j) { ws_.write(asio::buffer(j.dump())); }

  // Lee un mensaje; nullopt si el servidor cerró (close_code() lo dice).
  // Asíncrona a propósito: los tiempos límite de tcp_stream no aplican a las operaciones
  // síncronas, y una prueba en rojo debe fallar, no quedarse colgada.
  std::optional<json> read() {
    beast::flat_buffer buffer;
    beast::error_code ec;
    beast::get_lowest_layer(ws_).expires_after(3s);
    ws_.async_read(buffer, [&ec](beast::error_code e, std::size_t) { ec = e; });
    ioc_.restart();
    ioc_.run();
    if (ec) return std::nullopt;
    return json::parse(beast::buffers_to_string(buffer.data()));
  }

  // Lee hasta encontrar un mensaje del tipo pedido.
  std::optional<json> read_type(const std::string& type) {
    for (int i = 0; i < 20; ++i) {
      auto m = read();
      if (!m) return std::nullopt;
      if ((*m)["type"] == type) return m;
    }
    return std::nullopt;
  }

  std::uint16_t close_code() const { return ws_.reason().code; }
  const websocket::response_type& response() const { return response_; }

  void close() {
    beast::error_code ec;
    ws_.close(websocket::close_code::normal, ec);
  }

  // Corta el TCP sin cierre WebSocket (pestaña cerrada, red caída).
  void drop() {
    beast::error_code ec;
    beast::get_lowest_layer(ws_).socket().shutdown(tcp::socket::shutdown_both, ec);
    beast::get_lowest_layer(ws_).close();
  }

 private:
  asio::io_context ioc_;
  websocket::stream<beast::tcp_stream> ws_;
  websocket::response_type response_;
  std::uint16_t port_;
};

class ServerTest : public ::testing::Test {
 protected:
  void SetUp() override {
    hub::HubOptions options;
    options.max_members = 3;
    options.now_ms = [] { return 1; };
    int counter = 0;
    options.new_event_id = [counter]() mutable { return "evt-" + std::to_string(++counter); };
    revocation = std::make_shared<FakeRevocation>();
    mutes = std::make_shared<FakeMuteStore>();
    options.mutes = mutes;
    hub = std::make_shared<hub::Hub>(options);
    server = std::make_unique<net::Server>(ioc, net::ServerOptions{{"localhost:5173"}},
                                           std::make_shared<auth::TokenVerifier>(kSecret, kIssuer, kAudience),
                                           revocation, mutes, hub);
    port = server->listen("127.0.0.1", 0);
    thread = std::thread([this] { ioc.run(); });
  }

  void TearDown() override {
    server->stop();
    ioc.stop();
    thread.join();
  }

  std::string target(const json& claims, const std::string& room = "room-1") {
    return "/ws/voice?room_id=" + room + "&token=" + sign_jwt(token_claims(claims));
  }

  std::unique_ptr<Client> joined(const json& claims) {
    auto c = std::make_unique<Client>(port);
    EXPECT_FALSE(c->connect(target(claims)));
    auto state = c->read_type("voice_state");
    EXPECT_TRUE(state.has_value());
    if (state) self_ids[claims["sub"]] = (*state)["self"]["peer_id"];
    return c;
  }

  // Espera a que el hub refleje el número de miembros (las desconexiones son asíncronas).
  bool wait_members(std::size_t n) {
    for (int i = 0; i < 150; ++i) {
      if (hub->members("room-1").size() == n) return true;
      std::this_thread::sleep_for(20ms);
    }
    return false;
  }

  // Petición HTTP simple (REST de silencios).
  http::response<http::string_body> request(http::verb method, const std::string& target,
                                            const std::string& authorization = "",
                                            const std::string& origin = "http://localhost:5173",
                                            const std::string& preflight_method = "") {
    asio::io_context ioc_client;
    beast::tcp_stream stream(ioc_client);
    stream.connect(tcp::endpoint(asio::ip::make_address("127.0.0.1"), port));
    http::request<http::empty_body> req{method, target, 11};
    req.set(http::field::host, "127.0.0.1");
    if (!authorization.empty()) req.set(http::field::authorization, authorization);
    if (!origin.empty()) req.set(http::field::origin, origin);
    if (!preflight_method.empty()) req.set(http::field::access_control_request_method, preflight_method);
    http::write(stream, req);
    beast::flat_buffer buffer;
    http::response<http::string_body> res;
    stream.expires_after(3s);
    http::async_read(stream, buffer, res, [](beast::error_code, std::size_t) {});
    ioc_client.run();
    return res;
  }

  asio::io_context ioc;
  std::shared_ptr<hub::Hub> hub;
  std::shared_ptr<FakeRevocation> revocation;
  std::shared_ptr<FakeMuteStore> mutes;
  std::unique_ptr<net::Server> server;
  std::uint16_t port = 0;
  std::thread thread;
  std::map<std::string, std::string> self_ids;
};

}  // namespace

TEST_F(ServerTest, HealthzAnswersOk) {
  asio::io_context ioc_client;
  beast::tcp_stream stream(ioc_client);
  stream.connect(tcp::endpoint(asio::ip::make_address("127.0.0.1"), port));
  http::request<http::empty_body> req{http::verb::get, "/healthz", 11};
  req.set(http::field::host, "127.0.0.1");
  http::write(stream, req);
  beast::flat_buffer buffer;
  http::response<http::string_body> res;
  http::read(stream, buffer, res);
  EXPECT_EQ(res.result(), http::status::ok);
  EXPECT_EQ(json::parse(res.body())["status"], "ok");
}

TEST_F(ServerTest, UnknownHttpPathIs404) {
  asio::io_context ioc_client;
  beast::tcp_stream stream(ioc_client);
  stream.connect(tcp::endpoint(asio::ip::make_address("127.0.0.1"), port));
  http::request<http::empty_body> req{http::verb::get, "/nada", 11};
  req.set(http::field::host, "127.0.0.1");
  http::write(stream, req);
  beast::flat_buffer buffer;
  http::response<http::string_body> res;
  http::read(stream, buffer, res);
  EXPECT_EQ(res.result(), http::status::not_found);
}

// AC1: dos participantes se ven y se intercambian la señalización WebRTC.
TEST_F(ServerTest, ParticipantsJoinAndExchangeSignaling) {
  auto host = joined(host_claims());
  auto ana_client = std::make_unique<Client>(port);
  ASSERT_FALSE(ana_client->connect(target(guest_claims())));
  auto state = ana_client->read_type("voice_state");
  ASSERT_TRUE(state);
  ASSERT_EQ((*state)["peers"].size(), 1u);
  std::string host_peer = (*state)["peers"][0]["peer_id"];
  std::string ana_peer = (*state)["self"]["peer_id"];

  auto joined_msg = host->read_type("peer_joined");
  ASSERT_TRUE(joined_msg);
  EXPECT_EQ((*joined_msg)["peer"]["peer_id"], ana_peer);
  EXPECT_EQ((*joined_msg)["peer"]["nick"], "Ana");

  ana_client->send({{"type", "signal"},
                    {"event_id", "e1"},
                    {"occurred_at", 9},
                    {"to", host_peer},
                    {"data", {{"sdp", "offer"}}}});
  auto offer = host->read_type("signal");
  ASSERT_TRUE(offer);
  EXPECT_EQ((*offer)["from"], ana_peer);
  EXPECT_EQ((*offer)["data"]["sdp"], "offer");

  host->send({{"type", "signal"},
              {"event_id", "e2"},
              {"occurred_at", 9},
              {"to", ana_peer},
              {"data", {{"sdp", "answer"}}}});
  auto answer = ana_client->read_type("signal");
  ASSERT_TRUE(answer);
  EXPECT_EQ((*answer)["data"]["sdp"], "answer");
}

// AC3: al desconectarse (cierre limpio o caída de red) los demás reciben peer_left.
TEST_F(ServerTest, DisconnectAnnouncesPeerLeft) {
  auto host = joined(host_claims());
  auto ana = joined(guest_claims());
  ASSERT_TRUE(host->read_type("peer_joined"));
  ana->close();
  auto left = host->read_type("peer_left");
  ASSERT_TRUE(left);
  EXPECT_EQ((*left)["peer_id"], self_ids["guest:ana"]);

  auto luis = joined(guest_claims("room-1", "guest:luis", "jti-luis", "Luis"));
  ASSERT_TRUE(host->read_type("peer_joined"));
  luis->drop();
  auto dropped = host->read_type("peer_left");
  ASSERT_TRUE(dropped);
  EXPECT_EQ((*dropped)["peer_id"], self_ids["guest:luis"]);
  EXPECT_TRUE(wait_members(1));
}

TEST_F(ServerTest, LeaveMessageClosesNormally) {
  auto ana = joined(guest_claims());
  ana->send({{"type", "leave"}, {"event_id", "e"}, {"occurred_at", 1}});
  EXPECT_FALSE(ana->read().has_value());
  EXPECT_EQ(ana->close_code(), 1000);
  EXPECT_TRUE(wait_members(0));
}

// AC2: un invitado bloqueado (jti revocado) no entra: upgrade y cierre 4001.
TEST_F(ServerTest, RevokedTokenIsClosedWith4001) {
  revocation->revoke("jti-ana");
  Client c(port);
  ASSERT_FALSE(c.connect(target(guest_claims())));
  EXPECT_FALSE(c.read().has_value());
  EXPECT_EQ(c.close_code(), 4001);
  EXPECT_TRUE(hub->members("room-1").empty());
}

TEST_F(ServerTest, ExpiredTokenIsClosedWith4003) {
  auto claims = guest_claims();
  claims["iat"] = real_now_s() - 100;
  claims["exp"] = real_now_s() - 1;
  Client c(port);
  ASSERT_FALSE(c.connect("/ws/voice?room_id=room-1&token=" + sign_jwt(claims)));
  EXPECT_FALSE(c.read().has_value());
  EXPECT_EQ(c.close_code(), 4003);
}

TEST_F(ServerTest, BadTokenIsRejectedBeforeUpgrade) {
  Client c(port);
  auto ec = c.connect("/ws/voice?room_id=room-1&token=basura");
  EXPECT_TRUE(ec);
  EXPECT_EQ(c.response().result(), http::status::unauthorized);
}

TEST_F(ServerTest, ForeignOriginIsRejected) {
  Client c(port);
  EXPECT_TRUE(c.connect(target(guest_claims()), "https://evil.example"));
  EXPECT_EQ(c.response().result(), http::status::forbidden);
}

TEST_F(ServerTest, RedisDownFailsClosedWith503) {
  revocation->unavailable = true;
  Client c(port);
  EXPECT_TRUE(c.connect(target(guest_claims())));
  EXPECT_EQ(c.response().result(), http::status::service_unavailable);
}

// AC2 en vivo: el bloqueo llega por REVOKED y saca de la voz a quien ya estaba.
TEST_F(ServerTest, HubRevokeDisconnectsALiveParticipant) {
  auto host = joined(host_claims());
  auto ana = joined(guest_claims());
  ASSERT_TRUE(host->read_type("peer_joined"));
  hub->revoke("room-1", "jti-ana");
  EXPECT_FALSE(ana->read_type("never").has_value());
  EXPECT_EQ(ana->close_code(), 4001);
  EXPECT_TRUE(host->read_type("peer_left"));
}

TEST_F(ServerTest, FullRoomClosesWith4008) {
  auto a = joined(guest_claims("room-1", "guest:a", "jti-a", "A"));
  auto b = joined(guest_claims("room-1", "guest:b", "jti-b", "B"));
  auto c = joined(guest_claims("room-1", "guest:c", "jti-c", "C"));
  Client d(port);
  ASSERT_FALSE(d.connect(target(guest_claims("room-1", "guest:d", "jti-d", "D"))));
  auto err = d.read_type("error");
  ASSERT_TRUE(err);
  EXPECT_EQ((*err)["code"], "VOICE_FULL");
  EXPECT_FALSE(d.read().has_value());
  EXPECT_EQ(d.close_code(), 4008);
}

TEST_F(ServerTest, OversizedMessageClosesTheConnection) {
  auto ana = joined(guest_claims());
  ana->send({{"type", "signal"}, {"pad", std::string(protocol::kMaxMessageBytes + 10, 'x')}});
  EXPECT_FALSE(ana->read_type("never").has_value());
  EXPECT_TRUE(wait_members(0));
}

// --- Fase 2: silencios --------------------------------------------------------------------

namespace {
const std::string kAnaMutePath = "/api/v1/voice/rooms/room-1/mutes/guest%3Aana";
std::string bearer(const json& claims) { return "Bearer " + sign_jwt(token_claims(claims)); }
}  // namespace

// HU-VOZ-02: el silencio propio llega a los demás (icono).
TEST_F(ServerTest, SelfMuteReachesTheOthers) {
  auto host = joined(host_claims());
  auto ana = joined(guest_claims());
  ASSERT_TRUE(host->read_type("peer_joined"));
  ana->send({{"type", "self_mute"}, {"event_id", "e"}, {"occurred_at", 1}, {"muted", true}});
  auto muted = host->read_type("peer_muted");
  ASSERT_TRUE(muted);
  EXPECT_EQ((*muted)["peer_id"], self_ids["guest:ana"]);
  EXPECT_EQ((*muted)["muted"], true);
}

// HU-VOZ-04 AC1 por REST: 204 y todos reciben peer_muted.
TEST_F(ServerTest, RestHostMuteAnnouncesAndPersists) {
  auto host = joined(host_claims());
  auto ana = joined(guest_claims());
  ASSERT_TRUE(host->read_type("peer_joined"));

  auto res = request(http::verb::put, kAnaMutePath, bearer(host_claims()));
  EXPECT_EQ(res.result(), http::status::no_content);
  EXPECT_EQ(res[http::field::access_control_allow_origin], "http://localhost:5173");
  EXPECT_TRUE(mutes->contains("room-1", "guest:ana"));
  for (auto* c : {host.get(), ana.get()}) {
    auto muted = c->read_type("peer_muted");
    ASSERT_TRUE(muted);
    EXPECT_EQ((*muted)["host_muted"], true);
  }

  // AC2: no puede quitárselo.
  ana->send({{"type", "self_mute"}, {"event_id", "e-try"}, {"occurred_at", 1}, {"muted", false}});
  auto err = ana->read_type("error");
  ASSERT_TRUE(err);
  EXPECT_EQ((*err)["code"], "HOST_MUTED");

  res = request(http::verb::delete_, kAnaMutePath, bearer(host_claims()));
  EXPECT_EQ(res.result(), http::status::no_content);
  EXPECT_FALSE(mutes->contains("room-1", "guest:ana"));
  auto lifted = host->read_type("peer_muted");
  ASSERT_TRUE(lifted);
  EXPECT_EQ((*lifted)["host_muted"], false);
}

// HU-VOZ-04 AC3: un no-host recibe 403 de la API.
TEST_F(ServerTest, RestHostMuteByParticipantIs403) {
  auto res = request(http::verb::put, kAnaMutePath,
                     bearer(guest_claims("room-1", "guest:luis", "jti-luis", "Luis")));
  EXPECT_EQ(res.result(), http::status::forbidden);
  EXPECT_EQ(mutes->writes, 0);
}

TEST_F(ServerTest, RestErrors) {
  EXPECT_EQ(request(http::verb::put, kAnaMutePath).result(), http::status::unauthorized);
  EXPECT_EQ(request(http::verb::get, kAnaMutePath, bearer(host_claims())).result(),
            http::status::method_not_allowed);
  EXPECT_EQ(request(http::verb::put, kAnaMutePath, bearer(host_claims()), "https://evil.example").result(),
            http::status::forbidden);
  mutes->unavailable = true;
  EXPECT_EQ(request(http::verb::put, kAnaMutePath, bearer(host_claims())).result(),
            http::status::service_unavailable);
}

TEST_F(ServerTest, RestWorksWithoutOriginHeader) {
  auto res = request(http::verb::put, kAnaMutePath, bearer(host_claims()), "");
  EXPECT_EQ(res.result(), http::status::no_content);
  EXPECT_EQ(res.count(http::field::access_control_allow_origin), 0u);
}

// El navegador pregunta antes (CORS) porque el PUT lleva Authorization.
TEST_F(ServerTest, CorsPreflight) {
  auto res = request(http::verb::options, kAnaMutePath, "", "http://localhost:5173", "PUT");
  EXPECT_EQ(res.result(), http::status::no_content);
  EXPECT_EQ(res[http::field::access_control_allow_origin], "http://localhost:5173");
  EXPECT_NE(std::string(res[http::field::access_control_allow_methods]).find("DELETE"), std::string::npos);
  EXPECT_NE(std::string(res[http::field::access_control_allow_headers]).find("Authorization"),
            std::string::npos);
  EXPECT_EQ(request(http::verb::options, kAnaMutePath, "", "https://evil.example", "PUT").result(),
            http::status::forbidden);
}

// Persistencia: si vuelve a entrar sigue silenciada.
TEST_F(ServerTest, HostMuteSurvivesReconnect) {
  mutes->set_muted("room-1", "guest:ana", true);
  auto ana = std::make_unique<Client>(port);
  ASSERT_FALSE(ana->connect(target(guest_claims())));
  auto state = ana->read_type("voice_state");
  ASSERT_TRUE(state);
  EXPECT_EQ((*state)["self"]["host_muted"], true);
  EXPECT_EQ((*state)["self"]["muted"], true);
}

TEST_F(ServerTest, WebSocketHostMute) {
  auto host = joined(host_claims());
  auto ana = joined(guest_claims());
  ASSERT_TRUE(host->read_type("peer_joined"));
  host->send({{"type", "host_mute"},
              {"event_id", "e"},
              {"occurred_at", 1},
              {"user_id", "guest:ana"},
              {"muted", true}});
  auto muted = ana->read_type("peer_muted");
  ASSERT_TRUE(muted);
  EXPECT_EQ((*muted)["host_muted"], true);
}
