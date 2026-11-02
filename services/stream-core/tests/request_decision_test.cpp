// Tabla de decisión de WHIP/WHEP (HU-LIVE-01, 03, 04, 05, 06).
#include "http/request_decision.hpp"

#include <gtest/gtest.h>

#include "support/fakes.hpp"
#include "support/jwt.hpp"
#include "support/sdp_fixtures.hpp"

using namespace stream;
using namespace stream::http;
using namespace stream::testing;

namespace {

class RequestDecision : public ::testing::Test {
 protected:
  RequestDecision() {
    rooms.set("room-1", {.stream_enabled = true, .closed = false});
    sessions.sessions["sess-host"] = {"room-1", "user-host", "abcd"};
    sessions.sessions["sess-ana"] = {"room-1", "guest:ana", "ijkl"};
  }

  Decision run(Request r) {
    DecisionContext ctx{verifier, revocation, rooms, sessions, origins, 50, kNow};
    return decide(r, ctx);
  }

  static Request whip(std::string token, std::string sdp = kChromeWhipVideoOffer,
                      std::string path = "/api/v1/stream/rooms/room-1/whip") {
    return {Method::Post, std::move(path), "", "Bearer " + token, "application/sdp", "", std::move(sdp)};
  }
  static Request whep(std::string token, std::string sdp = kChromeWhepOffer) {
    return {Method::Post,  "/api/v1/stream/rooms/room-1/whep", "", "Bearer " + token, "application/sdp", "",
            std::move(sdp)};
  }

  // Por valor: la Decision es un temporal.
  static Problem problem(const Decision& d) {
    if (!std::holds_alternative<Problem>(d)) {
      ADD_FAILURE() << "se esperaba un error HTTP";
      return {};
    }
    return std::get<Problem>(d);
  }
  template <class T>
  static T command(const Decision& d) {
    if (auto* p = std::get_if<Problem>(&d)) {
      ADD_FAILURE() << p->status << " " << p->code << ": " << p->message;
      return {};
    }
    return std::get<T>(std::get<Command>(d));
  }

  auth::TokenVerifier verifier{kSecret, kIssuer, kAudience};
  FakeRevocation revocation;
  FakeRoomStatus rooms;
  FakeSessions sessions;
  std::vector<std::string> origins{"localhost:5173"};
  std::string host_token = sign_jwt(host_claims());
  std::string guest_token = sign_jwt(guest_claims());
};

}  // namespace

// --- HU-LIVE-01 / 06: publicar ----------------------------------------------------------

TEST_F(RequestDecision, WhipHostAccepted201) {
  auto cmd = command<WhipCommand>(run(whip(host_token)));
  EXPECT_EQ(cmd.room_id, "room-1");
  EXPECT_EQ(cmd.claims.sub, "user-host");
  EXPECT_EQ(cmd.media, PublishMedia::Video);
  EXPECT_EQ(cmd.sdp, kChromeWhipVideoOffer);
}

TEST_F(RequestDecision, WhipAudioSessionSelectedByQuery) {
  auto r = whip(host_token, kChromeWhipAudioOffer);
  r.query = "kind=audio";
  EXPECT_EQ(command<WhipCommand>(run(r)).media, PublishMedia::Audio);
}

TEST_F(RequestDecision, WhipUnknownKind400) {
  auto r = whip(host_token);
  r.query = "kind=screen";
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 400);
  EXPECT_EQ(p.code, "INVALID_REQUEST");
}

TEST_F(RequestDecision, CohostCanPublish) {
  auto c = host_claims();
  c["role"] = "cohost";
  EXPECT_NO_FATAL_FAILURE(command<WhipCommand>(run(whip(sign_jwt(c)))));
}

TEST_F(RequestDecision, ParticipantWhip403) {
  auto p = problem(run(whip(guest_token)));
  EXPECT_EQ(p.status, 403);
  EXPECT_EQ(p.code, "FORBIDDEN_ROLE");
  EXPECT_FALSE(p.message.empty());
}

// --- HU-LIVE-06 AC2: autenticación ---------------------------------------------------------

TEST_F(RequestDecision, MissingAuthorization401) {
  auto r = whip(host_token);
  r.authorization.clear();
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 401);
  EXPECT_EQ(p.code, "UNAUTHORIZED");
}

TEST_F(RequestDecision, NonBearerAuthorization401) {
  auto r = whip(host_token);
  r.authorization = "Basic abc";
  EXPECT_EQ(problem(run(r)).status, 401);
}

TEST_F(RequestDecision, BadSignature401) {
  EXPECT_EQ(problem(run(whip(sign_jwt(host_claims(), "otro-secreto")))).status, 401);
}

TEST_F(RequestDecision, ExpiredToken401WithOwnCode) {
  auto c = host_claims();
  c["exp"] = kNow - 1;
  auto p = problem(run(whip(sign_jwt(c))));
  EXPECT_EQ(p.status, 401);
  EXPECT_EQ(p.code, "TOKEN_EXPIRED");
}

TEST_F(RequestDecision, RevokedToken401) {
  revocation.revoke("jti-host");
  auto p = problem(run(whip(host_token)));
  EXPECT_EQ(p.status, 401);
  EXPECT_EQ(p.code, "TOKEN_REVOKED");
}

TEST_F(RequestDecision, RevocationStoreDown503) {
  revocation.unavailable = true;
  auto p = problem(run(whip(host_token)));
  EXPECT_EQ(p.status, 503);
  EXPECT_EQ(p.code, "UNAVAILABLE");
}

TEST_F(RequestDecision, TokenForOtherRoom403) {
  auto p = problem(run(whip(sign_jwt(host_claims("room-2")))));
  EXPECT_EQ(p.status, 403);
  EXPECT_EQ(p.code, "FORBIDDEN");
}

// --- Origin y rutas ---------------------------------------------------------------------------

TEST_F(RequestDecision, ForeignOrigin403) {
  auto r = whip(host_token);
  r.origin = "https://evil.example";
  EXPECT_EQ(problem(run(r)).status, 403);
}

TEST_F(RequestDecision, AllowedOriginAccepted) {
  auto r = whip(host_token);
  r.origin = "http://localhost:5173";
  EXPECT_NO_FATAL_FAILURE(command<WhipCommand>(run(r)));
}

TEST_F(RequestDecision, UnknownPath404) {
  auto r = whip(host_token);
  r.path = "/api/v1/stream/otra";
  EXPECT_EQ(problem(run(r)).status, 404);
  r.path = "/api/v1/stream/rooms//whip";
  EXPECT_EQ(problem(run(r)).status, 404);
  r.path = "/api/v1/stream/rooms/room-1/whip/extra";
  EXPECT_EQ(problem(run(r)).status, 404);
}

TEST_F(RequestDecision, WrongMethod405) {
  auto r = whip(host_token);
  r.method = Method::Get;
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 405);
  EXPECT_EQ(p.code, "METHOD_NOT_ALLOWED");
}

TEST_F(RequestDecision, HealthNeedsNoToken) {
  Request r{Method::Get, "/healthz", "", "", "", "", ""};
  EXPECT_NO_FATAL_FAILURE(command<HealthCommand>(run(r)));
}

TEST_F(RequestDecision, PreflightFromAllowedOrigin) {
  Request r{Method::Options, "/api/v1/stream/rooms/room-1/whep", "", "", "", "http://localhost:5173", ""};
  EXPECT_EQ(command<PreflightCommand>(run(r)).origin, "http://localhost:5173");
  r.origin = "https://evil.example";
  EXPECT_EQ(problem(run(r)).status, 403);
}

// --- HU-LIVE-05 AC4 / estado de la sala --------------------------------------------------------

TEST_F(RequestDecision, RoomClosedMarker410RoomDisabled) {
  rooms.set("room-1", {.stream_enabled = true, .closed = true});
  auto p = problem(run(whip(host_token)));
  EXPECT_EQ(p.status, 410);
  EXPECT_EQ(p.code, "ROOM_DISABLED");
  EXPECT_EQ(problem(run(whep(guest_token))).status, 410);
}

TEST_F(RequestDecision, RoomClosedWinsOverInvalidSdp) {
  rooms.set("room-1", {.stream_enabled = true, .closed = true});
  EXPECT_EQ(problem(run(whep(guest_token, "basura"))).status, 410);
}

TEST_F(RequestDecision, ClosedMarkerUnreadable503) {
  rooms.unavailable = true;
  EXPECT_EQ(problem(run(whep(guest_token))).status, 503);
}

TEST_F(RequestDecision, RoomNotStreamEnabled404) {
  rooms.set("room-1", {.stream_enabled = false, .closed = false});
  auto p = problem(run(whip(host_token)));
  EXPECT_EQ(p.status, 404);
  EXPECT_EQ(p.code, "STREAM_NOT_FOUND");
}

// --- HU-LIVE-06 AC3: cuerpo inválido ------------------------------------------------------------

TEST_F(RequestDecision, WrongContentType415) {
  auto r = whip(host_token);
  r.content_type = "application/json";
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 415);
  EXPECT_EQ(p.code, "UNSUPPORTED_MEDIA_TYPE");
}

TEST_F(RequestDecision, ContentTypeWithParametersAccepted) {
  auto r = whip(host_token);
  r.content_type = "Application/SDP; charset=utf-8";
  EXPECT_NO_FATAL_FAILURE(command<WhipCommand>(run(r)));
}

TEST_F(RequestDecision, EmptyOrOversizedBody400WithMessage) {
  auto empty = problem(run(whip(host_token, "")));
  EXPECT_EQ(empty.status, 400);
  EXPECT_EQ(empty.code, "INVALID_SDP");
  EXPECT_FALSE(empty.message.empty());
  auto big = problem(run(whip(host_token, std::string(kMaxSdpBytes + 1, 'a'))));
  EXPECT_EQ(big.status, 400);
}

TEST_F(RequestDecision, GarbageSdp400) {
  EXPECT_EQ(problem(run(whip(host_token, "esto no es sdp"))).code, "INVALID_SDP");
}

TEST_F(RequestDecision, OfferWithoutVp8_400) {
  std::string sdp = kChromeWhipVideoOffer;
  sdp.replace(sdp.find("VP8/90000"), 9, "AV1/90000");
  auto p = problem(run(whip(host_token, sdp)));
  EXPECT_EQ(p.code, "INVALID_SDP");
  EXPECT_NE(p.message.find("VP8"), std::string::npos);
}

TEST_F(RequestDecision, WhipOfferWithoutRidSimulcast400) {
  std::string sdp = kChromeWhipVideoOffer;
  for (auto rid : {"a=rid:h send\r\n", "a=rid:m send\r\n", "a=rid:l send\r\n"})
    sdp.erase(sdp.find(rid), std::string(rid).size());
  auto p = problem(run(whip(host_token, sdp)));
  EXPECT_EQ(p.code, "INVALID_SDP");
  EXPECT_NE(p.message.find("simulcast"), std::string::npos);
}

TEST_F(RequestDecision, WhipOfferWithExtraTrack400) {
  // libdatachannel solo enruta simulcast sin a=ssrc si la PeerConnection tiene una pista (ADR 0017).
  std::string sdp =
      kChromeWhipVideoOffer + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
  EXPECT_EQ(problem(run(whip(host_token, sdp))).code, "INVALID_SDP");
}

TEST_F(RequestDecision, WhipOfferWithoutDataChannel400) {
  std::string sdp = kChromeWhipVideoOffer.substr(0, kChromeWhipVideoOffer.find("m=application"));
  auto p = problem(run(whip(host_token, sdp)));
  EXPECT_EQ(p.code, "DATACHANNEL_REQUIRED");
}

TEST_F(RequestDecision, AudioWhipAcceptsOnlyOpus) {
  auto r = whip(host_token, kChromeWhipVideoOffer);
  r.query = "kind=audio";
  EXPECT_EQ(problem(run(r)).code, "INVALID_SDP");
}

TEST_F(RequestDecision, WhipNotSendingIsInvalid) {
  std::string sdp = kChromeWhipVideoOffer;
  sdp.replace(sdp.find("a=sendonly"), 10, "a=recvonly");
  EXPECT_EQ(problem(run(whip(host_token, sdp))).code, "INVALID_SDP");
}

// --- Ver (WHEP) y cupo (HU-LIVE-04 AC3) ---------------------------------------------------------

TEST_F(RequestDecision, GuestWhep201) {
  auto cmd = command<WhepCommand>(run(whep(guest_token)));
  EXPECT_EQ(cmd.claims.sub, "guest:ana");
}

TEST_F(RequestDecision, WhepOfferNotRecvonly400) {
  std::string sdp = kChromeWhepOffer;
  sdp.replace(sdp.find("a=recvonly"), 10, "a=sendrecv");
  EXPECT_EQ(problem(run(whep(guest_token, sdp))).code, "INVALID_SDP");
}

TEST_F(RequestDecision, WhepWithoutDataChannel400) {
  std::string sdp = kChromeWhepOffer.substr(0, kChromeWhepOffer.find("m=application"));
  EXPECT_EQ(problem(run(whep(guest_token, sdp))).code, "DATACHANNEL_REQUIRED");
}

TEST_F(RequestDecision, ViewerCapacityReached409RoomFull) {
  sessions.viewers["room-1"] = 49;
  EXPECT_NO_FATAL_FAILURE(command<WhepCommand>(run(whep(guest_token))));
  sessions.viewers["room-1"] = 50;
  auto p = problem(run(whep(guest_token)));
  EXPECT_EQ(p.status, 409);
  EXPECT_EQ(p.code, "ROOM_FULL");
}

TEST_F(RequestDecision, CapacityDoesNotApplyToPublisher) {
  sessions.viewers["room-1"] = 50;
  EXPECT_NO_FATAL_FAILURE(command<WhipCommand>(run(whip(host_token))));
}

// --- HU-LIVE-03 AC3: credenciales ICE antes de la oferta ------------------------------------

TEST_F(RequestDecision, IceServersForAnyMember) {
  Request r{Method::Get, "/api/v1/stream/rooms/room-1/ice-servers", "", "Bearer " + guest_token, "", "", ""};
  EXPECT_EQ(command<IceServersCommand>(run(r)).claims.sub, "guest:ana");
}

// --- PATCH / DELETE de una sesión ----------------------------------------------------------------

TEST_F(RequestDecision, PatchTrickleAccepted) {
  Request r{Method::Patch,
            "/api/v1/stream/sessions/sess-ana",
            "",
            "Bearer " + guest_token,
            "application/trickle-ice-sdpfrag",
            "",
            "a=ice-ufrag:ijkl\r\na=ice-pwd:x\r\nm=video 9 UDP/TLS/RTP/SAVPF 0\r\na=mid:0\r\n"
            "a=candidate:1 1 udp 2113937151 192.168.1.2 50000 typ host\r\n"};
  EXPECT_EQ(command<PatchCommand>(run(r)).session_id, "sess-ana");
}

TEST_F(RequestDecision, PatchIceRestartNotSupported405) {
  Request r{Method::Patch,
            "/api/v1/stream/sessions/sess-ana",
            "",
            "Bearer " + guest_token,
            "application/trickle-ice-sdpfrag",
            "",
            "a=ice-ufrag:NUEVO\r\na=ice-pwd:y\r\n"};
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 405);
  EXPECT_EQ(p.code, "ICE_RESTART_UNSUPPORTED");
}

TEST_F(RequestDecision, PatchWrongContentType415) {
  Request r{Method::Patch,
            "/api/v1/stream/sessions/sess-ana",
            "",
            "Bearer " + guest_token,
            "application/sdp",
            "",
            "a=ice-ufrag:ijkl\r\n"};
  EXPECT_EQ(problem(run(r)).status, 415);
}

TEST_F(RequestDecision, PatchUnknownSession404) {
  Request r{Method::Patch,
            "/api/v1/stream/sessions/nope",
            "",
            "Bearer " + guest_token,
            "application/trickle-ice-sdpfrag",
            "",
            ""};
  auto p = problem(run(r));
  EXPECT_EQ(p.status, 404);
  EXPECT_EQ(p.code, "SESSION_NOT_FOUND");
}

TEST_F(RequestDecision, DeleteBySessionOwner) {
  Request r{Method::Delete, "/api/v1/stream/sessions/sess-ana", "", "Bearer " + guest_token, "", "", ""};
  EXPECT_EQ(command<DeleteCommand>(run(r)).session_id, "sess-ana");
}

TEST_F(RequestDecision, DeleteByOtherToken403) {
  Request r{Method::Delete, "/api/v1/stream/sessions/sess-host", "", "Bearer " + guest_token, "", "", ""};
  EXPECT_EQ(problem(run(r)).status, 403);
}

TEST_F(RequestDecision, DeleteOfClosedRoomStillAllowed) {
  // Liberar recursos (HU-LIVE-04 AC2) no depende del estado de la sala.
  rooms.set("room-1", {.stream_enabled = true, .closed = true});
  Request r{Method::Delete, "/api/v1/stream/sessions/sess-ana", "", "Bearer " + guest_token, "", "", ""};
  EXPECT_NO_FATAL_FAILURE(command<DeleteCommand>(run(r)));
}

TEST(OriginAllowed, MatchesHostAndPortOnly) {
  std::vector<std::string> allowed{"localhost:5173", "tint.example"};
  EXPECT_TRUE(origin_allowed("", allowed));  // sin Origin: no es un navegador
  EXPECT_TRUE(origin_allowed("http://localhost:5173", allowed));
  EXPECT_TRUE(origin_allowed("https://tint.example", allowed));
  EXPECT_FALSE(origin_allowed("http://localhost:5174", allowed));
  EXPECT_FALSE(origin_allowed("https://tint.example.evil.com", allowed));
  EXPECT_FALSE(origin_allowed("null", allowed));
}
