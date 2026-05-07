import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosFromFollowing = ({ videos = [] }) => {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, cardHeight, containerHeight } = useMemo(() => {
    const cw = width * 0.8;
    const layout = getVideoCardLayout({ cardWidth: cw, aspectRatio: 0.59 });
    return {
      cardWidth: cw,
      imageHeight: layout.imageHeight,
      cardHeight: layout.cardHeight,
      containerHeight: getSectionTitleHeight() + layout.cardHeight,
    };
  }, [width]);
  const isEmpty = !Array.isArray(videos) || videos.length === 0;

  const renderItem = useCallback(
    ({ item }) => <VideoCardNew item={item} customWidth={cardWidth} customHeight={imageHeight} />,
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${index}`, []);
  // +12 accounts for VideoCardNew's mr-3 (Tailwind = 12px); without it
  // FlatList's predicted offsets drift 12px per card and cause stutter.
  const getItemLayout = useCallback(
    (_data, index) => ({ length: cardWidth + 12, offset: (cardWidth + 12) * index, index }),
    [cardWidth],
  );

  // Premium empty state — shown when the user follows nobody or none of their
  // follows have videos yet. Replaces a previously-blank rail with a violet-
  // accented prompt that nudges the user toward the search experience to find
  // creators to follow. Sized to match the rail height so the layout stays stable.
  if (isEmpty) {
    return (
      <View style={{ minHeight: containerHeight }} className="space-y-2">
        <VideosSectionTitle title={"From Creators You Follow"} />
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push("/search")}
          style={{
            marginHorizontal: 4,
            height: cardHeight,
            borderRadius: 16,
            paddingHorizontal: 24,
            paddingVertical: 20,
            backgroundColor: theme.card,
            borderWidth: 1,
            borderColor: theme.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View className="h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: theme.primarySoft }}>
            <MaterialCommunityIcons name="account-heart-outline" size={28} color={theme.primary} />
          </View>
          <Text className="mt-4 text-center text-base font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
            Follow creators you love
          </Text>
          <Text className="mt-1.5 text-center text-sm" style={{ color: theme.textSoft, maxWidth: 280 }}>
            Their newest videos will land right here so you never miss what you're into.
          </Text>
          <View
            className="mt-4 flex-row items-center rounded-full px-4 py-2"
            style={{
              backgroundColor: theme.primary,
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 8,
              elevation: 3,
            }}
          >
            <MaterialCommunityIcons name="magnify" size={16} color={theme.primaryContrast} style={{ marginRight: 6 }} />
            <Text className="text-sm font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
              Find creators
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={"From Creators You Follow"}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "fromFollowing" } })}
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

export default VideosFromFollowing;
