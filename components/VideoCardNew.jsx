import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { useGlobalContext } from "../context/global-provider";
import FormatNumber from "../lib/utils/format-number";
import TimeAgo from "../lib/utils/time-ago";
import { formatDurationCompact, getVideoDurationSeconds } from "../lib/utils/video-duration";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const VideoCardNew = ({ item, customWidth, customHeight, customAvatarSize, customFontSize, hideAvatar = false, ...props }) => {
  const { globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  // useWindowDimensions stays in sync with rotation and avoids a Dimensions.get
  // call on every render. Trivial perf win; the bigger one is the useMemo'd
  // layout block below.
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  // Avatar `error` flag stays so the initials placeholder survives a dead URL.
  // The previous `loading` state + LoaderKit spinner are gone — initials are
  // now painted statically behind the FastImage so there's nothing to "load
  // vs not load" on the React side.
  const [error, setError] = useState(false);
  // Lazy duration — same pattern as VideoCardSmall. Cached + dedup'd in the
  // shared util so an item that's already had its manifest parsed once doesn't
  // re-fetch on remount.
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
  const avatarUri = item?.uploader?.avatar;

  // Layout math is memoized so it's not re-run on every render. Deps are all
  // primitive numbers so the memo hits its cache immediately for the common
  // case where the parent passes stable customWidth/customHeight values.
  const layout = useMemo(() => {
    const cw = customWidth || SCREEN_WIDTH * 0.8;
    const ch = customHeight || cw * 0.56;
    const as = customAvatarSize || 40;
    const fs = customFontSize || 14;
    const tlh = Math.round(fs * 1.35);
    const mfs = Math.max(12, Math.round(fs * 0.9));
    const mlh = Math.round(mfs * 1.35);
    const tbh = tlh * 2 + mlh * 2 + 2;
    return {
      cardWidth: cw,
      cardHeight: ch,
      avatarSize: as,
      fontSize: fs,
      titleLineHeight: tlh,
      metaFontSize: mfs,
      metaLineHeight: mlh,
      textBlockHeight: tbh,
      rowHeight: Math.max(as, tbh),
    };
  }, [customWidth, customHeight, customAvatarSize, customFontSize, SCREEN_WIDTH]);
  const { cardWidth, cardHeight, avatarSize, fontSize, titleLineHeight, metaFontSize, metaLineHeight, textBlockHeight, rowHeight } = layout;

  const handlePress = useCallback(
    (view) => {
      try {
        router.push({
          pathname: "video-player",
          params: {
            id: item.uri,
            docId: item.$id,
            view: view,
          },
        });
      } catch (error) {}
    },
    [item?.uri, item?.$id],
  );

  const getInitials = (name) => {
    if (!name) return "?";
    const words = name.trim().split(" ");
    const initials = words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("");
    return initials || "?";
  };

  return (
    <View style={{ width: cardWidth }} className="mb-4 mr-3 space-y-2" {...props}>
      <TouchableOpacity className="space-y-2" activeOpacity={0.7} onPress={() => handlePress("RECOMMENDED")} accessibilityLabel="Play Video">
        <View style={{ height: cardHeight, width: cardWidth, borderRadius: 10, overflow: "hidden", backgroundColor: theme.surfaceStrong }}>
          {/* `cover` (was `contain`) crops portrait thumbnails to fill the
              landscape card slot — no more white letterbox bars on light
              mode that read as empty padding bleeding into the background.
              Same pattern YouTube/Instagram use for thumbnail rails. */}
          <FastImage
            style={{ height: "100%", width: "100%" }}
            source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
            resizeMode={FastImage.resizeMode.cover}
          />
          {/* Duration pill bottom-right of the thumbnail — YouTube-style. */}
          {durationLabel ? (
            <View
              style={{
                position: "absolute",
                bottom: 6,
                right: 6,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 4,
                backgroundColor: "rgba(0,0,0,0.78)",
              }}
            >
              <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "600", letterSpacing: 0.2 }}>{durationLabel}</Text>
            </View>
          ) : null}
        </View>
        <View className="flex-row items-start space-x-2" style={{ minHeight: rowHeight }}>
          {!hideAvatar && (
            // Avatar — initials painted as a static placeholder behind the
            // FastImage. When the image loads it covers the initials; if it
            // errors or the user has no avatar, the initials stay visible.
            // The previous LoaderKit spinner ran an animation loop per card
            // (BallScaleMultiple) which fought scroll on horizontal rails
            // with 30+ cards. Static placeholder = zero animation cost +
            // identical visual outcome on the happy path.
            <View
              className="items-center justify-center overflow-hidden rounded-full"
              style={{
                height: avatarSize,
                width: avatarSize,
                backgroundColor: theme.surfaceMuted,
              }}
            >
              <Text
                className="font-bold"
                style={{ fontFamily: "Poppins-Bold", color: theme.textMuted, fontSize: Math.max(10, Math.round(avatarSize * 0.36)) }}
              >
                {getInitials(item?.uploader?.name)}
              </Text>
              {!error && !!avatarUri && (
                <FastImage
                  source={{ uri: avatarUri, priority: FastImage.priority.normal }}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    height: avatarSize,
                    width: avatarSize,
                  }}
                  resizeMode={FastImage.resizeMode.cover}
                  onError={() => setError(true)}
                />
              )}
            </View>
          )}
          <View className="flex flex-1 flex-col space-y-0.5" style={{ minHeight: textBlockHeight }}>
            <Text
              className="font-sans font-bold"
              style={{ fontSize: fontSize, lineHeight: titleLineHeight, fontFamily: "Poppins-Bold", color: theme.text }}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {item?.title}
            </Text>
            <View className="flex flex-row items-center self-start" style={{ maxWidth: "100%" }}>
              <Text
                className="font-sans"
                style={{ fontSize: metaFontSize, lineHeight: metaLineHeight, fontFamily: "Poppins-Regular", flexShrink: 1, color: theme.textMuted }}
                numberOfLines={1}
              >
                {item?.uploader?.username || "Unknown"}
              </Text>
              <UserRoleBadgeIcons user={item?.uploader} size={15} />
            </View>
            <View className="flex flex-row flex-wrap items-center">
              <Text
                className="font-sans text-xs"
                style={{ fontSize: metaFontSize, lineHeight: metaLineHeight, fontFamily: "Poppins-Regular", color: theme.textMuted }}
                numberOfLines={1}
              >
                {FormatNumber((item?.videoStats?.totalViews || 0) * (Number(globalSettings["VIEWS_MULTIPLIER"]) || 1))} Views
                <Text> • </Text>
                {TimeAgo(item.publishDate ?? item.$createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

// React.memo with default shallow comparison. Parents pass stable
// customWidth/customHeight numbers + the same `item` object across renders, so
// this short-circuits on every parent re-render that doesn't change props.
export default memo(VideoCardNew);
