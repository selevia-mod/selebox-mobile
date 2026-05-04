import { FontAwesome, Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useRef, useState } from "react";
import { Alert, Platform, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";

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
import SectionDot from "./SectionDot";

const UploadVideo = ({ showMessage }) => {
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const [formLoading, setFormLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState("idle"); // idle | preparing | uploading | processing | completed | failed
  const [videoForm, setVideoForm] = useState(initialVideoForm);
  const [videoLoading, setVideoLoading] = useState(false);

  const [publishNow, setPublishNow] = useState(true);
  const [monetizationEnabled, setMonetizationEnabled] = useState(false);
  const [isMonetizationEligible, setIsMonetizationEligible] = useState(true);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(null);

  // YouTube-style thumbnail picker. After the user picks a video we extract
  // three frames (25%/50%/75% of duration) and present them alongside an
  // "Upload your own" tile. `selectedThumbnailKey` tracks which tile is the
  // currently chosen thumbnail; the actual data still flows through
  // `videoForm.thumbnail` for the upload pipeline.
  //   - selectedThumbnailKey: "upload" | "gen-0" | "gen-1" | "gen-2" | null
  //   - generatedThumbnails: up to 3 entries of { uri, width, height }
  const [generatedThumbnails, setGeneratedThumbnails] = useState([]);
  const [selectedThumbnailKey, setSelectedThumbnailKey] = useState(null);
  const [generatingThumbnails, setGeneratingThumbnails] = useState(false);

  const [scheduledDate, setScheduledDate] = useState(null);
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [tempDate, setTempDate] = useState(new Date());

  const videosService = new VideosService();
  const uploadAbortRef = useRef(null);
  const sizeLimitVideoUpload = globalSettings["VIDEO_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitThumbnailUpload = globalSettings["THUMBNAIL_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["TITLE_LIMIT_SIZE_CHARS"];
  const sizeLimitTags = Number(globalSettings["TAGS_LIMIT_MAX"]) || 10;
  // Free-typing tags (YouTube-style). Holds the in-flight composer text;
  // committed tags live on videoForm.tags as before. Tags are now
  // optional — no SORTED_CATEGORIES picker.
  const [tagInput, setTagInput] = useState("");
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
    setGeneratedThumbnails([]);
    setSelectedThumbnailKey(null);
    setGeneratingThumbnails(false);
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

    // Tags are now optional — only enforce the upper bound.
    if (videoForm?.tags?.length > sizeLimitTags) {
      showMessage(`Please ensure your total tags is under ${sizeLimitTags}.`);
      return true;
    }
    return false;
  };

  const handleChange = (key, value) => {
    if (key === "title" || key === "description") {
      setVideoForm((prev) => ({ ...prev, [key]: value }));
    }
  };

  // Free-typing tag helpers. `addTagFromInput` commits whatever's in
  // `tagInput` (split on commas/whitespace) as one or more tag chips.
  // De-dupes case-insensitively but preserves the first-seen casing on
  // display. `removeTag` drops a chip by index.
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
    // Auto-commit when the user types a comma — matches YouTube's
    // "press , to add" behavior. We don't auto-commit on space because
    // multi-word tags like "true crime" are common.
    if (text.endsWith(",")) {
      addTagFromInput(text.slice(0, -1));
      return;
    }
    setTagInput(text);
  };

  const handleTagInputKeyPress = ({ nativeEvent }) => {
    // Backspace on empty input removes the last chip — same affordance
    // YouTube ships. Without this users have to tap the chip's × to
    // delete, which is a slower flow on mobile.
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

  // YouTube-style: extract 3 frames at 25%/50%/75% of the video. Default-selects
  // the middle (50%) frame so the user lands on a usable thumbnail without
  // tapping anything. Failures per-frame are swallowed so a single bad seek
  // doesn't break the whole picker — we just render fewer tiles.
  const handleGenerateThumbnails = async (videoUri, durationInSeconds) => {
    try {
      setGeneratingThumbnails(true);
      setGeneratedThumbnails([]);
      const safeDurationMs = Number.isFinite(durationInSeconds) && durationInSeconds > 0 ? durationInSeconds * 1000 : null;
      const timestamps = safeDurationMs
        ? [Math.floor(safeDurationMs * 0.25), Math.floor(safeDurationMs * 0.5), Math.floor(safeDurationMs * 0.75)]
        : [1000, 3000, 5000]; // fallback when duration is unknown — sample early frames

      const results = await Promise.all(timestamps.map((t) => VideoThumbnails.getThumbnailAsync(videoUri, { time: t }).catch(() => null)));
      const validResults = results.filter(Boolean);
      setGeneratedThumbnails(validResults);

      // Default-select the middle frame (or the first available fallback).
      const defaultIndex = validResults[1] ? 1 : validResults[0] ? 0 : -1;
      if (defaultIndex >= 0) {
        setVideoForm((prev) => ({ ...prev, thumbnail: validResults[defaultIndex] }));
        setSelectedThumbnailKey(`gen-${defaultIndex}`);
      }
    } catch (e) {
      console.warn(e);
      showMessage("Failed to generate thumbnails.", 500);
    } finally {
      setGeneratingThumbnails(false);
    }
  };

  // Called from the "Upload your own" tile via openPicker("images") and from
  // the picker's onSelect path for generated tiles. Tracks which tile is now
  // the source of truth so the UI can render the active ring + checkmark.
  const handleThumbnail = (thumbnail, source = "upload") => {
    if (thumbnail && thumbnail.fileSize > sizeLimitThumbnailUpload) {
      showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
      return;
    }
    setVideoForm((prev) => ({ ...prev, thumbnail }));
    setSelectedThumbnailKey(source);
  };

  const handleSelectGeneratedThumbnail = (index) => {
    const choice = generatedThumbnails[index];
    if (!choice) return;
    setVideoForm((prev) => ({ ...prev, thumbnail: choice }));
    setSelectedThumbnailKey(`gen-${index}`);
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
    // Reset any previously generated thumbnails when a new video is picked,
    // then extract three fresh frames at 25/50/75% of the new video.
    setGeneratedThumbnails([]);
    setSelectedThumbnailKey(null);
    handleGenerateThumbnails(video.uri, durationInSeconds);
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
        if (mediaType === "images") handleThumbnail(asset, "upload");
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
      {/* Hero — premium violet-tinted header with a soft accent chip in front
          of the title. Sets the tone for the form: editorial typography, a
          single violet accent, no decoration on the right side that would
          steal focus from the section content below. */}
      <View className="mb-5 mt-1 flex-row items-center">
        <View
          className="mr-3 h-10 w-10 items-center justify-center rounded-xl"
          style={{
            backgroundColor: theme.primarySoft,
            borderWidth: 1,
            borderColor: theme.primary,
          }}
        >
          <Ionicons name="cloud-upload-outline" size={20} color={theme.primary} />
        </View>
        <View className="flex-1">
          <Text className="text-lg font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
            Upload a video
          </Text>
          <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
            Pick a file, give it some context, and you're live.
          </Text>
        </View>
      </View>

      {/* Video — selected state now uses the app's violet primary instead of
          green so it lives in the same color family as every other "active"
          surface across Books / Videos / Profile. */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <SectionDot color={theme.primary} />
            <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Video
            </Text>
          </View>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitVideoUpload / 1024 / 1024}MB`}</Text>
        </View>
        <TouchableOpacity className="mt-3" onPress={() => openPicker("videos")}>
          <View
            className={`aspect-video w-full items-center justify-center rounded-xl border ${videoForm?.videoUrl ? "" : "border-dashed"}`}
            style={{
              borderColor: videoForm?.videoUrl ? theme.primary : theme.borderStrong,
              backgroundColor: videoForm?.videoUrl ? theme.primarySoft : theme.surfaceMuted,
            }}
          >
            {videoLoading ? (
              <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primary} />
            ) : (
              <FontAwesome
                name={videoForm?.videoUrl ? "check-circle" : "video-camera"}
                size={64}
                color={videoForm?.videoUrl ? theme.primary : theme.iconMuted}
              />
            )}
          </View>
        </TouchableOpacity>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          Tap to select a video from your library.
        </Text>
      </View>

      {/* Thumbnail — YouTube-style 4-tile picker. First tile is "Upload your
          own" (manual image picker). The next 3 tiles are auto-generated frames
          extracted at 25/50/75% of the video duration. The active tile is
          highlighted with a violet ring + checkmark badge so the chosen
          thumbnail is unambiguous. videoForm.thumbnail (consumed by the upload
          pipeline) tracks the currently selected tile's data. */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <SectionDot color={theme.primary} />
            <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Thumbnail
            </Text>
          </View>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitThumbnailUpload / 1024 / 1024}MB`}</Text>
        </View>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          Pick a generated frame, or upload your own.
        </Text>

        <View className="mt-3 flex-row" style={{ gap: 8 }}>
          {/* Tile 1 — Upload your own */}
          {(() => {
            const isSelected = selectedThumbnailKey === "upload";
            const customUri = isSelected ? videoForm?.thumbnail?.uri : null;
            return (
              <TouchableOpacity
                onPress={() => openPicker("images")}
                activeOpacity={0.85}
                style={{
                  flex: 1,
                  aspectRatio: 16 / 9,
                  borderRadius: 10,
                  overflow: "hidden",
                  borderWidth: isSelected ? 2 : 1,
                  borderColor: isSelected ? theme.primary : theme.borderStrong,
                  borderStyle: customUri ? "solid" : "dashed",
                  backgroundColor: theme.surfaceMuted,
                  alignItems: "center",
                  justifyContent: "center",
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: isSelected ? 0.25 : 0,
                  shadowRadius: 8,
                  elevation: isSelected ? 3 : 0,
                }}
              >
                {customUri ? (
                  <FastImage
                    source={{ uri: customUri, priority: FastImage.priority.high }}
                    style={{ height: "100%", width: "100%" }}
                    resizeMode={FastImage.resizeMode.cover}
                  />
                ) : (
                  <View className="items-center justify-center px-1">
                    <Ionicons name="cloud-upload-outline" size={20} color={theme.iconMuted} />
                    <Text className="mt-1 text-[9px] font-semibold uppercase" style={{ color: theme.textSoft, letterSpacing: 0.4 }} numberOfLines={1}>
                      Upload
                    </Text>
                  </View>
                )}
                {isSelected && (
                  <View
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      backgroundColor: theme.primary,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="checkmark" size={12} color={theme.primaryContrast} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })()}

          {/* Tiles 2–4 — Auto-generated frames at 25/50/75% */}
          {[0, 1, 2].map((index) => {
            const tileKey = `gen-${index}`;
            const isSelected = selectedThumbnailKey === tileKey;
            const generated = generatedThumbnails[index];
            const isLoading = generatingThumbnails && !generated;
            const isPlaceholder = !videoForm?.videoUrl && !generated;

            return (
              <TouchableOpacity
                key={tileKey}
                onPress={() => handleSelectGeneratedThumbnail(index)}
                disabled={!generated}
                activeOpacity={0.85}
                style={{
                  flex: 1,
                  aspectRatio: 16 / 9,
                  borderRadius: 10,
                  overflow: "hidden",
                  borderWidth: isSelected ? 2 : 1,
                  borderColor: isSelected ? theme.primary : theme.border,
                  backgroundColor: theme.surfaceMuted,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: isPlaceholder ? 0.45 : 1,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: isSelected ? 0.25 : 0,
                  shadowRadius: 8,
                  elevation: isSelected ? 3 : 0,
                }}
              >
                {generated ? (
                  <FastImage
                    source={{ uri: generated.uri, priority: FastImage.priority.high }}
                    style={{ height: "100%", width: "100%" }}
                    resizeMode={FastImage.resizeMode.cover}
                  />
                ) : isLoading ? (
                  <LoaderKit style={{ width: 22, height: 22 }} name="LineScale" color={theme.primary} />
                ) : (
                  <Ionicons name="image-outline" size={20} color={theme.iconMuted} />
                )}
                {isSelected && (
                  <View
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      backgroundColor: theme.primary,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="checkmark" size={12} color={theme.primaryContrast} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Title */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <SectionDot color={theme.primary} />
            <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Title
            </Text>
          </View>
          <Text
            className="text-[10px] font-medium"
            style={{ color: theme.textSoft }}
          >{`${videoForm?.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
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
          <View className="flex-row items-center">
            <SectionDot color={theme.primary} />
            <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Description
            </Text>
          </View>
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

      {/* Tags — YouTube-style free typing. Optional. Press space, return,
          or comma to commit a chip; backspace on empty input removes the
          last chip. Cap at sizeLimitTags. Tags are case-preserving on
          display but de-duped case-insensitively, mirroring YouTube. */}
      <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <SectionDot color={theme.primary} />
            <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Tags
            </Text>
          </View>
          <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>
            {`${videoForm?.tags?.length || 0} / ${sizeLimitTags}`}
          </Text>
        </View>
        <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
          Optional. Press return or comma to add. Helps people find your video.
        </Text>

        <View
          className="mt-3 rounded-xl px-2 py-2"
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

      {/* Publish Settings */}
      <View className="mb-6 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row items-center">
          <SectionDot color={theme.primary} />
          <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
            Publish Settings
          </Text>
        </View>
        <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
          Choose how your video goes live.
        </Text>

        {/* Single segmented toggle — premium replacement for the two stacked
            green pills. Half/half violet primary on the active side, transparent
            on the inactive side, sitting inside a single rounded surfaceMuted
            track. Same shape as the app's pill tab bars. */}
        <View
          className="mt-4 flex-row overflow-hidden rounded-full"
          style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
        >
          <TouchableOpacity
            onPress={() => {
              setPublishNow(true);
              setScheduledDate(null);
            }}
            activeOpacity={0.85}
            className="flex-1 flex-row items-center justify-center py-2.5"
            style={{
              backgroundColor: publishNow ? theme.primary : "transparent",
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: publishNow ? 0.2 : 0,
              shadowRadius: 8,
              elevation: publishNow ? 2 : 0,
            }}
          >
            <Ionicons name="flash" size={14} color={publishNow ? theme.primaryContrast : theme.iconMuted} style={{ marginRight: 6 }} />
            <Text className="font-semibold" style={{ fontSize: 13, color: publishNow ? theme.primaryContrast : theme.textMuted, letterSpacing: 0.1 }}>
              Publish now
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              setPublishNow(false);
              handleOpenDateTimePicker();
            }}
            activeOpacity={0.85}
            className="flex-1 flex-row items-center justify-center py-2.5"
            style={{
              backgroundColor: !publishNow ? theme.primary : "transparent",
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: !publishNow ? 0.2 : 0,
              shadowRadius: 8,
              elevation: !publishNow ? 2 : 0,
            }}
          >
            <Ionicons name="calendar-outline" size={14} color={!publishNow ? theme.primaryContrast : theme.iconMuted} style={{ marginRight: 6 }} />
            <Text
              className="font-semibold"
              style={{ fontSize: 13, color: !publishNow ? theme.primaryContrast : theme.textMuted, letterSpacing: 0.1 }}
            >
              Schedule
            </Text>
          </TouchableOpacity>
        </View>

        {/* Show Scheduled Date */}
        {!publishNow && (
          <View className="mt-4 rounded-xl p-3" style={{ backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}>
            <View className="flex-row items-center">
              <Ionicons name="time-outline" size={16} color={theme.primary} style={{ marginRight: 8 }} />
              <Text className="flex-1 font-medium" style={{ color: theme.text }}>
                {scheduledDate ? `Scheduled for ${new Date(scheduledDate).toLocaleString()}` : "No schedule selected yet"}
              </Text>
            </View>

            <TouchableOpacity
              className="mt-3 rounded-full px-3 py-2.5"
              style={{
                backgroundColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 8,
                elevation: 3,
              }}
              onPress={handleOpenDateTimePicker}
            >
              <Text className="text-center font-semibold" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
                {scheduledDate ? "Change schedule" : "Select date & time"}
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
                style={{
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.25,
                  shadowRadius: 8,
                  elevation: 3,
                }}
                onPress={() => {
                  setScheduledDate(tempDate.toISOString());
                  setShowPickerModal(false);
                }}
              >
                <Text className="text-center font-medium" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
                  Confirm
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Monetization — clearer affordance with the violet primary on the
            switch's track when enabled, and a tighter inset row matching the
            other secondary controls. */}
        <View
          className="mt-4 flex-row items-start justify-between rounded-xl p-3"
          style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
        >
          <View className="flex-1 pr-3">
            <View className="flex-row items-center">
              <MaterialIcons name="paid" size={16} color={isMonetizationEligible ? theme.primary : theme.iconMuted} style={{ marginRight: 6 }} />
              <Text className="font-semibold" style={{ color: theme.text, letterSpacing: 0.1 }}>
                Enable monetization
              </Text>
            </View>
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              Available for videos longer than 3 minutes.
            </Text>
          </View>
          <Switch
            value={monetizationEnabled}
            disabled={!isMonetizationEligible}
            trackColor={{ false: theme.surfaceStrong, true: theme.primary }}
            thumbColor={Platform.OS === "android" ? (monetizationEnabled ? theme.primaryContrast : theme.iconMuted) : undefined}
            ios_backgroundColor={theme.surfaceStrong}
            onValueChange={(value) => setMonetizationEnabled(isMonetizationEligible ? value : false)}
          />
        </View>
      </View>

      {/* Primary CTA — violet pill with the same shadow lift used on the Books /
          Videos / home-feed active tab pills. Reads as the single most important
          action on the page. */}
      <TouchableOpacity
        onPress={handlePublish}
        activeOpacity={0.9}
        className="mt-2 flex w-full flex-row items-center justify-center rounded-full px-4 py-3.5"
        style={{
          backgroundColor: theme.primary,
          shadowColor: theme.primary,
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.32,
          shadowRadius: 14,
          elevation: 6,
        }}
      >
        <Ionicons name="cloud-upload" size={20} color={theme.primaryContrast} />
        <Text className="ml-2 text-[14px] font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.3 }}>
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
            <View className="h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceStrong }}>
              <View
                className="h-full rounded-full"
                style={{
                  width: `${progress}%`,
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.4,
                  shadowRadius: 4,
                }}
              />
            </View>
            {canCancelUpload && (
              <TouchableOpacity
                className="mt-4 w-full rounded-full py-2"
                style={{ backgroundColor: theme.danger }}
                onPress={handleCancelUpload}
                activeOpacity={0.8}
              >
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
