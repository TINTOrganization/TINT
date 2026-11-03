#include "identity/identity_client.hpp"

#include <boost/asio/connect.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <nlohmann/json.hpp>
#include <thread>

namespace stream::identity {

namespace beast = boost::beast;
namespace bhttp = beast::http;
using tcp = boost::asio::ip::tcp;

std::optional<HttpTarget> parse_http_url(const std::string& url) {
  constexpr std::string_view kScheme = "http://";
  if (!url.starts_with(kScheme)) return std::nullopt;
  std::string rest = url.substr(kScheme.size());
  HttpTarget t;
  auto slash = rest.find('/');
  std::string authority = rest.substr(0, slash);
  if (slash != std::string::npos) {
    t.base_path = rest.substr(slash);
    while (!t.base_path.empty() && t.base_path.back() == '/') t.base_path.pop_back();
  }
  auto colon = authority.rfind(':');
  t.host = authority.substr(0, colon);
  if (colon != std::string::npos) t.port = authority.substr(colon + 1);
  if (t.host.empty() || t.port.empty()) return std::nullopt;
  return t;
}

HttpIdentityClient::HttpIdentityClient(HttpTarget target, std::string internal_secret, int attempts,
                                       std::chrono::milliseconds timeout, Sleep sleep)
    : target_(std::move(target)),
      secret_(std::move(internal_secret)),
      attempts_(attempts),
      timeout_(timeout),
      sleep_(sleep ? std::move(sleep)
                   : Sleep([](std::chrono::milliseconds d) { std::this_thread::sleep_for(d); })) {}

int HttpIdentityClient::post_once(const std::string& path, const std::string& body) {
  try {
    boost::asio::io_context io;
    tcp::resolver resolver(io);
    beast::tcp_stream stream(io);
    stream.expires_after(timeout_);
    stream.connect(resolver.resolve(target_.host, target_.port));
    bhttp::request<bhttp::string_body> req{bhttp::verb::post, path, 11};
    req.set(bhttp::field::host, target_.host);
    req.set(bhttp::field::content_type, "application/json");
    req.set("X-Internal-Token", secret_);
    req.body() = body;
    req.prepare_payload();
    bhttp::write(stream, req);
    beast::flat_buffer buffer;
    bhttp::response<bhttp::string_body> res;
    bhttp::read(stream, buffer, res);
    beast::error_code ec;
    stream.socket().shutdown(tcp::socket::shutdown_both, ec);
    return static_cast<int>(res.result_int());
  } catch (const std::exception&) {
    return 0;  // red caída o tiempo agotado: se reintenta
  }
}

bool HttpIdentityClient::disable_room(const std::string& room_id, const std::string& reason) {
  const std::string path = target_.base_path + "/api/v1/internal/rooms/" + room_id + "/disable";
  const std::string body = nlohmann::json{{"reason", reason}}.dump();
  auto backoff = std::chrono::milliseconds(200);
  for (int attempt = 0; attempt < attempts_; ++attempt) {
    if (attempt > 0) {
      sleep_(backoff);
      backoff *= 2;
    }
    const int status = post_once(path, body);
    if ((status >= 200 && status < 300) || status == 409) return true;  // 409: ya estaba deshabilitada
    if (status >= 400 && status < 500) return false;  // error del cliente: reintentar no lo arregla
  }
  return false;
}

}  // namespace stream::identity
