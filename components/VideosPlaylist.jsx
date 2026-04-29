import { FontAwesome6, MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const VideosPlaylist = () => {
  const { theme } = useAppTheme();

  return (
    <View className="flex-1 items-center justify-center px-6">
      <View className="items-center">
        {/* Maintenance Icon */}
        <FontAwesome6 name="screwdriver-wrench" size={80} color={theme.accentAmber} />

        {/* Maintenance Text */}
        <Text className="mt-8 text-center font-pextrabold text-4xl font-bold" style={{ color: theme.text }}>
          IN DEVELOPMENT
        </Text>

        {/* Subtitle */}
        <View className="mt-6 flex-row items-center space-x-2">
          <MaterialCommunityIcons name="clock-outline" size={20} color={theme.textSubtle} />
          <Text className="text-center text-base" style={{ color: theme.textSoft }}>
            We'll be launching this soon
          </Text>
        </View>
      </View>
    </View>
  );
};

export default VideosPlaylist;
