#include "protocol/messages.hpp"

#include <gtest/gtest.h>

using namespace voice::protocol;
using nlohmann::json;
using voice::domain::Member;

namespace {
const Envelope kEnv{"evt-1", 100, 105};
const Member kAna{"p-ana", "guest:ana", "Ana", "participant", "jti-ana"};
const Member kHost{"p-host", "user-host", "Host", "host", "jti-host"};

json parse(const std::string& s) { return json::parse(s); }

void expect_envelope(const json& j) {
  EXPECT_EQ(j["event_id"], "evt-1");
  EXPECT_EQ(j["occurred_at"], 100);
  EXPECT_EQ(j["received_at"], 105);
}
}  // namespace

TEST(ParseClientMessage, ParsesSignal) {
  auto msg = parse_client_message(
      R"({"type":"signal","event_id":"e1","occurred_at":42,"to":"p-host","data":{"sdp":"v=0"}})");
  ASSERT_TRUE(msg.has_value());
  auto* signal = std::get_if<SignalIn>(&*msg);
  ASSERT_NE(signal, nullptr);
  EXPECT_EQ(signal->event_id, "e1");
  EXPECT_EQ(signal->occurred_at, 42);
  EXPECT_EQ(signal->to, "p-host");
  EXPECT_EQ(signal->data["sdp"], "v=0");
}

TEST(ParseClientMessage, ParsesLeave) {
  auto msg = parse_client_message(R"({"type":"leave","event_id":"e2","occurred_at":7})");
  ASSERT_TRUE(msg.has_value());
  auto* leave = std::get_if<LeaveIn>(&*msg);
  ASSERT_NE(leave, nullptr);
  EXPECT_EQ(leave->event_id, "e2");
  EXPECT_EQ(leave->occurred_at, 7);
}

TEST(ParseClientMessage, RejectsInvalidInput) {
  EXPECT_EQ(parse_client_message("{nope").error(), ProtocolError::InvalidJson);
  EXPECT_EQ(parse_client_message("[1,2]").error(), ProtocolError::InvalidJson);
  EXPECT_EQ(parse_client_message(R"({"type":"dance","event_id":"e"})").error(), ProtocolError::UnknownType);
  EXPECT_EQ(parse_client_message(R"({"event_id":"e"})").error(), ProtocolError::UnknownType);
  EXPECT_EQ(parse_client_message(std::string(kMaxMessageBytes + 1, ' ')).error(), ProtocolError::TooLarge);
}

TEST(ParseClientMessage, ValidatesFields) {
  const char* bad[] = {
      R"({"type":"signal","occurred_at":1,"to":"p","data":{}})",                   // sin event_id
      R"({"type":"signal","event_id":"","occurred_at":1,"to":"p","data":{}})",     // event_id vacío
      R"({"type":"signal","event_id":1,"occurred_at":1,"to":"p","data":{}})",      // event_id no string
      R"({"type":"signal","event_id":"e","to":"p","data":{}})",                    // sin occurred_at
      R"({"type":"signal","event_id":"e","occurred_at":"1","to":"p","data":{}})",  // occurred_at no número
      R"({"type":"signal","event_id":"e","occurred_at":1,"data":{}})",             // sin to
      R"({"type":"signal","event_id":"e","occurred_at":1,"to":"","data":{}})",     // to vacío
      R"({"type":"signal","event_id":"e","occurred_at":1,"to":"p"})",              // sin data
      R"({"type":"signal","event_id":"e","occurred_at":1,"to":"p","data":"x"})",   // data no objeto
      R"({"type":"leave","event_id":"e"})",                                        // leave sin occurred_at
  };
  for (const char* text : bad) {
    auto msg = parse_client_message(text);
    ASSERT_FALSE(msg.has_value()) << text;
    EXPECT_EQ(msg.error(), ProtocolError::InvalidField) << text;
  }
  std::string long_id(65, 'x');
  EXPECT_EQ(parse_client_message(R"({"type":"leave","occurred_at":1,"event_id":")" + long_id + "\"}").error(),
            ProtocolError::InvalidField);
}

TEST(ErrorCode, NamesEveryProtocolError) {
  EXPECT_EQ(error_code(ProtocolError::TooLarge), "MESSAGE_TOO_LARGE");
  EXPECT_EQ(error_code(ProtocolError::InvalidJson), "INVALID_MESSAGE");
  EXPECT_EQ(error_code(ProtocolError::UnknownType), "UNKNOWN_TYPE");
  EXPECT_EQ(error_code(ProtocolError::InvalidField), "INVALID_MESSAGE");
}

TEST(PeerJson, NeverExposesTheJti) {
  json j = peer_json(kAna);
  EXPECT_EQ(j,
            (json{{"peer_id", "p-ana"}, {"user_id", "guest:ana"}, {"nick", "Ana"}, {"role", "participant"}}));
  EXPECT_FALSE(j.contains("jti"));
}

TEST(ServerMessages, VoiceState) {
  json ice = json::array({{{"urls", json::array({"stun:x:3478"})}}});
  json j = parse(make_voice_state(kEnv, "room-1", kAna, {kHost}, ice, 8));
  EXPECT_EQ(j["type"], "voice_state");
  expect_envelope(j);
  EXPECT_EQ(j["room_id"], "room-1");
  EXPECT_EQ(j["self"], peer_json(kAna));
  EXPECT_EQ(j["peers"], json::array({peer_json(kHost)}));
  EXPECT_EQ(j["ice_servers"], ice);
  EXPECT_EQ(j["max_members"], 8);
  EXPECT_EQ(j.dump().find("jti"), std::string::npos);
}

TEST(ServerMessages, PeerJoinedAndLeft) {
  json joined = parse(make_peer_joined(kEnv, "room-1", kHost));
  EXPECT_EQ(joined["type"], "peer_joined");
  expect_envelope(joined);
  EXPECT_EQ(joined["room_id"], "room-1");
  EXPECT_EQ(joined["peer"], peer_json(kHost));

  json left = parse(make_peer_left(kEnv, "room-1", "p-host"));
  EXPECT_EQ(left["type"], "peer_left");
  expect_envelope(left);
  EXPECT_EQ(left["peer_id"], "p-host");
}

TEST(ServerMessages, SignalCarriesSenderAndOpaqueData) {
  json j = parse(make_signal(kEnv, "room-1", "p-ana", json{{"candidate", "c"}}));
  EXPECT_EQ(j["type"], "signal");
  expect_envelope(j);
  EXPECT_EQ(j["from"], "p-ana");
  EXPECT_EQ(j["data"]["candidate"], "c");
}

TEST(ServerMessages, Error) {
  json j = parse(make_error(kEnv, "VOICE_FULL", "e9"));
  EXPECT_EQ(j["type"], "error");
  expect_envelope(j);
  EXPECT_EQ(j["code"], "VOICE_FULL");
  EXPECT_EQ(j["event_id_ref"], "e9");

  json without_ref = parse(make_error(kEnv, "VOICE_FULL", ""));
  EXPECT_FALSE(without_ref.contains("event_id_ref"));
}
