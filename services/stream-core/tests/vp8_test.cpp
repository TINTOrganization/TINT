#include "rtp/vp8.hpp"

#include <gtest/gtest.h>

#include "support/rtp_builder.hpp"

using namespace stream::rtp;
using namespace stream::testing;

TEST(Vp8, DetectsKeyframeWhenStartOfPartitionAndPBitClear) {
  auto p = build_vp8_payload({.keyframe = true});
  auto d = parse_vp8(p);
  ASSERT_TRUE(d);
  EXPECT_TRUE(d->keyframe);
  EXPECT_TRUE(d->start_of_partition);
  EXPECT_EQ(d->partition_index, 0);
}

TEST(Vp8, InterframeWithPBitSetIsNotKeyframe) {
  auto d = parse_vp8(build_vp8_payload({.keyframe = false}));
  ASSERT_TRUE(d);
  EXPECT_FALSE(d->keyframe);
}

TEST(Vp8, NonStartPacketIsNeverKeyframe) {
  auto d = parse_vp8(build_vp8_payload({.start = false, .keyframe = true}));
  ASSERT_TRUE(d);
  EXPECT_FALSE(d->keyframe);
  auto d2 = parse_vp8(build_vp8_payload({.start = true, .partition = 1, .keyframe = true}));
  ASSERT_TRUE(d2);
  EXPECT_FALSE(d2->keyframe) << "solo la partición 0 lleva la cabecera del frame";
}

TEST(Vp8, ParsesExtendedDescriptorWith15BitPictureId) {
  auto p = build_vp8_payload({.picture_id_bits = 15, .picture_id = 0x1234, .tl0picidx = 42});
  auto d = parse_vp8(p);
  ASSERT_TRUE(d);
  EXPECT_EQ(d->picture_id, 0x1234);
  EXPECT_TRUE(d->picture_id_15bit);
  EXPECT_EQ(d->tl0picidx, 42);
  EXPECT_EQ(d->size, 5u);
}

TEST(Vp8, Parses7BitPictureId) {
  auto d = parse_vp8(build_vp8_payload({.picture_id_bits = 7, .picture_id = 100, .with_tl0 = false}));
  ASSERT_TRUE(d);
  EXPECT_EQ(d->picture_id, 100);
  EXPECT_FALSE(d->picture_id_15bit);
  EXPECT_FALSE(d->tl0picidx);
  EXPECT_EQ(d->size, 3u);
}

TEST(Vp8, MinimalDescriptorWithoutExtensions) {
  auto d = parse_vp8(build_vp8_payload({.keyframe = true, .picture_id_bits = 0, .with_tl0 = false}));
  ASSERT_TRUE(d);
  EXPECT_EQ(d->size, 1u);
  EXPECT_FALSE(d->picture_id);
  EXPECT_TRUE(d->keyframe);
}

TEST(Vp8, HandlesTidKeyIdxByte) {
  std::vector<std::uint8_t> p{0x90, 0x20 /*T*/, 0x40 /*TID=1*/, 0x10, 0x02, 0x00};
  auto d = parse_vp8(p);
  ASSERT_TRUE(d);
  EXPECT_EQ(d->size, 3u);
  EXPECT_TRUE(d->keyframe);
}

TEST(Vp8, RejectsTruncatedDescriptor) {
  EXPECT_FALSE(parse_vp8(std::vector<std::uint8_t>{}));
  EXPECT_FALSE(parse_vp8(std::vector<std::uint8_t>{0x90}));              // X sin byte de extensión
  EXPECT_FALSE(parse_vp8(std::vector<std::uint8_t>{0x90, 0x80, 0x81}));  // M=1 sin segundo byte
  auto full = build_vp8_payload({});
  full.resize(5);  // descriptor completo pero sin cabecera de frame
  auto d = parse_vp8(full);
  ASSERT_TRUE(d) << "un descriptor sin payload sigue siendo válido";
  EXPECT_FALSE(d->keyframe);
}

TEST(Vp8, RewritesPictureIdPreservingWidth) {
  auto p15 = build_vp8_payload({.picture_id_bits = 15, .picture_id = 1});
  auto d15 = *parse_vp8(p15);
  write_picture_id(p15, d15, 0x7ABC);
  EXPECT_EQ(parse_vp8(p15)->picture_id, 0x7ABC);

  auto p7 = build_vp8_payload({.picture_id_bits = 7, .picture_id = 1});
  auto d7 = *parse_vp8(p7);
  write_picture_id(p7, d7, 130);
  EXPECT_EQ(parse_vp8(p7)->picture_id, 2) << "130 mod 128";
}

TEST(Vp8, PictureIdWrapsAt15Bits) {
  auto p = build_vp8_payload({.picture_id_bits = 15});
  auto d = *parse_vp8(p);
  write_picture_id(p, d, 0x8005);
  EXPECT_EQ(parse_vp8(p)->picture_id, 5);
}

TEST(Vp8, RewritesTl0PicIdxAndIgnoresMissingFields) {
  auto p = build_vp8_payload({.tl0picidx = 1});
  auto d = *parse_vp8(p);
  write_tl0picidx(p, d, 99);
  EXPECT_EQ(parse_vp8(p)->tl0picidx, 99);

  auto bare = build_vp8_payload({.picture_id_bits = 0, .with_tl0 = false});
  auto before = bare;
  auto db = *parse_vp8(bare);
  write_picture_id(bare, db, 7);
  write_tl0picidx(bare, db, 7);
  EXPECT_EQ(bare, before);
}
