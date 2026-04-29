import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Alert, Image, Pressable, Text, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";

const PostShareYourThoughts = ({ onPress }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const isOffline = useIsOffline();

  const showOfflineAlert = () => {
    Alert.alert("You're Offline", "Please connect to the internet to create content.");
  };

  const handleOnPress = (type) => {
    if (isOffline) return showOfflineAlert();
    router.push({ pathname: "/studio", params: { type } });
  };

  const handleCreateBook = () => {
    if (isOffline) return showOfflineAlert();
    router.push("/book-editor");
  };
  return (
    <View className="flex-row">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(139,134,248,0.12)" }}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 5,
          borderRadius: 13,
          borderWidth: 1,
          borderColor: pressed ? "rgba(139,134,248,0.35)" : theme.border,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
        })}
      >
        {/* Fake Input + Icons */}
        <View className="flex-1 flex-row items-center">
          <Ionicons name="create-outline" size={20} color={theme.accentPurple} />
          <Text className="ml-2 flex-1 text-[13px] font-medium" style={{ color: theme.textSoft }}>
            Share your thoughts...
          </Text>
        </View>
        <View className="mx-3 h-5 w-px" style={{ backgroundColor: theme.divider }} />
        <View className="flex-row items-center">
          {/* Temporary Commented Out - Clips in Maintenance */}
          {/* <TouchableOpacity onPress={() => handleOnPress("clip")} activeOpacity={0.8}>
              <Image source={require("../assets/images/clips_icon.png")} className="h-8 w-8" resizeMode="contain" />
            </TouchableOpacity> */}
          <TouchableOpacity onPress={() => handleOnPress("video")} activeOpacity={0.8} className="h-9 w-9 items-center justify-center">
            <Image source={require("../assets/images/videos_icon.png")} className="h-7 w-7" resizeMode="contain" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleCreateBook} activeOpacity={0.8} className="ml-2 h-9 w-9 items-center justify-center">
            <Image source={require("../assets/images/books_icon.png")} className="h-7 w-7" resizeMode="contain" />
          </TouchableOpacity>
        </View>
      </Pressable>
    </View>
  );
};

export default PostShareYourThoughts;
