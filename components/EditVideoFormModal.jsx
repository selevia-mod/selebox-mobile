import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";

export default function EditVideoFormModal({ visible, onClose, initialData = {}, onSubmit, globalSettings = {}, allowScheduleEdit = false }) {
  const { theme, isDarkMode } = useAppTheme();
  const [videoForm, setVideoForm] = useState({
    title: "",
    description: "",
    tags: [],
    thumbnail: null,
  });

  const [saving, setSaving] = useState(false);
  const [thumbnailVersion, setThumbnailVersion] = useState(0);
  const [tags] = useState(JSON.parse(globalSettings["SORTED_CATEGORIES"] || "[]"));
  const sizeLimitThumbnailUpload = globalSettings["THUMBNAIL_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["TITLE_LIMIT_SIZE_CHARS"];
  const sizeLimitTags = globalSettings["TAGS_LIMIT_MAX"];

  const [scheduledDate, setScheduledDate] = useState(initialData.scheduled_publish_at);
  const [showPicker, setShowPicker] = useState(false);
  const [tempDate, setTempDate] = useState(initialData.scheduled_publish_at ? new Date(initialData.scheduled_publish_at) : new Date());
  const canEditSchedule = allowScheduleEdit && initialData?.status === "ready";

  useEffect(() => {
    if (visible && initialData) {
      setVideoForm({
        title: initialData.title || "",
        description: initialData.description || "",
        tags: initialData.tags || [],
        thumbnail: initialData.thumbnail,
      });
      setScheduledDate(initialData.scheduled_publish_at || null);
      setTempDate(initialData.scheduled_publish_at ? new Date(initialData.scheduled_publish_at) : new Date());
    }
  }, [visible, initialData?.$id]);

  const changeThumb = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled) {
      const file = res.assets?.[0];
      if (!file) return;
      if (file.fileSize > sizeLimitThumbnailUpload) {
        Alert.alert("Thumbnail too large", "Please select a smaller image.");
        return;
      }
      setVideoForm((prev) => ({ ...prev, thumbnail: file }));
      setThumbnailVersion((prev) => prev + 1);
    }
  };

  const openAndroidDateTimePicker = () => {
    const now = new Date();
    const baseDate = scheduledDate ? new Date(scheduledDate) : now;
    setTempDate(baseDate);

    const openTimePicker = (pickedDate) => {
      DateTimePickerAndroid.open({
        value: pickedDate,
        mode: "time",
        onChange: (event, date) => {
          if (event.type !== "set" || !date) return;
          const finalDate = new Date(pickedDate);
          finalDate.setHours(date.getHours());
          finalDate.setMinutes(date.getMinutes());
          finalDate.setSeconds(0);
          setTempDate(finalDate);
          setScheduledDate(finalDate.toISOString());
        },
      });
    };

    DateTimePickerAndroid.open({
      value: baseDate,
      mode: "date",
      minimumDate: now,
      onChange: (event, date) => {
        if (event.type !== "set" || !date) return;
        const pickedDate = new Date(date);
        openTimePicker(pickedDate);
      },
    });
  };

  const handleOpenDateTimePicker = () => {
    if (!canEditSchedule) return;

    if (Platform.OS === "android") {
      openAndroidDateTimePicker();
    } else {
      setTempDate(scheduledDate ? new Date(scheduledDate) : new Date());
      setShowPicker(true);
    }
  };

  const save = async () => {
    setSaving(true);
    await onSubmit({
      ...videoForm,
      ...(allowScheduleEdit && {
        scheduled_publish_at: scheduledDate,
      }),
    });
    setSaving(false);
  };

  return (
    <>
      <Modal
        isVisible={visible}
        onBackdropPress={onClose}
        onBackButtonPress={onClose}
        swipeDirection="down"
        onSwipeComplete={onClose}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.5}
        propagateSwipe
      >
        <View
          className="h-[80%] rounded-t-2xl p-5"
          style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border }}
        >
          {/* Header */}
          <View className="mb-4 flex-row items-center justify-between">
            <TouchableOpacity onPress={onClose}>
              <Text style={{ color: theme.danger }}>Cancel</Text>
            </TouchableOpacity>
            <Text className="text-lg font-bold" style={{ color: theme.text }}>
              Edit Video
            </Text>

            <TouchableOpacity disabled={saving} onPress={save}>
              {saving ? (
                <LoaderKit style={{ width: 24, height: 24 }} name="BallPulseSync" color={theme.primary} />
              ) : (
                <Text className="font-semibold" style={{ color: theme.accentGreen }}>
                  Save
                </Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView
            className="flex-1"
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 24 }}
          >
            {/* Video Preview (locked; cannot replace) */}
            <Text className="mb-1 text-xs" style={{ color: theme.textSoft }}>
              Video Preview
            </Text>
            <View className="aspect-video overflow-hidden rounded-md" style={{ backgroundColor: theme.mediaOverlayStrong }}>
              <FastImage source={{ uri: initialData.videoUrl }} className="h-full w-full" pointerEvents="none" />
            </View>

            {/* Thumbnail */}
            <View className="mt-5">
              <Text className="mb-2 font-semibold" style={{ color: theme.text }}>
                Thumbnail
              </Text>
              <View className="aspect-video overflow-hidden rounded-md" style={{ backgroundColor: theme.mediaOverlay }}>
                <FastImage
                  key={`${videoForm.thumbnail?.uri || initialData.thumbnail || "thumbnail"}-${thumbnailVersion}`}
                  source={{ uri: videoForm.thumbnail?.uri || initialData.thumbnail }}
                  className="h-full w-full"
                  pointerEvents="none"
                />
              </View>
              <TouchableOpacity onPress={changeThumb} className="mt-2 rounded-md p-2" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className="text-center font-medium" style={{ color: theme.text }}>
                  Change Thumbnail
                </Text>
              </TouchableOpacity>
            </View>

            {/* Title */}
            <View className="mt-6">
              <View className="flex-row items-center justify-between">
                <Text className="mb-1 font-semibold" style={{ color: theme.text }}>
                  Title
                </Text>
                <Text
                  className="text-[10px] font-medium"
                  style={{ color: theme.textSoft }}
                >{`${videoForm.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
              </View>
              <TextInput
                className="rounded-md p-3"
                style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
                value={videoForm.title}
                onChangeText={(t) => setVideoForm((p) => ({ ...p, title: t }))}
                maxLength={Number(sizeLimitTitleChars)}
                multiline
                submitBehavior="blurAndSubmit"
                returnKeyType="done"
                placeholderTextColor={theme.placeholder}
                selectionColor={theme.primary}
              />
            </View>

            {/* Description */}
            <View className="mt-6">
              <Text className="mb-1 font-semibold" style={{ color: theme.text }}>
                Description
              </Text>
              <TextInput
                multiline
                className="h-24 rounded-md p-3"
                style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
                value={videoForm.description}
                onChangeText={(t) => setVideoForm((p) => ({ ...p, description: t }))}
                placeholderTextColor={theme.placeholder}
                selectionColor={theme.primary}
              />
            </View>

            {/* Tags */}
            <View className="mb-10 mt-6">
              <View className="flex-row items-center justify-between">
                <Text className="mb-2 font-semibold" style={{ color: theme.text }}>
                  Tags
                </Text>
                <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitTags}`}</Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                {tags.map((tag) => {
                  const isSelected = videoForm.tags.includes(tag);
                  const isDisabled = !isSelected && videoForm.tags.length >= sizeLimitTags;
                  return (
                    <TouchableOpacity
                      key={tag}
                      onPress={() => setVideoForm((p) => ({ ...p, tags: p.tags.includes(tag) ? p.tags.filter((t) => t !== tag) : [...p.tags, tag] }))}
                      className="rounded-full px-4 py-2"
                      disabled={isDisabled}
                      style={{ backgroundColor: isSelected ? theme.primary : theme.surfaceStrong, opacity: isDisabled ? 0.35 : 1 }}
                    >
                      <Text style={{ color: isSelected ? theme.primaryContrast : theme.text }}>{tag}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {allowScheduleEdit && (
              <View className="mt-6">
                <Text className="mb-1 font-semibold" style={{ color: theme.text }}>
                  Scheduled Publish
                </Text>

                <View className="rounded-md p-3" style={{ backgroundColor: theme.surfaceMuted }}>
                  <Text style={{ color: theme.text }}>
                    {scheduledDate ? `Scheduled for: ${new Date(scheduledDate).toLocaleString()}` : "No schedule set"}
                  </Text>

                  <TouchableOpacity
                    disabled={!canEditSchedule}
                    onPress={handleOpenDateTimePicker}
                    className="mt-2 rounded-md p-2"
                    style={{ backgroundColor: canEditSchedule ? theme.accentGreen : theme.surfaceStrong }}
                  >
                    <Text className="text-center font-semibold" style={{ color: theme.primaryContrast }}>
                      Change Schedule
                    </Text>
                  </TouchableOpacity>
                  {!canEditSchedule && (
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      Publish date can be edited when status is Ready.
                    </Text>
                  )}
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {allowScheduleEdit && Platform.OS === "ios" && (
        <Modal
          isVisible={showPicker}
          onBackdropPress={() => setShowPicker(false)}
          onBackButtonPress={() => setShowPicker(false)}
          swipeDirection="down"
          onSwipeComplete={() => setShowPicker(false)}
          style={{ justifyContent: "flex-end", margin: 0 }}
          backdropOpacity={0.5}
          propagateSwipe
        >
          <View className="rounded-t-2xl p-4" style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border }}>
            <Text className="mb-3 text-center text-lg font-semibold" style={{ color: theme.text }}>
              Select New Schedule
            </Text>

            <DateTimePicker
              value={tempDate}
              themeVariant={isDarkMode ? "dark" : "light"}
              mode="datetime"
              display="spinner"
              minimumDate={new Date()}
              onChange={(e, date) => {
                if (e.type === "set" && date) {
                  setTempDate(date);
                }
              }}
            />

            <View className="mt-4 flex-row gap-3">
              <TouchableOpacity
                className="flex-1 rounded-md py-3"
                style={{ backgroundColor: theme.surfaceStrong }}
                onPress={() => setShowPicker(false)}
              >
                <Text className="text-center" style={{ color: theme.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="flex-1 rounded-md py-3"
                style={{ backgroundColor: theme.accentGreen }}
                onPress={() => {
                  setScheduledDate(tempDate.toISOString());
                  setShowPicker(false);
                }}
              >
                <Text className="text-center" style={{ color: theme.primaryContrast }}>
                  Confirm
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}
