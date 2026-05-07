// VideosFromYourFollowers — videos that people you follow have liked
// or watched recently. Different from "From creators you follow"
// (which shows uploads from followed creators); this is the social-
// proof shelf: "here's what your friends are watching."
//
// Server logic in feed_from_your_followers (migration_video_shelves_v4.sql)
// unions video_likes + video_progress engagement rows from followed
// users in the last 14 days, dedups per video by most-recent
// engagement, excludes the viewer's own watches.

import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosFromYourFollowers = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, containerHeight } = useMemo(() => {
    const cw = width * 0.8;
    const layout = getVideoCardLayout({ cardWidth: cw, aspectRatio: 0.59 });
    return { cardWidth: cw, imageHeight: layout.imageHeight, containerHeight: getSectionTitleHeight() + layout.cardHeight };
  }, [width]);

  const renderItem = useCallback(
    ({ item }) => <VideoCardNew item={item} customHeight={imageHeight} customWidth={cardWidth} />,
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${index}`, []);
  // +12 accounts for VideoCardNew's mr-3 (Tailwind = 12px); without it
  // FlatList's predicted offsets drift 12px per card and cause stutter.
  const getItemLayout = useCallback(
    (_data, index) => ({ length: cardWidth + 12, offset: (cardWidth + 12) * index, index }),
    [cardWidth],
  );

  if (!videos.length) return null;

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={"From Your Followers"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "fromYourFollowers" } })}
      />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={videos}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
        removeClippedSubviews={Platform.OS === "android"}
      />
    </View>
  );
};

export default VideosFromYourFollowers;
