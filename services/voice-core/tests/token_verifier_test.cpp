#include "auth/token_verifier.hpp"

#include <gtest/gtest.h>

#include "support/jwt.hpp"

using namespace voice::testing;
using voice::auth::TokenError;
using voice::auth::TokenVerifier;

class TokenVerifierTest : public ::testing::Test {
 protected:
  TokenVerifier verifier{kSecret, kIssuer, kAudience};
};

TEST_F(TokenVerifierTest, AcceptsValidGuestToken) {
  auto result = verifier.verify(sign_jwt(guest_claims()), kNow);
  ASSERT_TRUE(result.has_value()) << voice::auth::to_string(result.error());
  EXPECT_EQ(result->sub, "guest:ana");
  EXPECT_EQ(result->room_id, "room-1");
  EXPECT_EQ(result->role, "participant");
  EXPECT_EQ(result->nick, "Ana");
  EXPECT_EQ(result->jti, "jti-ana");
  EXPECT_EQ(result->exp, kNow + 3600);
  EXPECT_FALSE(result->is_host());
}

TEST_F(TokenVerifierTest, AcceptsHostAndCohostTickets) {
  auto host = verifier.verify(sign_jwt(host_claims()), kNow);
  ASSERT_TRUE(host.has_value());
  EXPECT_TRUE(host->is_host());

  auto claims = host_claims();
  claims["role"] = "cohost";
  auto cohost = verifier.verify(sign_jwt(claims), kNow);
  ASSERT_TRUE(cohost.has_value());
  EXPECT_TRUE(cohost->is_host());
}

TEST_F(TokenVerifierTest, AcceptsAudienceAsArray) {
  auto claims = guest_claims();
  claims["aud"] = {"other", kAudience};
  EXPECT_TRUE(verifier.verify(sign_jwt(claims), kNow).has_value());
}

TEST_F(TokenVerifierTest, RejectsWrongSecret) {
  auto result = verifier.verify(sign_jwt(guest_claims(), "otro-secreto"), kNow);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), TokenError::BadSignature);
}

TEST_F(TokenVerifierTest, RejectsTamperedPayload) {
  std::string token = sign_jwt(guest_claims());
  auto parts_end = token.find('.');
  auto forged = guest_claims();
  forged["role"] = "host";
  std::string tampered = token.substr(0, parts_end) + "." + voice::auth::base64url_encode(forged.dump()) +
                         token.substr(token.rfind('.'));
  auto result = verifier.verify(tampered, kNow);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), TokenError::BadSignature);
}

TEST_F(TokenVerifierTest, RejectsAlgNoneAndOtherAlgorithms) {
  for (const char* alg : {"none", "RS256", "HS512"}) {
    auto result = verifier.verify(sign_jwt(guest_claims(), kSecret, {{"alg", alg}}), kNow);
    ASSERT_FALSE(result.has_value()) << alg;
    EXPECT_EQ(result.error(), TokenError::UnsupportedAlgorithm) << alg;
  }
}

TEST_F(TokenVerifierTest, RejectsMalformedTokens) {
  for (const char* token : {"", "abc", "a.b", "a.b.c.d", "!!.@@.##", "e30.e30."}) {
    auto result = verifier.verify(token, kNow);
    ASSERT_FALSE(result.has_value()) << token;
    EXPECT_EQ(result.error(), TokenError::Malformed) << token;
  }
}

TEST_F(TokenVerifierTest, RejectsNonObjectJsonSegments) {
  std::string header = voice::auth::base64url_encode("[1]");
  std::string payload = voice::auth::base64url_encode(guest_claims().dump());
  auto result = verifier.verify(header + "." + payload + ".sig", kNow);
  ASSERT_FALSE(result.has_value());
  EXPECT_EQ(result.error(), TokenError::Malformed);
}

TEST_F(TokenVerifierTest, ExpiredOnlyWhenSignatureIsValid) {
  auto claims = guest_claims();
  claims["exp"] = kNow;
  auto expired = verifier.verify(sign_jwt(claims), kNow);
  ASSERT_FALSE(expired.has_value());
  EXPECT_EQ(expired.error(), TokenError::Expired);

  auto forged = verifier.verify(sign_jwt(claims, "otro"), kNow);
  ASSERT_FALSE(forged.has_value());
  EXPECT_EQ(forged.error(), TokenError::BadSignature);
}

TEST_F(TokenVerifierTest, RejectsWrongIssuerAndAudience) {
  auto claims = guest_claims();
  claims["iss"] = "evil";
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::WrongIssuer);

  claims = guest_claims();
  claims["aud"] = "tint:other";
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::WrongAudience);

  claims["aud"] = {"a", "b"};
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::WrongAudience);
}

TEST_F(TokenVerifierTest, RequiresEveryClaim) {
  for (const char* field : {"sub", "room_id", "role", "jti", "iss", "aud", "exp"}) {
    auto claims = guest_claims();
    claims.erase(field);
    auto result = verifier.verify(sign_jwt(claims), kNow);
    ASSERT_FALSE(result.has_value()) << field;
    EXPECT_EQ(result.error(), TokenError::MissingClaim) << field;
  }
  auto claims = guest_claims();
  claims["sub"] = "";
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::MissingClaim);
  claims = guest_claims();
  claims["exp"] = "mañana";
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::MissingClaim);
}

TEST_F(TokenVerifierTest, NickIsOptional) {
  auto claims = guest_claims();
  claims.erase("nick");
  auto result = verifier.verify(sign_jwt(claims), kNow);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->nick, "");
}

TEST_F(TokenVerifierTest, RejectsUnknownRole) {
  auto claims = guest_claims();
  claims["role"] = "admin";
  EXPECT_EQ(verifier.verify(sign_jwt(claims), kNow).error(), TokenError::InvalidRole);
}

TEST(TokenErrorText, NamesEveryError) {
  for (auto e : {TokenError::Malformed, TokenError::UnsupportedAlgorithm, TokenError::BadSignature,
                 TokenError::Expired, TokenError::WrongIssuer, TokenError::WrongAudience,
                 TokenError::MissingClaim, TokenError::InvalidRole}) {
    EXPECT_FALSE(voice::auth::to_string(e).empty());
  }
}
