import { router } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const VideosSectionTitle = ({ title, showSeeAll = true }) => {
  const { theme } = useAppTheme();
  const handleSectionPress = () => {
    router.push({
      pathname: "category",
      params: {
        category: title,
      },
    });
  };

  return (
    <View className="flex w-[100%] flex-row items-center justify-between py-3">
      <Text className="font-sans text-lg font-bold" style={{ fontFamily: "Poppins-Bold", color: theme.text }}>
        {title}
      </Text>
      {showSeeAll && (
        <TouchableOpacity onPress={handleSectionPress}>
          <Text className="text-md font-sans" style={{ fontFamily: "Poppins-Medium", color: theme.primary }}>
            See All
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

export default VideosSectionTitle;
