import { Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

// Every shelf must opt in to the See All button by passing
// `onSeeAllPress`. The previous default fell through to a tag-search
// `/category?category=<title>` route which made sense for tag-shaped
// titles (TrendingWeek = the tag "Trending") but produced confusing
// behavior on shelves whose titles aren't tags (Most People Want,
// Continue Watching, etc.). Now every shelf in app/(tabs)/videos.jsx
// routes to /(video)/shelf-all?type=<bucket> via onSeeAllPress, so
// the fallback is no longer needed. Without onSeeAllPress, the
// See All affordance is hidden so a misconfigured caller can't
// render a no-op button.
const VideosSectionTitle = ({ title, showSeeAll = true, onSeeAllPress }) => {
  const { theme } = useAppTheme();
  const seeAllVisible = showSeeAll && typeof onSeeAllPress === "function";

  return (
    <View className="flex w-[100%] flex-row items-center justify-between py-3">
      <Text className="font-sans text-lg font-bold" style={{ fontFamily: "Poppins-Bold", color: theme.text }}>
        {title}
      </Text>
      {seeAllVisible && (
        <TouchableOpacity onPress={onSeeAllPress}>
          <Text className="text-md font-sans" style={{ fontFamily: "Poppins-Medium", color: theme.primary }}>
            See All
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

export default VideosSectionTitle;
