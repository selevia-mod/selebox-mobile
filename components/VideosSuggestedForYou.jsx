import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosSuggestedForYou = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, cardHeight } = useMemo(() => {
    const cw = width * 0.62;
    const layout = getVideoCardLayout({
      cardWidth: cw,
      aspectRatio: 0.64,
      avatarSize: 30,
      fontSize: 13,
    });
    return { cardWidth: cw, imageHeight: layout.imageHeight, cardHeight: layout.cardHeight };
  }, [width]);
  const maxRows =
    videos.reduce((max, col) => {
      const len = Array.isArray(col) ? col.length : 0;
      return Math.max(max, len);
    }, 0) || 1;
  const containerHeight = getSectionTitleHeight() + maxRows * cardHeight;

  const renderColumn = useCallback(
    ({ item }) => (
      <View>
        {item?.map((video, idx) => (
          <VideoCardNew
            key={video?.$id || idx}
            item={video}
            customHeight={imageHeight}
            customWidth={cardWidth}
            customAvatarSize={30}
            customFontSize={13}
          />
        ))}
      </View>
    ),
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((_, index) => `column-${index}`, []);

  return (
    <View style={{ minHeight: containerHeight }}>
      <VideosSectionTitle title={"Suggested For You"} />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={videos}
        renderItem={renderColumn}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={3}
        removeClippedSubviews={Platform.OS === "android"}
      />
    </View>
  );
};

export default VideosSuggestedForYou;
