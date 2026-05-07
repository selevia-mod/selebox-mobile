import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosMostPeopleWant = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, containerHeight } = useMemo(() => {
    const cw = width * 0.8;
    const layout = getVideoCardLayout({ cardWidth: cw, aspectRatio: 0.59 });
    return { cardWidth: cw, imageHeight: layout.imageHeight, containerHeight: getSectionTitleHeight() + layout.cardHeight };
  }, [width]);

  const renderItem = useCallback(
    ({ item }) => <VideoCardNew item={item} customWidth={cardWidth} customHeight={imageHeight} />,
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${index}`, []);
  // getItemLayout lets FlatList skip the measurement pass for off-screen
  // cards on first scroll. Without it, the recycler measures every card
  // before painting — visible as a stutter the first time a user swipes
  // a horizontal shelf.
  //
  // CRITICAL: VideoCardNew has `mr-3` (Tailwind = 12px) on its outer
  // wrapper, so each cell occupies cardWidth + 12. Forgetting to include
  // the margin makes FlatList think items are 12px narrower than they
  // actually are — by card N, the predicted offset is 12*N pixels off
  // from reality, so FlatList re-measures + relayouts on every scroll
  // frame, which the user sees as a stutter / "the app got slower."
  const getItemLayout = useCallback(
    (_data, index) => ({ length: cardWidth + 12, offset: (cardWidth + 12) * index, index }),
    [cardWidth],
  );

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={"Most People Want"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "mostPeopleWant" } })}
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

export default VideosMostPeopleWant;
