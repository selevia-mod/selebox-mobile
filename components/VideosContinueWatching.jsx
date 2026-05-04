import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosContinueWatching = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, containerHeight } = useMemo(() => {
    const cw = Math.min(220, Math.round(width * 0.55));
    const layout = getVideoCardLayout({
      cardWidth: cw,
      aspectRatio: 0.6,
      avatarSize: 35,
      fontSize: 13,
    });
    return { cardWidth: cw, imageHeight: layout.imageHeight, containerHeight: getSectionTitleHeight() + layout.cardHeight };
  }, [width]);

  const renderItem = useCallback(
    ({ item }) => <VideoCardNew item={item} customHeight={imageHeight} customWidth={cardWidth} customAvatarSize={35} customFontSize={13} />,
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${index}`, []);

  // Brand-new column `last_watched_seconds` only starts populating
  // AFTER the OTA — every user has 0 progress rows at first launch
  // and feed_continue_watching returns []. Bailing here keeps the
  // tab from rendering an empty "Continue Watching" header until the
  // user has actually watched something. Matches the empty-bail
  // pattern in the seven other v4 shelves.
  if (!videos.length) return null;

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={"Continue Watching"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "continueWatching" } })}
      />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={videos}
        renderItem={renderItem}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
        removeClippedSubviews={Platform.OS === "android"}
      />
    </View>
  );
};

export default VideosContinueWatching;
