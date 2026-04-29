import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

function StyledTitle({ title, titleStyle, icon, ...props }) {
  const { theme } = useAppTheme();

  return (
    <View className="flex-row items-center space-x-2 py-4" {...props}>
      {icon}
      <Text className="font-sans text-sm font-bold" style={[{ color: theme.text }, titleStyle]}>
        {title}
      </Text>
    </View>
  );
}
export default StyledTitle;
