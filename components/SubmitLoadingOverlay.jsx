import { BlurView } from "expo-blur";
import { StyleSheet, Text, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import useAppTheme from "../hooks/useAppTheme";

const SubmitLoadingOverlay = ({ visible, message = "Please wait..." }) => {
  const { theme, isDarkMode } = useAppTheme();

  if (!visible) return null;

  return (
    <BlurView intensity={60} tint={isDarkMode ? "dark" : "light"} style={StyleSheet.absoluteFill} className="z-50 items-center justify-center">
      <View
        className="mx-6 w-full max-w-[280px] items-center rounded-3xl px-6 py-7"
        style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
      >
        <LoaderKit style={{ width: 54, height: 54 }} name="LineScalePulseOutRapid" color={theme.primary} />
        <Text className="mt-4 text-center text-base font-semibold" style={{ color: theme.text }}>
          {message}
        </Text>
      </View>
    </BlurView>
  );
};

export default SubmitLoadingOverlay;
