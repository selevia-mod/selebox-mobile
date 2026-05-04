import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Alert, Image, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";
// Phase E.9 — tier-aware image transform.
import { optimizedImageUri } from "../lib/utils/image-source";

const BottomNavPopup = ({ handlePlusPress }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const isOffline = useIsOffline();

  const showOfflineAlert = () => {
    Alert.alert("You're Offline", "Please connect to the internet to create content.");
  };

  const handleOnPress = (type) => {
    if (isOffline) return showOfflineAlert();
    handlePlusPress();
    router.push({ pathname: "/studio", params: { type } });
  };

  const handleCreatePost = () => {
    if (isOffline) return showOfflineAlert();
    handlePlusPress();
    router.push("/create-post");
  };

  const handleCreateBook = () => {
    handlePlusPress();
    router.push("/book-editor");
  };

  return (
    <TouchableOpacity
      className="absolute z-10 w-full items-center"
      style={{ bottom: insets.bottom + 70 }}
      activeOpacity={1}
      onPress={handlePlusPress}
    >
      <View
        className="w-[95%] flex-row flex-wrap justify-between rounded-[10px] p-2 shadow-md"
        style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
      >
        {/* Create Post */}
        <TouchableOpacity
          onPress={handleCreatePost}
          activeOpacity={0.8}
          className="mb-2 w-[49%] flex-row items-center rounded-[10px] px-1.5 py-4 shadow-sm"
          style={{ backgroundColor: theme.card }}
        >
          <FastImage source={{ uri: optimizedImageUri(user?.avatar, { width: 40 }) }} className="h-10 w-10 rounded-full" resizeMode="cover" />
          <View className="flex-1 pl-2">
            <Text className="text-[13px] font-semibold" style={{ color: theme.text }}>
              Create a post
            </Text>
            <Text className="text-[10px]" style={{ color: theme.textSoft }}>
              Share your thoughts
            </Text>
          </View>
        </TouchableOpacity>

        {/* Create Reels — coming soon. The previous "Create a clip"
            slot was retired (clips feature deprecated May 2026); this
            placeholder signals to users that a new short-form format
            is on the way rather than leaving a hole in the grid.
            Disabled state styled to match other "coming soon"
            affordances elsewhere in the app. */}
        <TouchableOpacity
          disabled
          activeOpacity={0.5}
          className="mb-2 w-[49%] flex-row items-center rounded-[10px] px-1.5 py-4 opacity-60"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <View className="relative">
            <View
              className="h-10 w-10 items-center justify-center rounded-lg"
              style={{ backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}
            >
              <MaterialCommunityIcons name="movie-open-play-outline" size={22} color={theme.primary} />
            </View>
            <View
              className="absolute -right-1 -top-1 rounded-full px-1"
              style={{ backgroundColor: theme.primary }}
            >
              <Text className="text-[8px] font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.3 }}>
                SOON
              </Text>
            </View>
          </View>
          <View className="flex-1 pl-2">
            <View className="flex-row items-center space-x-1">
              <Text className="text-[13px] font-semibold" style={{ color: theme.text }}>
                Create a reel
              </Text>
            </View>
            <Text className="text-[10px]" style={{ color: theme.primary, letterSpacing: 0.3 }}>
              Coming soon
            </Text>
          </View>
        </TouchableOpacity>

        {/* Create Video */}
        <TouchableOpacity
          onPress={() => handleOnPress("video")}
          activeOpacity={0.8}
          className="w-[49%] flex-row items-center rounded-[10px] px-1.5 py-4 shadow-sm"
          style={{ backgroundColor: theme.card }}
        >
          <Image source={require("../assets/images/videos_icon.png")} className="h-10 w-10 rounded-lg" resizeMode="contain" />
          <View className="flex-1 pl-2">
            <Text className="text-[13px] font-semibold" style={{ color: theme.text }}>
              Create a video
            </Text>
            <Text className="text-[10px]" style={{ color: theme.textSoft }}>
              Share your contents
            </Text>
          </View>
        </TouchableOpacity>

        {/* Create Book */}
        <TouchableOpacity
          onPress={handleCreateBook}
          activeOpacity={0.8}
          className="w-[49%] flex-row items-center rounded-[10px] px-1.5 py-4 shadow-sm"
          style={{ backgroundColor: theme.card }}
        >
          <Image source={require("../assets/images/books_icon.png")} className="h-10 w-10 rounded-lg" resizeMode="contain" />
          <View className="flex-1 pl-2">
            <Text className="text-[13px] font-semibold" style={{ color: theme.text }}>
              Create a book
            </Text>
            <Text className="text-[10px]" style={{ color: theme.textSoft }}>
              Share your stories
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};

export default BottomNavPopup;
