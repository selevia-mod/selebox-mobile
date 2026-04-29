import { MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Switch, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDispatch, useSelector } from "react-redux";
import { StyledSafeAreaView, StyledTitle } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { cancelVideoOfflineDownload, clearAllDownloadedVideoFiles } from "../../lib/video-downloads";
import { clearVideoDownloads, downloadQuality, setDownloadSettings } from "../../store/reducers/videos";

const DownloadSettings = () => {
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const insets = useSafeAreaInsets();
  const { downloadSettings, videoDownloads } = useSelector((state) => state.videos);
  const [qualitySettingsVisible, setQualitySettingsVisible] = useState(false);

  const handleChangeSettings = (settings, value) => {
    dispatch(setDownloadSettings({ settings: settings, value: value }));
  };

  const handleDeleteDownloads = async () => {
    try {
      await Promise.all((videoDownloads || []).map((entry) => (entry?.id ? cancelVideoOfflineDownload(entry.id) : Promise.resolve(false))));
      await clearAllDownloadedVideoFiles(videoDownloads || []);
    } catch (error) {
      console.log("handleDeleteDownloads error", error);
    } finally {
      dispatch(clearVideoDownloads());
    }
  };

  const onDeletePress = () => {
    Alert.alert("Warning", "Delete all downloaded videos?", [
      { text: "Cancel", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => handleDeleteDownloads() },
    ]);
  };

  const isSelected = (selectedValue) => {
    if (selectedValue === downloadSettings.quality) return <MaterialIcons name="check" color={theme.primary} size={25} />;
    else return null;
  };

  return (
    <>
      <StyledSafeAreaView>
        <View className="h-full w-full">
          {/* Header — matches profile.jsx pattern */}
          <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
            <TouchableOpacity
              activeOpacity={0.7}
              className="h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
              onPress={() => router.back()}
            >
              <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
            </TouchableOpacity>
            <View className="flex-row items-center space-x-2">
              <StyledTitle className="py-0" icon={<MaterialIcons name="download" size={22} color={theme.icon} />} title={"Download Settings"} />
            </View>
            <View className="h-10 w-10" />
          </View>
          <Text className="mx-3 mb-3 text-xs font-semibold" style={{ color: theme.textSoft }}>
            Update your download preferences.
          </Text>
          <View className="mx-3 mb-4 rounded-2xl px-3 py-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
            <View className="flex-row items-center justify-between py-3" style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
              <Text className="text-sm font-sans font-semibold" style={{ color: theme.text }}>
                Download quality
              </Text>
              <TouchableOpacity onPress={() => setQualitySettingsVisible(true)}>
                <Text className="text-[11px]" style={{ color: theme.textSoft }}>
                  {downloadSettings.quality}
                </Text>
              </TouchableOpacity>
            </View>
            <View className="flex-row items-center justify-between py-3" style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
              <Text className="text-sm font-sans font-semibold" style={{ color: theme.text }}>
                Download over Wi-Fi only
              </Text>
              <Switch
                value={downloadSettings.wifiOnly}
                onValueChange={(val) => handleChangeSettings("wifiOnly", val)}
                trackColor={{ false: theme.surfaceStrong, true: theme.primary }}
                thumbColor={downloadSettings.wifiOnly ? theme.primaryContrast : theme.surfaceElevated}
                ios_backgroundColor={theme.surfaceStrong}
              />
            </View>
            <TouchableOpacity onPress={onDeletePress} className="py-3">
              <Text className="text-sm font-sans font-semibold" style={{ color: theme.text }}>
                Delete downloads
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </StyledSafeAreaView>
      <Modal
        isVisible={qualitySettingsVisible}
        onBackdropPress={() => setQualitySettingsVisible(false)}
        onBackButtonPress={() => setQualitySettingsVisible(false)}
        swipeDirection="down"
        onSwipeComplete={() => setQualitySettingsVisible(false)}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.4}
        propagateSwipe
      >
        <View
          className="w-full rounded-t-3xl px-6 pb-8 pt-4"
          style={{ paddingBottom: insets.bottom, backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border }}
        >
          <View className="mb-3 h-1.5 w-10 self-center rounded-full" style={{ backgroundColor: theme.handle }} />
          <Text className="mb-5 px-6 text-center text-lg font-bold" style={{ color: theme.text }} numberOfLines={2}>
            Download Quality
          </Text>
          <View className="gap-5">
            <TouchableOpacity
              className="flex-row items-center justify-between py-2"
              onPress={() => handleChangeSettings("quality", downloadQuality.askEachTime)}
            >
              <Text className="text-md font-medium font-sans" style={{ color: theme.text }}>
                {downloadQuality.askEachTime}
              </Text>
              {isSelected(downloadQuality.askEachTime)}
            </TouchableOpacity>
            <TouchableOpacity
              className="flex-row items-center justify-between py-2"
              onPress={() => handleChangeSettings("quality", downloadQuality.hd720p)}
            >
              <Text className="text-md font-medium font-sans" style={{ color: theme.text }}>
                {downloadQuality.hd720p}
              </Text>
              {isSelected(downloadQuality.hd720p)}
            </TouchableOpacity>
            <TouchableOpacity
              className="flex-row items-center justify-between py-2"
              onPress={() => handleChangeSettings("quality", downloadQuality.std480p)}
            >
              <Text className="text-md font-medium font-sans" style={{ color: theme.text }}>
                {downloadQuality.std480p}
              </Text>
              {isSelected(downloadQuality.std480p)}
            </TouchableOpacity>
            <TouchableOpacity
              className="flex-row items-center justify-between py-2"
              onPress={() => handleChangeSettings("quality", downloadQuality.dataSaver360p)}
            >
              <Text className="text-md font-medium font-sans" style={{ color: theme.text }}>
                {downloadQuality.dataSaver360p}
              </Text>
              {isSelected(downloadQuality.dataSaver360p)}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
};

export default DownloadSettings;
