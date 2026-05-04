// VideosBingeWorthy — designed for continuous watching. Today the
// upstream filter groups videos by shared tags (proxy for "series"
// or "parts") and surfaces the densest tag-clusters first. Real
// episode/parent relationships will replace this once the
// `series_id` / `episode_index` columns land on `videos`.
//
// Render contract is the same as the other shelves; the smarts live
// upstream so the component stays a thin presentational layer.

import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosBingeWorthy = ({ videos = [] }) => {
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
        title={"Binge-Worthy"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "bingeWorthy" } })}
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

export default VideosBingeWorthy;
