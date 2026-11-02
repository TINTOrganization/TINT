#include "http/handler.hpp"

#include <algorithm>
#include <cctype>

namespace stream::http {
namespace {

using nlohmann::json;

std::string lower(std::string_view s) {
  std::string out(s);
  std::ranges::transform(out, out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

std::string quoted(const std::string& value) {
  std::string out = "\"";
  for (char c : value) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out + "\"";
}

Response json_response(int status, const json& body) {
  return {status, {{"Content-Type", "application/json"}}, body.dump()};
}

Response problem_response(const Problem& p) {
  return json_response(p.status, {{"error", p.code}, {"message", p.message}});
}

constexpr std::string_view kInternalPrefix = "/internal/events/start/";

}  // namespace

std::string Response::header(std::string_view name) const {
  const auto wanted = lower(name);
  for (const auto& [k, v] : headers)
    if (lower(k) == wanted) return v;
  return {};
}

std::vector<std::string> Response::all(std::string_view name) const {
  const auto wanted = lower(name);
  std::vector<std::string> out;
  for (const auto& [k, v] : headers)
    if (lower(k) == wanted) out.push_back(v);
  return out;
}

std::vector<std::string> ice_link_headers(const json& ice_servers) {
  std::vector<std::string> out;
  for (const auto& server : ice_servers) {
    auto urls = server.find("urls");
    if (urls == server.end()) continue;
    std::vector<std::string> list;
    if (urls->is_string())
      list.push_back(urls->get<std::string>());
    else
      for (const auto& u : *urls) list.push_back(u.get<std::string>());
    for (const auto& url : list) {
      std::string link = "<" + url + ">; rel=\"ice-server\"";
      if (server.contains("username") && server.contains("credential"))
        link += "; username=" + quoted(server["username"].get<std::string>()) +
                "; credential=" + quoted(server["credential"].get<std::string>()) +
                "; credential-type=\"password\"";
      out.push_back(std::move(link));
    }
  }
  return out;
}

void Handler::cors(const Request& request, Response& response) const {
  if (request.origin.empty() || !origin_allowed(request.origin, deps_.allowed_origins)) return;
  response.headers.emplace_back("Access-Control-Allow-Origin", request.origin);
  response.headers.emplace_back("Access-Control-Expose-Headers", "Location, Link");
  response.headers.emplace_back("Vary", "Origin");
}

Response Handler::internal(const Request& request) {
  const auto room_id = request.path.substr(kInternalPrefix.size());
  if (room_id.empty() || room_id.find('/') != std::string::npos)
    return problem_response({404, "NOT_FOUND", "Ruta desconocida."});
  if (request.method == Method::Post) {
    if (!deps_.service.events_start(room_id))
      return problem_response({503, "UNAVAILABLE", "No se pudo habilitar la transmisión; reintenta."});
    return json_response(200, {{"room_id", room_id}, {"service", "stream-core"}});
  }
  if (request.method == Method::Delete) {
    if (!deps_.service.events_stop(room_id))
      return problem_response({503, "UNAVAILABLE", "No se pudo deshabilitar la transmisión; reintenta."});
    return {204, {}, ""};
  }
  return problem_response({405, "METHOD_NOT_ALLOWED", "Método no permitido en esta ruta."});
}

Response Handler::handle(const Request& request) {
  if (request.path.starts_with(kInternalPrefix)) return internal(request);

  DecisionContext ctx{deps_.verifier,        deps_.revocation,  deps_.rooms,  deps_.service,
                      deps_.allowed_origins, deps_.max_viewers, deps_.now_s()};
  Decision decision = decide(request, ctx);
  Response response;

  if (auto* p = std::get_if<Problem>(&decision)) {
    response = problem_response(*p);
  } else {
    const Command& cmd = std::get<Command>(decision);
    auto session_created = [&](const std::expected<service::SessionAnswer, Problem>& answer,
                               const auth::Claims& claims) {
      if (!answer) return problem_response(answer.error());
      Response r{201,
                 {{"Content-Type", "application/sdp"},
                  {"Location", "/api/v1/stream/sessions/" + answer->session_id}},
                 answer->sdp};
      for (auto& link : ice_link_headers(ice::make_ice_servers(deps_.ice, claims.sub, deps_.now_s())))
        r.headers.emplace_back("Link", std::move(link));
      return r;
    };

    if (std::holds_alternative<HealthCommand>(cmd)) {
      response = json_response(200, {{"status", "ok"}, {"service", "stream-core"}});
    } else if (auto* pre = std::get_if<PreflightCommand>(&cmd)) {
      response = {204,
                  {{"Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS"},
                   {"Access-Control-Allow-Headers", "Authorization, Content-Type"},
                   {"Access-Control-Max-Age", "600"}},
                  ""};
      (void)pre;
    } else if (auto* whip = std::get_if<WhipCommand>(&cmd)) {
      response = session_created(deps_.service.publish(*whip), whip->claims);
    } else if (auto* whep = std::get_if<WhepCommand>(&cmd)) {
      response = session_created(deps_.service.watch(*whep), whep->claims);
    } else if (auto* ice_cmd = std::get_if<IceServersCommand>(&cmd)) {
      auto servers = ice::make_ice_servers(deps_.ice, ice_cmd->claims.sub, deps_.now_s());
      response = json_response(200, {{"ice_servers", servers}});
      for (auto& link : ice_link_headers(servers)) response.headers.emplace_back("Link", std::move(link));
    } else if (auto* patch = std::get_if<PatchCommand>(&cmd)) {
      if (auto problem = deps_.service.trickle(*patch))
        response = problem_response(*problem);
      else
        response = {204, {}, ""};
    } else if (auto* del = std::get_if<DeleteCommand>(&cmd)) {
      deps_.service.end_session(*del);
      response = {200, {}, ""};
    }
  }
  cors(request, response);
  return response;
}

}  // namespace stream::http
