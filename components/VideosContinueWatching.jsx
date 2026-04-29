import { FlatList, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosContinueWatching = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(220, Math.round(width * 0.55));
  const { imageHeight, cardHeight } = getVideoCardLayout({
    cardWidth,
    aspectRatio: 0.6,
    avatarSize: 35,
    fontSize: 13,
  });
  const containerHeight = getSectionTitleHeight() + cardHeight;
  const renderItem = ({ item }) => {
    return <VideoCardNew key={item.uri} item={item} customHeight={imageHeight} customWidth={cardWidth} customAvatarSize={35} customFontSize={13} />;
  };

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle title={"Continue Watching"} />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
        data={videos}
        renderItem={renderItem}
      />
    </View>
  );
};

export default VideosContinueWatching;
