// VideosUnderratedForYou — Hidden Gems' personal cousin. Low-view
// videos whose tags match what the user has been watching most.
// "Matches your taste, but not widely viewed yet" per the design brief.
//
// Personalization signal today: we intersect tag overlap between the
// user's most recently-watched videos (from videosCache.continueWatching)
// and the under-viewed pool. When the dedicated personalization RPC
// lands (server-side affinity scoring against a per-user tag profile),
// swap the upstream filter in app/(tabs)/videos.jsx for that.

import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosUnderratedForYou = ({ videos = [] }) => {
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

  if (!videos.length) return null;

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={"Underrated For You"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "underratedForYou" } })}
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

export default VideosUnderratedForYou;
