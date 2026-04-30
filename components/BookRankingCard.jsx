import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Svg, { Path } from "react-native-svg";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/utils/format-number";
import BookTag from "./BookTag";

const BookmarkIcon = memo(({ color = "#B19CD9", size = 28 }) => {
  const width = size;
  const height = size * 1.1;
  const tipHeight = size * 0.3;

  return (
    <Svg width={width} height={height + tipHeight} viewBox={`0 0 ${width} ${height + tipHeight}`}>
      <Path
        d={`
          M0 0
          H${width}
          V${height}
          L${width / 2} ${height + tipHeight}
          L0 ${height}
          Z
        `}
        fill={color}
      />
    </Svg>
  );
});

const BookRankingCard = ({ item, rank }) => {
  const { theme } = useAppTheme();
  if (!item?.book) return null;
  const book = item.book;

  const handlePress = () => router.push({ pathname: "book-info", params: { bookId: book.$id } });
  const TAGS = [book?.status, book?.contentRating || "Rated PG"];

  return (
    <View style={{ overflow: "visible" }}>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.9}
        className="flex-row items-center rounded-2xl px-5 py-2.5 shadow-md"
        style={{
          overflow: "hidden",
          backgroundColor: theme.card,
          borderWidth: 1,
          borderColor: theme.border,
        }}
      >
        {/* Thumbnail + Bookmark container */}
        <View className="relative" style={{ overflow: "visible" }}>
          <FastImage
            source={{
              uri: book.thumbnail,
              priority: FastImage.priority.normal,
            }}
            style={{
              height: 120,
              width: 90,
              borderRadius: 12,
              backgroundColor: theme.surfaceMuted,
            }}
            resizeMode={FastImage.resizeMode.cover}
          />

          <View className="absolute -left-4 -top-0 items-center">
            <BookmarkIcon color={rank === 1 ? "#FACC15" : rank === 2 ? "#D1D5DB" : rank === 3 ? "#B45309" : "#B19CD9"} size={30} />
            <Text className="absolute text-[13px] font-bold" style={{ top: 10, color: theme.textInverse }}>
              {rank}
            </Text>
          </View>
        </View>

        {/* 📘 Book details */}
        <View className="ml-4 flex-1 justify-between">
          <Text className="text-base font-semibold" style={{ color: theme.text }} numberOfLines={1}>
            {book.title}
          </Text>

          <Text className="my-1 text-xs" style={{ color: theme.textMuted }} numberOfLines={2}>
            {book.synopsis || "No synopsis available."}
          </Text>

          <View className="flex-row flex-wrap gap-1 py-1">
            {TAGS.map((tag, index) => (
              <BookTag tagName={tag} key={index} />
            ))}
          </View>

          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center space-x-1">
              <Ionicons name="star" size={14} color="#FFD54A" />
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {item?.averageRating || 0}
              </Text>
            </View>
            <View className="flex-row items-center space-x-1">
              <Ionicons name="eye-outline" size={14} color="#818cf8" />
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {FormatNumber(item?.totalReads)}
              </Text>
            </View>
            <View className="flex-row items-center space-x-1">
              <Ionicons name="heart-outline" size={14} color="#f87171" />
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {item?.totalLikes ?? "..."}
              </Text>
            </View>

            <View className="flex-row items-center space-x-1">
              <Ionicons name="list-outline" size={20} color="gray" />
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {item?.chaptersTotal ?? "..."}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

export default memo(BookRankingCard);
