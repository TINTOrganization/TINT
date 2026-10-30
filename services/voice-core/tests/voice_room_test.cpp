#include "domain/voice_room.hpp"

#include <gtest/gtest.h>

using voice::domain::JoinResult;
using voice::domain::Member;
using voice::domain::VoiceRoom;

namespace {
Member member(std::string peer, std::string jti = "") {
  return {peer, "user-" + peer, "Nick " + peer, "participant", jti.empty() ? "jti-" + peer : jti};
}
}  // namespace

TEST(VoiceRoom, StartsEmpty) {
  VoiceRoom room(8);
  EXPECT_TRUE(room.empty());
  EXPECT_EQ(room.size(), 0u);
  EXPECT_EQ(room.max_members(), 8u);
}

TEST(VoiceRoom, JoinKeepsArrivalOrder) {
  VoiceRoom room(8);
  EXPECT_EQ(room.join(member("b")), JoinResult::Joined);
  EXPECT_EQ(room.join(member("a")), JoinResult::Joined);
  auto members = room.members();
  ASSERT_EQ(members.size(), 2u);
  EXPECT_EQ(members[0].peer_id, "b");
  EXPECT_EQ(members[1].peer_id, "a");
  EXPECT_FALSE(room.empty());
}

TEST(VoiceRoom, RefusesWhenFull) {
  VoiceRoom room(2);
  room.join(member("a"));
  room.join(member("b"));
  EXPECT_EQ(room.join(member("c")), JoinResult::Full);
  EXPECT_EQ(room.size(), 2u);
}

TEST(VoiceRoom, RefusesDuplicatePeerId) {
  VoiceRoom room(8);
  room.join(member("a"));
  EXPECT_EQ(room.join(member("a")), JoinResult::DuplicatePeer);
  EXPECT_EQ(room.size(), 1u);
}

TEST(VoiceRoom, LeaveRemovesAndReturnsTheMember) {
  VoiceRoom room(2);
  room.join(member("a"));
  room.join(member("b"));
  auto left = room.leave("a");
  ASSERT_TRUE(left.has_value());
  EXPECT_EQ(left->user_id, "user-a");
  EXPECT_EQ(room.find("a"), nullptr);
  EXPECT_EQ(room.leave("a"), std::nullopt) << "salir dos veces no hace nada";
  EXPECT_EQ(room.join(member("c")), JoinResult::Joined) << "libera el cupo";
}

TEST(VoiceRoom, FindsMembers) {
  VoiceRoom room(8);
  room.join(member("a"));
  ASSERT_NE(room.find("a"), nullptr);
  EXPECT_EQ(room.find("a")->nick, "Nick a");
  EXPECT_EQ(room.find("zzz"), nullptr);
}

TEST(VoiceRoom, ListsPeersOfAToken) {
  VoiceRoom room(8);
  room.join(member("tab1", "jti-x"));
  room.join(member("other"));
  room.join(member("tab2", "jti-x"));
  EXPECT_EQ(room.peers_with_jti("jti-x"), (std::vector<std::string>{"tab1", "tab2"}));
  EXPECT_TRUE(room.peers_with_jti("nadie").empty());
}
