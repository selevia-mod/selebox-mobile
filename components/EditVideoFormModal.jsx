import { Ionicons } from "@expo/vector-icons";
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
  // YouTube-style free-typing tag composer. `tagInput` holds the
  // in-flight chip text; committed chips live on videoForm.tags. Tags
  // are optional — no SORTED_CATEGORIES picker.
  const [tagInput, setTagInput] = useState("");
  const sizeLimitThumbnailUpload = globalSettings["THUMBNAIL_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["TITLE_LIMIT_SIZE_CHARS"];
  const sizeLimitTags = Number(globalSettings["TAGS_LIMIT_MAX"]) || 10;

  // Free-typing tag helpers — see UploadVideo.jsx for the full doc.
  // Commits whatever is in the composer (split on commas/newlines) as
  // chips, deduped case-insensitively up to sizeLimitTags.
  const addTagFromInput = (rawInput) => {
    const text = String(rawInput ?? tagInput).trim();
    if (!text) return;
    setVideoForm((prev) => {
      const existing = prev.tags || [];
      const existingLower = new Set(existing.map((t) => t.toLowerCase()));
      const candidates = text
        .split(/[,\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const additions = [];
      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        if (existingLower.has(lower)) continue;
        if (existing.length + additions.length >= sizeLimitTags) break;
        existingLower.add(lower);
        additions.push(candidate);
      }
      if (additions.length === 0) return prev;
      return { ...prev, tags: [...existing, ...additions] };
    });
    setTagInput("");
  };

  const handleTagInputChange = (text) => {
    if (text.endsWith(",")) {
      addTagFromInput(text.slice(0, -1));
      return;
    }
    setTagInput(text);
  };

  const handleTagInputKeyPress = ({ nativeEvent }) => {
    if (nativeEvent.key === "Backspace" && tagInput === "" && (videoForm?.tags?.length || 0) > 0) {
      setVideoForm((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  };

  const removeTag = (index) => {
    setVideoForm((prev) => ({
      ...prev,
      tags: (prev.tags || []).filter((_, i) => i !== index),
    }));
  };

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

            {/* Tags — YouTube-style chips. Optional. Press return or
                comma to add; backspace on empty composer removes the
                last chip; tap × on a chip to delete. */}
            <View className="mb-10 mt-6">
              <View className="flex-row items-center justify-between">
                <Text className="mb-2 font-semibold" style={{ color: theme.text }}>
                  Tags
                </Text>
                <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>
                  {`${videoForm?.tags?.length || 0} / ${sizeLimitTags}`}
                </Text>
              </View>
              <Text className="mb-2 text-xs" style={{ color: theme.textSoft }}>
                Optional. Press return or comma to add. Helps people find your video.
              </Text>
              <View
                className="rounded-xl px-2 py-2"
                style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
              >
                <View className="flex flex-row flex-wrap items-center" style={{ gap: 6 }}>
                  {(videoForm?.tags || []).map((tag, index) => (
                    <View
                      key={`${tag}-${index}`}
                      className="flex-row items-center rounded-full pl-3 pr-1.5 py-1"
                      style={{
                        backgroundColor: theme.primary,
                        shadowColor: theme.primary,
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.18,
                        shadowRadius: 4,
                        elevation: 1,
                      }}
                    >
                      <Text
                        className="text-sm font-medium"
                        style={{ color: theme.primaryContrast, letterSpacing: 0.1 }}
                      >
                        {tag}
                      </Text>
                      <TouchableOpacity
                        onPress={() => removeTag(index)}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        className="ml-1 h-5 w-5 items-center justify-center rounded-full"
                        style={{ backgroundColor: "rgba(255,255,255,0.22)" }}
                      >
                        <Ionicons name="close" size={12} color={theme.primaryContrast} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TextInput
                    value={tagInput}
                    onChangeText={handleTagInputChange}
                    onSubmitEditing={() => addTagFromInput()}
                    onKeyPress={handleTagInputKeyPress}
                    onBlur={() => addTagFromInput()}
                    blurOnSubmit={false}
                    returnKeyType="done"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={(videoForm?.tags?.length || 0) < sizeLimitTags}
                    placeholder={(videoForm?.tags?.length || 0) === 0 ? "Add a tag…" : ""}
                    placeholderTextColor={theme.placeholder}
                    className="min-w-[80px] flex-1 px-2 py-1 text-sm"
                    style={{ color: theme.inputText }}
                  />
                </View>
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
