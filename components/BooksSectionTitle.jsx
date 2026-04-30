import { router } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

// Mirrors VideosSectionTitle so the Books and Videos tabs share one section-header design.
// "See All" lands on app/(book)/book-category.jsx, which is the dedicated books See-All
// page (separate from the video-only `category` route). The book-category page reads
// from redux first for instant render and falls back to a 5-minute TTL memory cache.
const BooksSectionTitle = ({ title, showSeeAll = true }) => {
  const { theme } = useAppTheme();
  const handleSectionPress = () => {
    router.push({
      pathname: "book-category",
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

export default BooksSectionTitle;
