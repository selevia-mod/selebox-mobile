import { Dimensions, Text, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

const Loader = ({ isLoading, isFullHeightWidth }) => {
  const { theme } = useAppTheme();
  if (!isLoading) return;
  const { height, width } = Dimensions.get("window");
  const style = isFullHeightWidth ? { height, width } : undefined;
  return (
    <SafeAreaView
      className="absolute z-10 h-full w-full items-center justify-center space-y-4"
      style={[style, { backgroundColor: theme.background }]}
    >
      <View className="space-y-[-10px]">
        <Text className="font-pbold text-3xl tracking-[3px]" style={{ color: theme.text }}>
          SELEBOX
        </Text>
        <View className="flex flex-row items-center space-x-1">
          <View className="h-[1px] flex-1" style={{ backgroundColor: theme.divider }} />
          <Text className="font-pmedium text-xs" style={{ color: theme.textMuted }}>
            Entertainment
          </Text>
          <View className="h-[1px] flex-1" style={{ backgroundColor: theme.divider }} />
        </View>
      </View>
      <LoaderKit style={{ width: 40, height: 40 }} name={"LineScalePulseOutRapid"} color={theme.primary} />
    </SafeAreaView>
  );
};

export default Loader;
