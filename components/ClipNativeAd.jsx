import { AntDesign } from "@expo/vector-icons";
import { Dimensions, Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import ClipsNativeAdComponent from "./ClipsNativeAdComponent";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const BOTTOM_TAB_BAR_HEIGHT = Platform.OS === "ios" ? 83 : 50;

const ClipNativeAd = ({ nativeAd }) => {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();

  if (!nativeAd) {
    return (
      <View
        style={{
          height: SCREEN_HEIGHT,
          paddingBottom: BOTTOM_TAB_BAR_HEIGHT + insets.bottom + 25,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.mediaBackground,
        }}
      >
        <View
          style={{
            backgroundColor: theme.surfaceElevated,
            padding: 16,
            borderRadius: 12,
            alignItems: "center",
            width: "80%",
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "600", color: theme.text, marginBottom: 8 }}>Ad Unavailable</Text>
          <Text style={{ fontSize: 14, color: theme.textMuted, textAlign: "center" }}>
            We're unable to load this ad right now. Please continue enjoying your feed.
          </Text>
        </View>
        <View style={{ marginTop: 24 }}>
          <AntDesign name="disconnect" size={48} color={theme.textSubtle} />
        </View>
      </View>
    );
  }

  return <ClipsNativeAdComponent nativeAd={nativeAd} />;
};

export default ClipNativeAd;
