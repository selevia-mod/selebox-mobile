import { MaterialIcons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";

const VideosDownloadQualityModal = ({ showCoinOverlay, downloadQualityPickerVisible, downloadQualityPickerOptions, closeDownloadQualityPicker }) => {
  const { theme } = useAppTheme();
  return (
    <Modal
      isVisible={downloadQualityPickerVisible && !showCoinOverlay}
      onBackdropPress={() => closeDownloadQualityPicker(null)}
      onBackButtonPress={() => closeDownloadQualityPicker(null)}
      swipeDirection="down"
      onSwipeComplete={() => closeDownloadQualityPicker(null)}
      style={{ justifyContent: "flex-end", margin: 0 }}
      backdropOpacity={0.45}
      propagateSwipe
    >
      <View className="rounded-t-3xl px-5 pb-7 pt-4" style={{ borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}>
        <View className="mb-3 h-1.5 w-10 self-center rounded-full" style={{ backgroundColor: theme.handle }} />
        <View className="mb-4 flex-row items-center space-x-3">
          <View className="h-10 w-10 items-center justify-center rounded-2xl" style={{ backgroundColor: theme.accentGreenSoft }}>
            <MaterialIcons name="download" size={20} color={theme.accentGreen} />
          </View>
          <View className="flex-1">
            <Text className="font-sans text-base font-semibold" style={{ color: theme.text }}>
              Download quality
            </Text>
            <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
              Choose the quality for offline video.
            </Text>
          </View>
        </View>

        <View className="space-y-2">
          {downloadQualityPickerOptions.map((quality) => (
            <TouchableOpacity
              key={quality}
              activeOpacity={0.85}
              onPress={() => closeDownloadQualityPicker(quality)}
              className="flex-row items-center justify-between rounded-2xl px-4 py-3"
              style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
            >
              <View className="flex-row items-center space-x-3">
                <View className="h-8 w-8 items-center justify-center rounded-xl" style={{ backgroundColor: theme.surfaceMuted }}>
                  <MaterialIcons name="high-quality" size={16} color={theme.icon} />
                </View>
                <View>
                  <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                    {quality}p
                  </Text>
                  <Text className="font-sans text-[11px]" style={{ color: theme.textSoft }}>
                    {quality >= 720 ? "HD" : quality >= 480 ? "Balanced" : "Data Saver"}
                  </Text>
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={20} color={theme.iconMuted} />
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => closeDownloadQualityPicker(null)}
          className="mt-4 items-center justify-center rounded-2xl px-4 py-3"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
        >
          <Text className="font-sans text-sm font-semibold" style={{ color: theme.textSoft }}>
            Cancel
          </Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
};

export default VideosDownloadQualityModal;
