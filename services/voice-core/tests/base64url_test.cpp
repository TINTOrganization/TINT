#include "auth/base64url.hpp"

#include <gtest/gtest.h>

using voice::auth::base64url_decode;
using voice::auth::base64url_encode;

TEST(Base64Url, EncodesWithoutPaddingAndUrlAlphabet) {
  EXPECT_EQ(base64url_encode(""), "");
  EXPECT_EQ(base64url_encode("f"), "Zg");
  EXPECT_EQ(base64url_encode("fo"), "Zm8");
  EXPECT_EQ(base64url_encode("foo"), "Zm9v");
  EXPECT_EQ(base64url_encode("\xfb\xff\xbf"), "-_-_");
}

TEST(Base64Url, RoundTripsBinary) {
  std::string bytes;
  for (int i = 0; i < 256; ++i) bytes.push_back(static_cast<char>(i));
  EXPECT_EQ(base64url_decode(base64url_encode(bytes)), bytes);
}

TEST(Base64Url, DecodesKnownValues) {
  EXPECT_EQ(base64url_decode("Zm9v"), "foo");
  EXPECT_EQ(base64url_decode("Zm8"), "fo");
  EXPECT_EQ(base64url_decode("-_-_"), "\xfb\xff\xbf");
}

TEST(Base64Url, RejectsInvalidInput) {
  EXPECT_EQ(base64url_decode("Zm9v="), std::nullopt) << "el relleno no es parte de base64url";
  EXPECT_EQ(base64url_decode("Zm+v"), std::nullopt) << "'+' es del alfabeto estándar, no del url";
  EXPECT_EQ(base64url_decode("Z"), std::nullopt) << "una longitud % 4 == 1 es imposible";
  EXPECT_EQ(base64url_decode("Zm9v!"), std::nullopt);
}
