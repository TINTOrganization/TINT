// Cliente hacia identity-api (gracia vencida, ADR 0018) contra un servidor HTTP falso en proceso.
#include "identity/identity_client.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <deque>
#include <mutex>
#include <thread>

using namespace stream::identity;
namespace beast = boost::beast;
namespace bhttp = beast::http;
using tcp = boost::asio::ip::tcp;

namespace {

// Responde con los códigos de `statuses` en orden (el último se repite) y guarda las peticiones.
class StubServer {
 public:
  explicit StubServer(std::deque<int> statuses) : statuses_(std::move(statuses)) {
    acceptor_.bind({boost::asio::ip::make_address("127.0.0.1"), 0});
    acceptor_.listen();
    port = acceptor_.local_endpoint().port();
    thread_ = std::thread([this] { serve(); });
  }
  ~StubServer() {
    stop_ = true;
    boost::system::error_code ec;
    tcp::socket poke(io_);
    poke.connect({boost::asio::ip::make_address("127.0.0.1"), port}, ec);
    thread_.join();
  }
  struct Seen {
    std::string target, token, body;
  };
  std::vector<Seen> seen() {
    std::lock_guard l(mu_);
    return seen_;
  }
  unsigned short port = 0;

 private:
  void serve() {
    while (!stop_) {
      tcp::socket socket(io_);
      boost::system::error_code ec;
      acceptor_.accept(socket, ec);
      if (ec || stop_) break;
      beast::flat_buffer buffer;
      bhttp::request<bhttp::string_body> req;
      bhttp::read(socket, buffer, req, ec);
      if (ec) continue;
      int status;
      {
        std::lock_guard l(mu_);
        seen_.push_back({std::string(req.target()), std::string(req["X-Internal-Token"]), req.body()});
        status = statuses_.front();
        if (statuses_.size() > 1) statuses_.pop_front();
      }
      bhttp::response<bhttp::string_body> res{static_cast<bhttp::status>(status), 11};
      if (status != 204) res.body() = "{}";  // un 204 no lleva cuerpo
      res.prepare_payload();
      bhttp::write(socket, res, ec);
    }
  }
  boost::asio::io_context io_;
  tcp::acceptor acceptor_{io_, tcp::v4()};
  std::thread thread_;
  std::atomic<bool> stop_{false};
  std::mutex mu_;
  std::deque<int> statuses_;
  std::vector<Seen> seen_;
};

HttpIdentityClient client(unsigned short port) {
  return HttpIdentityClient({"127.0.0.1", std::to_string(port), ""}, "secreto-interno", 3,
                            std::chrono::milliseconds(500), [](std::chrono::milliseconds) {});
}

}  // namespace

TEST(ParseHttpUrl, HostPortAndPath) {
  auto t = parse_http_url("http://identity-api:8081");
  ASSERT_TRUE(t);
  EXPECT_EQ(t->host, "identity-api");
  EXPECT_EQ(t->port, "8081");
  EXPECT_EQ(t->base_path, "");
  auto p = parse_http_url("http://localhost/base/");
  EXPECT_EQ(p->port, "80");
  EXPECT_EQ(p->base_path, "/base");
  EXPECT_FALSE(parse_http_url("https://x"));
  EXPECT_FALSE(parse_http_url("identity-api:8081"));
}

TEST(IdentityClient, PostsDisableWithInternalToken) {
  StubServer server({200});
  EXPECT_TRUE(client(server.port).disable_room("room-1", "grace_expired"));
  auto seen = server.seen();
  ASSERT_EQ(seen.size(), 1u);
  EXPECT_EQ(seen[0].target, "/api/v1/internal/rooms/room-1/disable");
  EXPECT_EQ(seen[0].token, "secreto-interno");
  EXPECT_EQ(seen[0].body, R"({"reason":"grace_expired"})");
}

TEST(IdentityClient, RetriesThenSucceeds) {
  StubServer server({503, 503, 204});
  EXPECT_TRUE(client(server.port).disable_room("room-1", "grace_expired"));
  EXPECT_EQ(server.seen().size(), 3u);
}

TEST(IdentityClient, ConflictMeansAlreadyDisabled) {
  StubServer server({409});
  EXPECT_TRUE(client(server.port).disable_room("room-1", "grace_expired"));
}

TEST(IdentityClient, GivesUpAfter3) {
  StubServer server({500});
  EXPECT_FALSE(client(server.port).disable_room("room-1", "grace_expired"));
  EXPECT_EQ(server.seen().size(), 3u);
}

TEST(IdentityClient, ClientErrorsAreNotRetried) {
  StubServer server({401});
  EXPECT_FALSE(client(server.port).disable_room("room-1", "grace_expired"));
  EXPECT_EQ(server.seen().size(), 1u) << "un 401 no se arregla reintentando";
}

TEST(IdentityClient, UnreachableFailsAfterRetries) {
  int sleeps = 0;
  HttpIdentityClient c({"127.0.0.1", "1", ""}, "s", 3, std::chrono::milliseconds(200),
                       [&](std::chrono::milliseconds) { ++sleeps; });
  EXPECT_FALSE(c.disable_room("room-1", "grace_expired"));
  EXPECT_EQ(sleeps, 2);
}
