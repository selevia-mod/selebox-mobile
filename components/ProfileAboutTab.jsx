import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const ProfileAboutTab = () => {
  const { theme } = useAppTheme();
  return (
    <View className="flex-1 items-center justify-center">
      <View className="flex-1 items-center justify-center">
        <Text className="text-lg font-bold" style={{ color: theme.text }}>
          🚧 New Feature Incoming!
        </Text>
        <Text style={{ color: theme.textMuted }}>🚀Something awesome is in the works—stay tuned!</Text>
      </View>
    </View>
  );
};

export default ProfileAboutTab;
