// Bottom-sheet quality picker shown when a user taps Download from the video
// player. Visual language matches the rest of the offline-download flow: a
// violet primary chip header with shadow lift, premium quality option rows
// stamped with a small "HQ" / "BALANCED" / "DATA SAVER" tag, and a Cancel
// pill anchored at the bottom. Avoids the old green "download" tint so the
// whole download surface (Videos > Downloads tab, the in-player confirmation
// modal, and this picker) reads as one violet system.

import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";

const qualityMeta = (quality) => {
  if (quality >= 1080) return { tag: "ULTRA HD", subtitle: "Crispest visuals · larger file", icon: "high-quality" };
  if (quality >= 720) return { tag: "HD", subtitle: "Sharp playback · medium file", icon: "high-quality" };
  if (quality >= 480) return { tag: "BALANCED", subtitle: "Good quality · smaller file", icon: "hd" };
  return { tag: "DATA SAVER", subtitle: "Smallest file · for slow networks", icon: "sd" };
};

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
      backdropOpacity={0.55}
      useNativeDriver
      propagateSwipe
    >
      <View
        className="rounded-t-3xl px-5 pb-7 pt-4"
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.border,
          backgroundColor: theme.surfaceElevated,
        }}
      >
        <View className="mb-3 h-1.5 w-10 self-center rounded-full" style={{ backgroundColor: theme.handle }} />

        {/* Header — violet primary chip with shadow lift, uppercase letter-spaced
            label, and a soft subtitle. Mirrors the section headers used on the
            Downloads tab and the unlock modal. */}
        <View className="mb-4 flex-row items-center">
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
              marginRight: 12,
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.35,
              shadowRadius: 8,
              elevation: 3,
            }}
          >
            <MaterialCommunityIcons name="cloud-download-outline" size={20} color={theme.primary} />
          </View>
          <View className="flex-1">
            <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.4, textTransform: "uppercase" }}>
              Download quality
            </Text>
            <Text className="mt-0.5" style={{ color: theme.textSoft, fontSize: 12, lineHeight: 16 }}>
              Choose the quality for offline playback.
            </Text>
          </View>
        </View>

        {/* Quality option rows — each row carries a small violet HQ-style tag
            chip, a tappable chevron, and a soft hairline border. Tap target
            spans the full row for one-thumb reach. */}
        <View style={{ gap: 8 }}>
          {downloadQualityPickerOptions.map((quality) => {
            const meta = qualityMeta(quality);
            return (
              <TouchableOpacity
                key={quality}
                activeOpacity={0.85}
                onPress={() => closeDownloadQualityPicker(quality)}
                className="flex-row items-center justify-between rounded-2xl px-4 py-3"
                style={{
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: theme.card,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.06,
                  shadowRadius: 6,
                  elevation: 1,
                }}
              >
                <View className="flex-row items-center" style={{ gap: 12 }}>
                  <View
                    className="items-center justify-center rounded-xl"
                    style={{
                      height: 36,
                      width: 36,
                      backgroundColor: theme.primarySoft,
                      borderWidth: 1,
                      borderColor: theme.primary,
                    }}
                  >
                    <MaterialIcons name={meta.icon} size={18} color={theme.primary} />
                  </View>
                  <View>
                    <View className="flex-row items-center" style={{ gap: 8 }}>
                      <Text className="font-psemibold" style={{ color: theme.text, fontSize: 15, letterSpacing: 0.2 }}>
                        {quality}p
                      </Text>
                      <View
                        className="rounded-full"
                        style={{
                          paddingHorizontal: 6,
                          paddingVertical: 1,
                          backgroundColor: theme.primarySoft,
                          borderWidth: 0.5,
                          borderColor: theme.primary,
                        }}
                      >
                        <Text style={{ color: theme.primary, fontSize: 9, fontWeight: "700", letterSpacing: 0.4 }}>{meta.tag}</Text>
                      </View>
                    </View>
                    <Text className="mt-0.5" style={{ color: theme.textSoft, fontSize: 11, letterSpacing: 0.1 }}>
                      {meta.subtitle}
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.iconMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Cancel pill — soft hairline, neutral muted text. Matches the
            ProfileActionsMenu / Post actions bottom sheet patterns. */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => closeDownloadQualityPicker(null)}
          className="mt-4 items-center justify-center rounded-2xl px-4 py-3"
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surfaceMuted,
          }}
        >
          <Text className="font-psemibold" style={{ color: theme.textSoft, fontSize: 13, letterSpacing: 0.2 }}>
            Cancel
          </Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
};

export default VideosDownloadQualityModal;
