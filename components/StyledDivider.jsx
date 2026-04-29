import { View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

function StyledDivider({ children, dividerColor = "", color, ...props }) {
  const { theme } = useAppTheme();
  const resolvedColor = color || theme.divider;

  return (
    <>
      <View className={`w-full flex-row items-center justify-center ${children ? "space-x-2" : ""}`} {...props}>
        <View className={`h-px flex-1 ${color || !dividerColor ? "" : dividerColor}`} style={{ backgroundColor: resolvedColor }} />
        {children}
        <View className={`h-px flex-1 ${color || !dividerColor ? "" : dividerColor}`} style={{ backgroundColor: resolvedColor }} />
      </View>
    </>
  );
}

export default StyledDivider;
