import { FontAwesome } from "@expo/vector-icons";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosPerCategory = ({ category, videos = [], style }) => {
  const { theme } = useAppTheme();
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

  if (videos.length === 0) return;

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
    <View style={{ minHeight: containerHeight, ...style }} className={videos.length === 0 ? "items-center justify-center" : ""}>
      <VideosSectionTitle title={category} />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, index) => `column-${index}`}
        data={videos}
        renderItem={renderColumn}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center">
            <FontAwesome name="film" size={48} color={theme.textSubtle} />
            <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
              No Videos Found
            </Text>
            <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
              We couldn’t find any videos in this category.{"\n"}
              Try exploring another one or upload your own!
            </Text>
          </View>
        }
      />
    </View>
  );
};

export default VideosPerCategory;
