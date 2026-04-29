import { FontAwesome } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useRef, useState } from "react";
import { Alert, Platform, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";

import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";

import { ID } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { UploadVideoToBunnyStorage } from "../lib/fetch-bunny-storage";
import { createNewVideo, initialVideoForm, VideosService } from "../lib/video";
import secrets from "../private/secrets";

const UploadVideo = ({ showMessage }) => {
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const [formLoading, setFormLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState("idle"); // idle | preparing | uploading | processing | completed | failed
  const [videoForm, setVideoForm] = useState(initialVideoForm);
  const [videoLoading, setVideoLoading] = useState(false);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);

  const [publishNow, setPublishNow] = useState(true);
  const [monetizationEnabled, setMonetizationEnabled] = useState(false);
  const [isMonetizationEligible, setIsMonetizationEligible] = useState(true);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(null);

  const [scheduledDate, setScheduledDate] = useState(null);
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [tempDate, setTempDate] = useState(new Date());

  const videosService = new VideosService();
  const uploadAbortRef = useRef(null);
  const sizeLimitVideoUpload = globalSettings["VIDEO_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitThumbnailUpload = globalSettings["THUMBNAIL_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["TITLE_LIMIT_SIZE_CHARS"];
  const sizeLimitTags = globalSettings["TAGS_LIMIT_MAX"];
  const tags = JSON.parse(globalSettings["SORTED_CATEGORIES"]);
  const MIN_MONETIZATION_DURATION_SECONDS = 180;

  const handlePublish = async () => {
    try {
      if (handleValidateData()) return;
      setFormLoading(true);
      setProgress(0);
      setUploadStage("preparing");

      const videoID = ID.unique();
      const abortController = new AbortController();
      uploadAbortRef.current = abortController;

      const responseThumbnail = await UploadVideoToBunnyStorage(`${videoID}/${videoID}.jpg`, videoForm.thumbnail);
      if (!responseThumbnail) {
        setUploadStage("failed");
        showMessage("Thumbnail upload failed. Please try again.", 500);
        setFormLoading(false);
        return;
      }

      setProgress(10);
      setUploadStage("uploading");

      const responseVideo = await videosService.uploadVideoToBunnyStream(videoID, videoForm.videoUrl, {
        onProgress: (pct) => setProgress(Math.max(10, Math.min(95, pct))),
        signal: abortController.signal,
      });

      if (!responseVideo?.status) {
        setUploadStage("failed");
        setFormLoading(false);
        if (responseVideo?.cancelled) {
          showMessage("Upload cancelled.", 500);
        } else {
          showMessage("Your video upload was unsuccessful :(", 500);
        }
        return;
      }

      setUploadStage("processing");
      setProgress((prev) => Math.max(prev, 96));

      await createNewVideo({
        ...videoForm,
        ID: videoID,
        thumbnail: `${secrets.BUNNY_VIDEOS_STORAGE_CDN_HOSTNAME}/${videoID}/${videoID}.jpg`,
        videoUrl: `${secrets.BUNNY_STREAM_VIDEOS_CDN_HOSTNAME}/${responseVideo.videoId}/playlist.m3u8`,
        uri: `/videos/${videoID}`,
        uploader: user.$id,
        status: "processing",
        monetization_enabled: isMonetizationEligible ? monetizationEnabled : false,
        scheduled_publish_at: publishNow ? null : scheduledDate,
      });

      setProgress(100);
      setUploadStage("completed");

      setFormLoading(false);
      resetFormState();
      showMessage("Your video has been uploaded successfully!", 500);
    } catch (error) {
      setUploadStage("failed");
      setFormLoading(false);
      showMessage("Your video upload was unsuccessful :(", 500);
      console.error(error);
    } finally {
      uploadAbortRef.current = null;
    }
  };

  const resetFormState = () => {
    setVideoForm(initialVideoForm);
    setMonetizationEnabled(false);
    setIsMonetizationEligible(true);
    setVideoDurationSeconds(null);
    setPublishNow(true);
    setScheduledDate(null);
    setTempDate(new Date());
    setUploadStage("idle");
    setProgress(0);
  };

  const handleCancelUpload = () => {
    if (!uploadAbortRef.current?.abort) return;
    Alert.alert(
      "Cancel upload?",
      "This will stop the current upload. You can restart it after this.",
      [
        { text: "Continue uploading", style: "cancel" },
        {
          text: "Cancel upload",
          style: "destructive",
          onPress: () => {
            uploadAbortRef.current.abort();
            showMessage("Cancelling upload...", 500);
          },
        },
      ],
      { cancelable: true },
    );
  };

  const handleValidateData = () => {
    if (!videoForm?.thumbnail || !videoForm?.videoUrl) {
      showMessage("Either your thumbnail or your video is empty.");
      return true;
    }

    if (!videoForm?.title?.length) {
      showMessage("Please enter a title.");
      return true;
    }

    if (videoForm?.title?.length > sizeLimitTitleChars) {
      showMessage(`Please ensure your title char size is under ${sizeLimitTitleChars}.`);
      return true;
    }

    if (!videoForm?.tags?.length) {
      showMessage("Please select at least 1 tag.");
      return true;
    }

    if (videoForm?.tags?.length > sizeLimitTags) {
      showMessage(`Please ensure your total tags is under ${sizeLimitTags}.`);
      return true;
    }
    return false;
  };

  const handleChange = (key, value) => {
    if (key === "title" || key === "description") {
      setVideoForm((prev) => ({ ...prev, [key]: value }));
    } else if (key === "tags") {
      setVideoForm((prev) => {
        const updatedTags = prev.tags.includes(value) ? prev.tags.filter((t) => t !== value) : [...prev.tags, value];
        return { ...prev, tags: updatedTags };
      });
    }
  };

  const handleGenerateThumbnail = async (videoUri) => {
    try {
      setThumbnailLoading(true);
      const result = await VideoThumbnails.getThumbnailAsync(videoUri, { time: 3000 });
      setVideoForm((prev) => ({ ...prev, thumbnail: result }));
    } catch (e) {
      console.warn(e);
      showMessage("Failed to generate thumbnail.", 500);
    } finally {
      setThumbnailLoading(false);
    }
  };

  const handleThumbnail = (thumbnail) => {
    if (thumbnail && thumbnail.fileSize > sizeLimitThumbnailUpload) {
      showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
      return;
    }
    setVideoForm((prev) => ({ ...prev, thumbnail }));
  };

  const convertDurationToSeconds = (duration) => {
    if (typeof duration !== "number") return null;
    return duration > 10000 ? duration / 1000 : duration;
  };

  const updateMonetizationEligibility = (durationInSeconds) => {
    if (durationInSeconds === null) {
      setIsMonetizationEligible(true);
      setVideoDurationSeconds(null);
      return;
    }

    const eligible = durationInSeconds >= MIN_MONETIZATION_DURATION_SECONDS;
    setIsMonetizationEligible(eligible);
    setVideoDurationSeconds(durationInSeconds);

    if (!eligible) {
      setMonetizationEnabled(false);
      showMessage("Monetization disabled: videos must be at least 3 minutes long.", 500);
    }
  };

  const handleVideo = (video) => {
    if (video && video.fileSize > sizeLimitVideoUpload) {
      showMessage(`Please ensure your video upload size is under ${sizeLimitVideoUpload / 1024 / 1024}MB.`, 500);
      return;
    }

    const durationInSeconds = convertDurationToSeconds(video?.duration);
    updateMonetizationEligibility(durationInSeconds);
    setVideoForm((prev) => ({ ...prev, videoUrl: video }));
    handleGenerateThumbnail(video.uri);
  };

  const openPicker = async (mediaType) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    try {
      if (mediaType === "videos") setVideoLoading(true);

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: mediaType,
      });

      if (!result.canceled) {
        const asset = result.assets[0];
        if (mediaType === "images") handleThumbnail(asset);
        if (mediaType === "videos") handleVideo(asset);
      }
    } finally {
      if (mediaType === "videos") setVideoLoading(false);
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
    if (Platform.OS === "android") {
      openAndroidDateTimePicker();
    } else {
      setTempDate(scheduledDate ? new Date(scheduledDate) : new Date());
      setShowPickerModal(true);
    }
  };

  const uploadStageLabel =
    {
      preparing: "Preparing upload...",
      uploading: "Uploading video...",
      processing: "Finalizing upload...",
      completed: "Upload complete",
      failed: "Upload failed",
      idle: "Publishing video",
    }[uploadStage] || "Publishing video";

  const canCancelUpload = uploadStage === "preparing" || uploadStage === "uploading";

  return (
    <View className="mx-auto h-full w-full px-4 pb-8">
      {/* Video */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
            Video
          </Text>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitVideoUpload / 1024 / 1024}MB`}</Text>
        </View>
        <TouchableOpacity className="mt-3" onPress={() => openPicker("videos")}>
          <View
            className={`aspect-video w-full items-center justify-center rounded-xl border ${videoForm?.videoUrl ? "" : "border-dashed"}`}
            style={{
              borderColor: videoForm?.videoUrl ? theme.accentGreen : theme.borderStrong,
              backgroundColor: videoForm?.videoUrl ? theme.accentGreenSoft : theme.surfaceMuted,
            }}
          >
            {videoLoading ? (
              <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primary} />
            ) : (
              <FontAwesome
                name={videoForm?.videoUrl ? "check-circle" : "video-camera"}
                size={72}
                color={videoForm?.videoUrl ? theme.accentGreen : theme.iconMuted}
              />
            )}
          </View>
        </TouchableOpacity>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          Tap to select a video from your library.
        </Text>
      </View>

      {/* Thumbnail */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
            Thumbnail
          </Text>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitThumbnailUpload / 1024 / 1024}MB`}</Text>
        </View>
        <TouchableOpacity className="mt-3" onPress={() => openPicker("images")}>
          <View
            className="aspect-video w-full items-center justify-center rounded-xl border border-dashed"
            style={{ borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
          >
            {thumbnailLoading ? (
              <LoaderKit style={{ width: 50, height: 50 }} name="LineScale" color={theme.primary} />
            ) : videoForm?.thumbnail ? (
              <View className="aspect-video w-full items-center justify-center rounded-xl" style={{ backgroundColor: theme.surface }}>
                <FastImage
                  className="h-full w-full rounded-xl"
                  source={{ uri: videoForm?.thumbnail?.uri, priority: FastImage.priority.high }}
                  resizeMode={FastImage.resizeMode.contain} // ⚠️ Important
                />
              </View>
            ) : (
              <FontAwesome name="image" size={72} color={theme.iconMuted} />
            )}
          </View>
        </TouchableOpacity>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          We will auto-generate a thumbnail, or you can upload your own.
        </Text>
      </View>

      {/* Title */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
            Title
          </Text>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`${videoForm?.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
        </View>
        <TextInput
          value={videoForm?.title}
          onChangeText={(text) => handleChange("title", text)}
          placeholder="Your video's title"
          placeholderTextColor={theme.placeholder}
          className="mt-3 w-full rounded-xl p-3 text-[14px]"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground, color: theme.inputText }}
          maxLength={Number(sizeLimitTitleChars)}
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
        />
      </View>

      {/* Description */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
            Description
          </Text>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>
            Optional
          </Text>
        </View>
        <TextInput
          value={videoForm.description}
          onChangeText={(text) => handleChange("description", text)}
          multiline
          textAlignVertical="top"
          placeholder="Your video's description"
          placeholderTextColor={theme.placeholder}
          className="mt-3 h-[150px] w-full justify-start rounded-xl p-3 text-[14px]"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground, color: theme.inputText }}
        />
      </View>

      {/* Tags */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
            Tags
          </Text>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitTags}`}</Text>
        </View>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          Select at least 1 tag.
        </Text>
        <View className="flex flex-row flex-wrap gap-2 pt-3">
          {tags.map((tag, index) => {
            const isSelected = videoForm?.tags?.includes(tag);
            const isDisabled = !isSelected && videoForm?.tags?.length >= sizeLimitTags;
            return (
              <TouchableOpacity
                onPress={() => handleChange("tags", tag)}
                className="h-fit w-fit rounded-full px-4 py-2"
                key={index.toString()}
                disabled={isDisabled}
                style={{
                  opacity: isDisabled ? 0.35 : 1,
                  backgroundColor: isSelected ? theme.primary : theme.surfaceMuted,
                }}
              >
                <Text className="text-nowrap text-sm font-medium" style={{ color: isSelected ? theme.primaryContrast : theme.text }}>
                  {tag}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Publish Settings */}
      <View className="mb-6 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
          Publish Settings
        </Text>
        <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
          Choose how your video goes live.
        </Text>

        {/* Radio Options */}
        <View className="mt-4 space-y-3">
          {/* Publish Now */}
          <TouchableOpacity
            onPress={() => {
              setPublishNow(true);
              setScheduledDate(null);
            }}
            className="flex-row items-center justify-center rounded-full px-4 py-2.5"
            style={{ backgroundColor: publishNow ? theme.accentGreen : theme.surfaceMuted }}
          >
            <Text className="font-medium" style={{ color: publishNow ? theme.primaryContrast : theme.textMuted }}>
              Publish Now
            </Text>
          </TouchableOpacity>

          {/* Schedule Publish */}
          <TouchableOpacity
            onPress={() => {
              setPublishNow(false);
              handleOpenDateTimePicker();
            }}
            className="flex-row items-center justify-center rounded-full px-4 py-2.5"
            style={{ backgroundColor: !publishNow ? theme.accentGreen : theme.surfaceMuted }}
          >
            <Text className="font-medium" style={{ color: !publishNow ? theme.primaryContrast : theme.textMuted }}>
              Schedule Publish
            </Text>
          </TouchableOpacity>
        </View>

        {/* Show Scheduled Date */}
        {!publishNow && (
          <View className="mt-4 rounded-xl p-3" style={{ backgroundColor: theme.surfaceMuted }}>
            <Text className="font-medium" style={{ color: theme.text }}>
              {scheduledDate ? `Scheduled for: ${new Date(scheduledDate).toLocaleString()}` : "No schedule selected yet"}
            </Text>

            <TouchableOpacity className="mt-3 rounded-xl px-3 py-2.5" style={{ backgroundColor: theme.accentGreen }} onPress={handleOpenDateTimePicker}>
              <Text className="text-center font-semibold" style={{ color: theme.primaryContrast }}>
                {scheduledDate ? "Change Schedule" : "Select Date & Time"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Date-Time Picker Modal */}
        <Modal
          isVisible={Platform.OS === "ios" && showPickerModal}
          onBackdropPress={() => setShowPickerModal(false)}
          backdropOpacity={0.45}
          style={{ justifyContent: "flex-end", margin: 0 }}
        >
          <View className="rounded-t-3xl p-4" style={{ backgroundColor: theme.surfaceElevated }}>
            <Text className="mb-3 text-center text-base font-semibold" style={{ color: theme.text }}>
              Select Date & Time
            </Text>

            <DateTimePicker
              value={scheduledDate ? new Date(scheduledDate) : tempDate}
              mode="datetime"
              display="spinner"
              themeVariant={theme.isDark ? "dark" : "light"}
              minimumDate={new Date()}
              onChange={(event, date) => {
                if (event.type === "set" && date) {
                  setTempDate(date);
                }
              }}
            />

            <View className="mt-4 flex-row gap-3">
              <TouchableOpacity
                className="flex-1 rounded-xl py-3"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={() => {
                  setTempDate(scheduledDate ? new Date(scheduledDate) : new Date());
                  setShowPickerModal(false);
                }}
              >
                <Text className="text-center font-medium" style={{ color: theme.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="flex-1 rounded-xl py-3"
                style={{ backgroundColor: theme.accentGreen }}
                onPress={() => {
                  setScheduledDate(tempDate.toISOString());
                  setShowPickerModal(false);
                }}
              >
                <Text className="text-center font-medium" style={{ color: theme.primaryContrast }}>
                  Confirm
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Monetization */}
        <View className="mt-4 flex-row items-start justify-between rounded-xl px-3 py-3">
          <View className="flex-1 pr-3">
            <Text className="font-medium" style={{ color: theme.text }}>
              Enable Monetization
            </Text>
            <Text className="text-xs" style={{ color: theme.textSoft }}>
              Monetization is available for videos longer than 3 minutes.
            </Text>
          </View>
          <Switch
            value={monetizationEnabled}
            disabled={!isMonetizationEligible}
            onValueChange={(value) => setMonetizationEnabled(isMonetizationEligible ? value : false)}
          />
        </View>
      </View>

      <TouchableOpacity
        onPress={handlePublish}
        className="mt-2 flex w-full flex-row items-center justify-center rounded-full px-4 py-3"
        style={{ backgroundColor: theme.accentGreen }}
      >
        <FontAwesome name="cloud-upload" size={24} color={theme.primaryContrast} />
        <Text className="ml-2 text-[14px] font-semibold" style={{ color: theme.primaryContrast }}>
          Publish
        </Text>
      </TouchableOpacity>

      <Modal
        isVisible={formLoading}
        backdropOpacity={0.5}
        animationIn="fadeIn"
        animationOut="fadeOut"
        backdropTransitionOutTiming={0}
        style={{ margin: 0, justifyContent: "center", alignItems: "center" }}
      >
        <View className="relative h-full w-full items-center justify-center">
          <View
            className="relative mx-5 flex w-full max-w-[320px] flex-col items-center justify-center rounded-3xl p-6"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
          >
            {/* Loading Spinner */}
            <LoaderKit style={{ width: 75, height: 75, opacity: 1 }} name={"LineScalePulseOutRapid"} color={theme.primary} />
            <Text className="my-2 text-lg font-semibold" style={{ color: theme.text }}>
              {uploadStageLabel}
            </Text>
            <Text className="mb-2 text-sm font-medium" style={{ color: theme.textMuted }}>
              {Math.round(progress)}%
            </Text>
            {/* Progress Bar */}
            <View className="h-2 w-full rounded-full" style={{ backgroundColor: theme.surfaceStrong }}>
              <View className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: theme.accentGreen }} />
            </View>
            {canCancelUpload && (
              <TouchableOpacity className="mt-4 w-full rounded-full py-2" style={{ backgroundColor: theme.danger }} onPress={handleCancelUpload} activeOpacity={0.8}>
                <Text className="text-center font-semibold" style={{ color: theme.primaryContrast }}>
                  Cancel Upload
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default UploadVideo;
