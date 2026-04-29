import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PROFILE_BANNER_ASPECT_RATIO } from "../constants/profile";
import useAppTheme from "../hooks/useAppTheme";

const BannerCropModal = ({
  visible,
  asset,
  onClose,
  onComplete,
  aspectRatio = PROFILE_BANNER_ASPECT_RATIO,
  title = "Preview banner",
  description = "Cropped with the native editor using the banner ratio.",
  helperText = "Your banner keeps the banner aspect ratio from the editor and uploads at banner resolution.",
  confirmLabel = "Use banner",
}) => {
  const { theme } = useAppTheme();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [isCropping, setIsCropping] = useState(false);
  const [assetSize, setAssetSize] = useState({
    width: asset?.width || 0,
    height: asset?.height || 0,
  });

  const frameWidth = Math.max(280, windowWidth - 32);
  const frameHeight = Math.round(frameWidth / aspectRatio);
  const isVisible = visible && !!asset?.uri;

  useEffect(() => {
    if (!asset?.uri) return;

    let active = true;
    const nextWidth = asset?.width || 0;
    const nextHeight = asset?.height || 0;

    if (nextWidth && nextHeight) {
      setAssetSize({ width: nextWidth, height: nextHeight });
      return undefined;
    }

    Image.getSize(
      asset.uri,
      (width, height) => {
        if (!active) return;
        setAssetSize({ width, height });
      },
      () => {
        if (!active) return;
        setAssetSize({ width: 1, height: 1 });
      },
    );

    return () => {
      active = false;
    };
  }, [asset?.height, asset?.uri, asset?.width]);

  const handleClose = () => {
    if (isCropping) return;
    onClose?.();
  };

  const handleSave = async () => {
    if (!asset?.uri || isCropping) return;

    setIsCropping(true);
    try {
      await onComplete?.({
        ...asset,
        width: assetSize.width || asset?.width || 0,
        height: assetSize.height || asset?.height || 0,
      });
    } finally {
      setIsCropping(false);
    }
  };

  return (
    <Modal
      isVisible={isVisible}
      onBackdropPress={handleClose}
      onBackButtonPress={handleClose}
      style={{ margin: 0 }}
      backdropOpacity={1}
      animationIn="fadeIn"
      animationOut="fadeOut"
      useNativeDriver
      hideModalContentWhileAnimating
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: theme.mediaBackground }}>
        <View
          className="flex-1 px-4"
          style={{
            paddingTop: Math.max(insets.top, 20) + 12,
            paddingBottom: Math.max(insets.bottom, 20),
          }}
        >
          <View className="flex-row items-center justify-between">
            <TouchableOpacity
              onPress={handleClose}
              disabled={isCropping}
              activeOpacity={0.8}
              className="h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.mediaOverlayStrong }}
            >
              <MaterialIcons name="close" size={22} color={theme.primaryContrast} />
            </TouchableOpacity>
            <View className="items-center">
              <Text className="text-base font-semibold" style={{ color: theme.primaryContrast }}>
                {title}
              </Text>
              <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
                {description}
              </Text>
            </View>
            <View className="h-10 w-10" />
          </View>

          <View className="flex-1 items-center justify-center">
            <View
              className="overflow-hidden rounded-2xl border"
              style={{ width: frameWidth, height: frameHeight, borderColor: theme.borderStrong, backgroundColor: theme.surfaceStrong }}
            >
              <Image
                source={{ uri: asset?.uri }}
                resizeMode="cover"
                style={{
                  width: frameWidth,
                  height: frameHeight,
                }}
              />
              <View className="absolute inset-0 border" style={{ borderColor: theme.border }} pointerEvents="none" />
            </View>
          </View>

          <View className="rounded-3xl px-4 py-4" style={{ backgroundColor: theme.mediaOverlayStrong }}>
            <Text className="text-xs leading-5" style={{ color: theme.textMuted }}>
              {helperText}
            </Text>

            <View className="mt-4 flex-row space-x-2">
              <TouchableOpacity
                onPress={handleClose}
                disabled={isCropping}
                activeOpacity={0.8}
                className="flex-1 rounded-2xl px-4 py-3"
                style={{ backgroundColor: theme.mediaOverlayStrong }}
              >
                <Text className="text-center text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                disabled={isCropping}
                activeOpacity={0.8}
                className="flex-1 rounded-2xl px-4 py-3"
                style={{ backgroundColor: isCropping ? theme.surfaceStrong : theme.primary }}
              >
                <View className="flex-row items-center justify-center space-x-2">
                  {isCropping ? <ActivityIndicator size="small" color={theme.primaryContrast} /> : null}
                  <Text className="text-center text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    {isCropping ? "Preparing" : confirmLabel}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
};

export default BannerCropModal;
