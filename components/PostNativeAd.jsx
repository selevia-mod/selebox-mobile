import { useEffect, useState } from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import {
  NativeAd,
  NativeAdView,
  NativeAsset,
  NativeAssetType,
  NativeMediaAspectRatio,
  NativeMediaView,
  TestIds,
} from "react-native-google-mobile-ads";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import PostNativeAdPlaceholder from "./PostNativeAdPlaceholder";

const PostNativeAd = () => {
  const { globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const [nativeAd, setNativeAd] = useState(null);

  const productionID = Platform.OS === "android" ? globalSettings["ANDROID_NATIVE_AD_PROD_ID"] : globalSettings["IOS_NATIVE_AD_PROD_ID"];
  const adUnitID = __DEV__ ? TestIds.NATIVE : productionID;

  useEffect(() => {
    NativeAd.createForAdRequest(adUnitID, {
      startVideoMuted: true,
      aspectRatio: NativeMediaAspectRatio.LANDSCAPE,
    })
      .then(setNativeAd)
      .catch(console.error);
  }, []);

  if (!nativeAd) {
    return <PostNativeAdPlaceholder />;
  }

  const mediaHeight = 240;

  return (
    <NativeAdView
      nativeAd={nativeAd}
      style={{
        width: "100%",
        marginTop: 6,
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: theme.card,
        borderWidth: 1,
        borderColor: theme.border,
      }}
    >
      {/* Header: Icon + Title + Sponsored */}
      <View className="mb-2 flex-row items-center justify-between px-4 pt-4">
        <View className="flex-row items-center">
          {nativeAd?.icon?.url && (
            <NativeAsset assetType={NativeAssetType.ICON}>
              <FastImage source={{ uri: nativeAd?.icon?.url }} style={{ width: 40, height: 40, borderRadius: 8, marginRight: 10 }} />
            </NativeAsset>
          )}
          <View>
            <NativeAsset assetType={NativeAssetType.HEADLINE}>
              <Text className="font-semibold" style={{ color: theme.text }}>
                {nativeAd?.headline}
              </Text>
            </NativeAsset>
            <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
              Sponsored
            </Text>
          </View>
        </View>
      </View>

      {/* Body */}
      <NativeAsset assetType={NativeAssetType.BODY}>
        <Text className="mb-2 px-4 text-sm" style={{ color: theme.text }}>
          {nativeAd?.body}
        </Text>
      </NativeAsset>

      {/* Media View with fixed height to avoid list overlap */}
      <View style={{ width: "100%", height: mediaHeight }}>
        <NativeMediaView style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      </View>

      {/* Call-to-action */}
      {nativeAd?.callToAction && (
        <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
          <TouchableOpacity
            style={{
              backgroundColor: theme.primary,
              borderRadius: 8,
              paddingVertical: 10,
              alignItems: "center",
              marginVertical: 10,
              marginHorizontal: 8,
            }}
          >
            <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
              {nativeAd?.callToAction}
            </Text>
          </TouchableOpacity>
        </NativeAsset>
      )}
    </NativeAdView>
  );
};

export default PostNativeAd;
