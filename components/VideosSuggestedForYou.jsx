import { FlatList, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosSuggestedForYou = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const cardWidth = width * 0.62;
  const { imageHeight, cardHeight } = getVideoCardLayout({
    cardWidth,
    aspectRatio: 0.64,
    avatarSize: 30,
    fontSize: 13,
  });
  const maxRows =
    videos.reduce((max, col) => {
      const len = Array.isArray(col) ? col.length : 0;
      return Math.max(max, len);
    }, 0) || 1;
  const containerHeight = getSectionTitleHeight() + maxRows * cardHeight;

  const renderColumn = ({ item }) => (
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
  );

  return (
    <View style={{ minHeight: containerHeight }}>
      <VideosSectionTitle title={"Suggested For You"} />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, index) => `column-${index}`}
        data={videos}
        renderItem={renderColumn}
      />
    </View>
  );
};

export default VideosSuggestedForYou;
