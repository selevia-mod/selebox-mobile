// VideosQuickPicks — short videos under 1 minute. The "I have 5 minutes
// to kill" shelf. Filter is client-side off the existing baseVideos
// pool (no extra RPC), filtered by `duration` set during the Bunny
// Stream backfill (May 2026 — populated 99.85% of the catalog).
//
// Why client-derived rather than a dedicated RPC: at our current
// catalog size the filter is cheap, and a server-side endpoint
// wouldn't return materially different results. When we hit the
// scale where a "WHERE duration <= 60" scan starts costing real
// query time, swap to a partial index + RPC.

import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosQuickPicks = ({ videos = [] }) => {
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
        title={"Quick Picks"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "quickPicks" } })}
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

export default VideosQuickPicks;
