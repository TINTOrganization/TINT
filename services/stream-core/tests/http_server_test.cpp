// Servidor HTTP con sockets reales (HU-LIVE-07 AC2: /healthz responde OK).
#include "net/http_server.hpp"

#include <gtest/gtest.h>

#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <thread>

using namespace stream;
namespace beast = boost::beast;
namespace bhttp = beast::http;
using tcp = boost::asio::ip::tcp;

namespace {

class ServerTest : public ::testing::Test {
 protected:
  void SetUp() override {
    server = std::make_unique<net::HttpServer>(io, workers, [this](const http::Request& r) {
      last = r;
      if (r.path == "/healthz")
        return http::Response{200, {{"Content-Type", "application/json"}}, R"({"status":"ok"})"};
      return http::Response{201, {{"Location", "/x"}, {"Link", "<a>"}, {"Link", "<b>"}}, "answer"};
    });
    ASSERT_TRUE(server->listen("127.0.0.1", 0));
    thread = std::thread([this] { io.run(); });
  }
  void TearDown() override {
    server->stop();
    io.stop();
    thread.join();
    workers.join();
  }

  bhttp::response<bhttp::string_body> send(bhttp::request<bhttp::string_body> req) {
    boost::asio::io_context cio;
    beast::tcp_stream stream(cio);
    stream.connect(tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), server->port()));
    req.set(bhttp::field::host, "localhost");
    req.prepare_payload();
    bhttp::write(stream, req);
    beast::flat_buffer buffer;
    bhttp::response<bhttp::string_body> res;
    bhttp::read(stream, buffer, res);
    return res;
  }

  boost::asio::io_context io;
  boost::asio::thread_pool workers{2};
  std::unique_ptr<net::HttpServer> server;
  std::thread thread;
  http::Request last;
};

}  // namespace

TEST_F(ServerTest, HealthzReturnsOk) {
  auto res = send({bhttp::verb::get, "/healthz", 11});
  EXPECT_EQ(res.result_int(), 200u);
  EXPECT_EQ(res.body(), R"({"status":"ok"})");
}

TEST_F(ServerTest, ParsesMethodPathQueryAndHeaders) {
  bhttp::request<bhttp::string_body> req{bhttp::verb::post, "/api/v1/stream/rooms/r/whip?kind=audio", 11};
  req.set(bhttp::field::authorization, "Bearer t");
  req.set(bhttp::field::content_type, "application/sdp");
  req.set(bhttp::field::origin, "http://localhost:5173");
  req.body() = "v=0";
  auto res = send(req);
  EXPECT_EQ(res.result_int(), 201u);
  EXPECT_EQ(last.method, http::Method::Post);
  EXPECT_EQ(last.path, "/api/v1/stream/rooms/r/whip");
  EXPECT_EQ(last.query, "kind=audio");
  EXPECT_EQ(last.authorization, "Bearer t");
  EXPECT_EQ(last.content_type, "application/sdp");
  EXPECT_EQ(last.origin, "http://localhost:5173");
  EXPECT_EQ(last.body, "v=0");
}

TEST_F(ServerTest, RepeatedHeadersAreKept) {
  auto res = send({bhttp::verb::post, "/x", 11});
  int links = 0;
  for (const auto& f : res)
    if (f.name_string() == "Link") ++links;
  EXPECT_EQ(links, 2);
  EXPECT_EQ(res[bhttp::field::location], "/x");
}

TEST_F(ServerTest, OversizedBodyIs413) {
  bhttp::request<bhttp::string_body> req{bhttp::verb::post, "/api/v1/stream/rooms/r/whip", 11};
  req.body() = std::string(200 * 1024, 'a');
  auto res = send(req);
  EXPECT_EQ(res.result_int(), 413u);
}

TEST_F(ServerTest, OtherMethodsMapToOther) {
  send({bhttp::verb::put, "/x", 11});
  EXPECT_EQ(last.method, http::Method::Other);
  send({bhttp::verb::patch, "/x", 11});
  EXPECT_EQ(last.method, http::Method::Patch);
  send({bhttp::verb::options, "/x", 11});
  EXPECT_EQ(last.method, http::Method::Options);
}
