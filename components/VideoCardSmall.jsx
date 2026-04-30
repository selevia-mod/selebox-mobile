// Compact video row used by ProfileVideosTab and a few "horizontal carousel"
// surfaces (`isFlexColumn`).
//
// Row mode (default — Profile > Videos tab):
//   - Larger 150-wide thumbnail (1.5× the previous 100px) at 16:9.
//   - Right side stack: Title (2 lines, bold) / Categories (tag list) /
//     Likes · Views.
//
// Column mode (`isFlexColumn`): unchanged — this is used in the
// horizontal mini-carousel surfaces and shouldn't be reshaped.

import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/utils/format-number";
import { formatDurationCompact, getVideoDurationSeconds } from "../lib/utils/video-duration";

const ROW_THUMB_WIDTH = 150; // was 100 — 1.5× bump per design brief
const ROW_THUMB_HEIGHT = Math.round((ROW_THUMB_WIDTH * 9) / 16); // 84

const formatTagList = (tags = []) => {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  return tags.filter(Boolean).slice(0, 4).join(" • ");
};

const VideoCardSmall = ({ item, isFlexColumn, customHeight, customWidth, ...props }) => {
  const { theme } = useAppTheme();
  const { globalSettings } = useGlobalContext();

  // Lazy duration — hoisted above the row/column branch so hook order is stable
  // regardless of which mode this card is in. Only the row path actually
  // surfaces the duration pill; column callers ignore the resolved value.
  const [durationSeconds, setDurationSeconds] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!item) return undefined;
    getVideoDurationSeconds(item).then((seconds) => {
      if (!cancelled) setDurationSeconds(seconds);
    });
    return () => {
      cancelled = true;
    };
  }, [item?.$id, item?.uri, item?.videoUrl]);
  const durationLabel = formatDurationCompact(durationSeconds);

  const handlePress = useCallback(() => {
    try {
      router.push({
        pathname: "video-player",
        params: {
          id: item.uri,
          docId: item.$id,
          view: "RECOMMENDED",
        },
      });
    } catch (error) {}
  }, [item?.uri, item?.$id]);

  // Row mode (default) — used by Profile > Videos tab
  if (!isFlexColumn) {
    const viewsMultiplier = Number(globalSettings?.["VIEWS_MULTIPLIER"]) || 1;
    const viewsValue = (item?.videoStats?.totalViews ?? item?.totalViews ?? 0) * viewsMultiplier;
    const likesValue = item?.videoStats?.totalLikes ?? item?.totalLikes ?? 0;
    const tagText = formatTagList(item?.tags);

    return (
      <TouchableOpacity activeOpacity={0.7} className="m-2 flex-row" onPress={handlePress} {...props}>
        <View style={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT, borderRadius: 8, overflow: "hidden", backgroundColor: theme.surfaceMuted }}>
          <FastImage
            source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
            style={{ width: "100%", height: "100%" }}
            resizeMode={FastImage.resizeMode.cover}
          />
          {/* Duration pill bottom-right of the thumbnail — YouTube-style.
              Lazy-loaded via getVideoDurationSeconds (cached + dedupe'd in
              lib/utils/video-duration). Hidden when no duration is resolvable. */}
          {durationLabel ? (
            <View
              style={{
                position: "absolute",
                bottom: 4,
                right: 4,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 4,
                backgroundColor: "rgba(0,0,0,0.78)",
              }}
            >
              <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 }}>{durationLabel}</Text>
            </View>
          ) : null}
        </View>
        <View className="ml-3 flex-1 justify-between">
          {/* Title — 2 lines so longer titles read fully against the bigger thumb */}
          <Text className="font-sans text-[13px] font-bold" style={{ color: theme.text, lineHeight: 18 }} numberOfLines={2}>
            {item?.title || "Untitled"}
          </Text>

          {/* Categories — joined with • */}
          {tagText ? (
            <Text className="mt-1 font-sans text-[11px]" style={{ color: theme.textSoft }} numberOfLines={1}>
              {tagText}
            </Text>
          ) : null}

          {/* Likes · Views — small inline metrics with icons */}
          <View className="mt-1.5 flex-row items-center">
            <Ionicons name="heart" size={11} color={theme.textSubtle} style={{ marginRight: 3 }} />
            <Text className="font-sans text-[11px]" style={{ color: theme.textSubtle }}>
              {FormatNumber(likesValue)}
            </Text>
            <Text className="mx-2 font-sans text-[11px]" style={{ color: theme.textSubtle }}>
              •
            </Text>
            <MaterialCommunityIcons name="eye" size={12} color={theme.textSubtle} style={{ marginRight: 3 }} />
            <Text className="font-sans text-[11px]" style={{ color: theme.textSubtle }}>
              {FormatNumber(viewsValue)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  // Column mode — used by horizontal carousels. `cover` crops portrait
  // thumbnails to fill the slot rather than letterboxing with white bars
  // that blend into the light theme background.
  return (
    <TouchableOpacity activeOpacity={0.7} className="mx-2" onPress={handlePress} {...props}>
      <View className="flex-column" style={{ width: customWidth ?? 150 }}>
        <FastImage
          source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
          className="rounded-md"
          style={{ height: customHeight ?? 100, width: customWidth ?? 150, backgroundColor: theme.surfaceStrong }}
          resizeMode={FastImage.resizeMode.cover}
        />
        <View className="flex flex-1 justify-between">
          <Text className="font-sans text-xs font-bold" style={{ color: theme.text }} numberOfLines={1}>
            {item.title}
          </Text>
          <View className="flex flex-row flex-wrap items-center">
            <Text className="font-sans text-xs" style={{ color: theme.textMuted }} numberOfLines={1}>
              {item?.uploader?.username || "Unknown"}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default memo(VideoCardSmall);
