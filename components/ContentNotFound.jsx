import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";

const ContentNotFound = ({ type, icon, iconName }) => {
  const isOffline = useIsOffline();
  const { theme } = useAppTheme();

  // 🌐 OFFLINE UI
  if (isOffline) {
    return (
      <View className="flex-1 items-center justify-center px-6 py-12">
        <View className="rounded-3xl p-8" style={{ backgroundColor: theme.offlineBg, borderWidth: 1, borderColor: theme.offlineBorder }}>
          <MaterialCommunityIcons name="wifi-off" size={72} color={theme.offlineIcon} />
        </View>

        <Text className="mt-6 text-2xl font-semibold" style={{ color: theme.text }}>
          No Internet Connection
        </Text>

        <Text className="mt-2 text-center text-base" style={{ color: theme.textSoft }}>
          Please check your connection and try again.
        </Text>

        <View className="mt-6 h-1 w-16 rounded-full" style={{ backgroundColor: theme.handle }} />
      </View>
    );
  }

  // 📄 ORIGINAL UI (Content Not Found)
  return (
    <View className="flex-1 items-center justify-center px-6 py-12">
      <View className="rounded-3xl p-8" style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}>
        {icon ? icon : <MaterialCommunityIcons name={iconName} size={72} color={theme.iconMuted} />}
      </View>

      <Text className="mt-6 text-2xl font-semibold" style={{ color: theme.text }}>{`${type} Not Found`}</Text>

      <Text className="mt-2 text-center text-base" style={{ color: theme.textSoft }}>
        {`The ${type?.toLowerCase()} you’re looking for doesn’t exist or may have been removed.`}
      </Text>

      <View className="mt-6 h-1 w-16 rounded-full" style={{ backgroundColor: theme.handle }} />
    </View>
  );
};

export default ContentNotFound;
