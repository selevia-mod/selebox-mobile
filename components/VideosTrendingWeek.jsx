import { FlatList, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosTrendingWeek = ({ videos = [] }) => {
  const { width } = useWindowDimensions();
  const cardWidth = width * 0.8;
  const { imageHeight, cardHeight } = getVideoCardLayout({ cardWidth, aspectRatio: 0.59 });
  const containerHeight = getSectionTitleHeight() + cardHeight;

  const renderItem = ({ item }) => {
    return <VideoCardNew key={item.uri} item={item} customHeight={imageHeight} customWidth={cardWidth} />;
  };

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle title={"Trending this Week"} />
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

export default VideosTrendingWeek;
