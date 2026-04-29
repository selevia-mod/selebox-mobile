import { Dimensions, Platform, Text, View } from "react-native";
import FastImage from "react-native-fast-image";
import { NativeAdView, NativeAsset, NativeAssetType, NativeMediaView } from "react-native-google-mobile-ads";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const BOTTOM_TAB_BAR_HEIGHT = Platform.OS === "ios" ? 83 : 50;

const ClipsNativeAdComponent = ({ nativeAd }) => {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();

  return (
    // Wrap all the ad assets in the NativeAdView component, and register the view with the nativeAd prop
    <NativeAdView
      style={{ height: SCREEN_HEIGHT, paddingBottom: BOTTOM_TAB_BAR_HEIGHT + insets.bottom + 25, justifyContent: "center" }}
      nativeAd={nativeAd}
    >
      {/*  Display the media asset */}
      <NativeMediaView resizeMode="stretch" />

      <View className="px-2" style={{ position: "absolute", bottom: 0, paddingBottom: BOTTOM_TAB_BAR_HEIGHT + insets.bottom + 35 }}>
        <View className="mb-1 flex-row items-center">
          {/* Display the icon asset with Image component, and use NativeAsset to register the view */}
          {nativeAd?.icon && (
            <NativeAsset assetType={NativeAssetType.ICON}>
              <FastImage source={{ uri: nativeAd?.icon?.url }} className="mr-2 h-9 w-9 rounded-full" />
            </NativeAsset>
          )}
          {/*  Display the headline asset with Text component, and use NativeAsset to register the view */}
          <NativeAsset assetType={NativeAssetType.HEADLINE}>
            <View>
              <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
                {nativeAd?.headline}
              </Text>
            </View>
          </NativeAsset>
        </View>

        <NativeAsset assetType={NativeAssetType.BODY}>
          <View>
            <Text style={{ color: theme.primaryContrast }}>{nativeAd?.body}</Text>
          </View>
        </NativeAsset>

        {/*  Always display an ad attribution to denote that the view is an advertisement */}
        <View className="my-2 w-[100px] items-center rounded-xl px-1 py-1" style={{ backgroundColor: theme.mediaOverlayStrong }}>
          <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
            Sponsored
          </Text>
        </View>

        {/* <NativeAsset assetType={NativeAssetType.STORE}>
          <Text style={{ color: theme.primaryContrast }}>{nativeAd.store}</Text>
        </NativeAsset>

        <NativeAsset assetType={NativeAssetType.STAR_RATING}>
          <Text style={{ color: theme.primaryContrast }}>{nativeAd.price}</Text>
        </NativeAsset> */}
      </View>
    </NativeAdView>
  );
};

export default ClipsNativeAdComponent;
