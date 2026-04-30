import { FontAwesome } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import React, { useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ID } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { ClipsIcon } from "../assets/svgs";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { FetchVideos } from "../lib/appwrite";
import { createNewClip, initialClipForm } from "../lib/clips";
import { NotificationService } from "../lib/notifications";
import { UploadFilesToS3 } from "../lib/s3-uploads";
import secrets from "../private/secrets";

const UploadClips = ({ showMessage }) => {
  const { globalSettings, user, setAllVideos } = useGlobalContext();
  const { theme } = useAppTheme();

  const [formLoading, setFormLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [clipForm, setClipForm] = useState(initialClipForm);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [clipLoading, setClipLoading] = useState(false);

  const notificationService = new NotificationService();
  const sizeLimitVideoUpload = globalSettings["VIDEO_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitThumbnailUpload = globalSettings["THUMBNAIL_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["TITLE_LIMIT_SIZE_CHARS"];
  const clipsDurationMin = globalSettings["CLIPS_DURATION_MIN"];
  const clipsDurationMax = globalSettings["CLIPS_DURATION_MAX"];

  const handlePublish = async () => {
    try {
      if (handleValidateData()) return;
      setFormLoading(true);
      setProgress(0);

      const clipID = ID.unique();
      const responseThumbnail = await UploadFilesToS3(clipForm.thumbnail, clipID, "image", secrets.AWS_CLIPS_BUCKET_NAME);
      setProgress(25);

      const responseVideo = await UploadFilesToS3(clipForm.clipUrl, clipID, "video", secrets.AWS_CLIPS_BUCKET_NAME);
      setProgress(50);

      if (responseThumbnail && responseVideo) {
        await createNewClip({
          ...clipForm,
          ID: clipID,
          thumbnail: responseThumbnail,
          clipUrl: responseVideo,
          uploader: user.$id,
          totalViews: 0,
          clipLikes: 0,
          clipComments: 0,
          dailyViews: JSON.stringify({}),
        });
        setProgress(70);

        await notificationService.notifyFollowers({
          sender: user,
          type: "clip",
          resourceId: clipID,
          message: `uploaded a new clip: ${clipForm.title}`,
        });
        setProgress(90);

        await FetchVideos(setAllVideos);
        setProgress(100);

        setClipForm(initialClipForm);
        setFormLoading(false);
        showMessage("Your clip has been published successfully!", 500);
      } else {
        setFormLoading(false);
        showMessage("Your clip upload was unsuccessful :(", 500);
      }
    } catch (error) {
      setFormLoading(false);
      showMessage("Your clip upload was unsuccessful :(", 500);
      console.log("UploadClips error", error?.message || error);
    }
  };

  const handleValidateData = () => {
    if (!clipForm?.thumbnail || !clipForm?.clipUrl) {
      showMessage("Either your thumbnail or your clip is empty.");
      return true;
    }

    if (!clipForm?.title?.length) {
      showMessage("Please enter a title.");
      return true;
    }

    if (!clipForm?.description?.length) {
      showMessage("Please enter a description.");
      return true;
    }

    if (clipForm?.title?.length > sizeLimitTitleChars) {
      showMessage(`Please ensure your title char size is under ${sizeLimitTitleChars}.`);
      return true;
    }

    return false;
  };

  const handleChange = (key, value) => {
    setClipForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleGenerateThumbnail = async (videoUri) => {
    try {
      setThumbnailLoading(true);
      const result = await VideoThumbnails.getThumbnailAsync(videoUri, { time: 1000 });
      setClipForm((prev) => ({ ...prev, thumbnail: result }));
    } catch (e) {
      console.warn(e);
      showMessage("Failed to generate thumbnail.", 500);
    } finally {
      setThumbnailLoading(false);
    }
  };

  const handleThumbnail = (thumbnail) => {
    if (thumbnail.fileSize > sizeLimitThumbnailUpload) {
      showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
      return;
    }
    setClipForm((prev) => ({ ...prev, thumbnail }));
  };

  const handleVideo = (video) => {
    if (video.fileSize > sizeLimitVideoUpload) {
      showMessage(`Please ensure your clip upload size is under ${sizeLimitVideoUpload / 1024 / 1024}MB.`, 500);
      return;
    }

    const durationSec = video.duration / 1000;
    if (durationSec < clipsDurationMin || durationSec > clipsDurationMax) {
      showMessage(`Your clip must be at least ${clipsDurationMin} second and no more than ${clipsDurationMax / 60} minutes long.`, 500);
      return;
    }

    setClipForm((prev) => ({ ...prev, clipUrl: video }));
    handleGenerateThumbnail(video.uri);
  };

  const openPicker = async (mediaType) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    try {
      if (mediaType === "videos") setClipLoading(true);

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: mediaType,
      });

      if (!result.canceled) {
        const asset = result.assets[0];
        if (mediaType === "images") handleThumbnail(asset);
        if (mediaType === "videos") handleVideo(asset);
      }
    } finally {
      if (mediaType === "videos") setClipLoading(false);
    }
  };

  return (
    <View className="mx-auto h-full w-full px-4 pb-5">
      {/* Video */}
      <View className="pb-3">
        <Text className="items-center text-lg font-bold font-semibold" style={{ color: theme.text }}>
          Clip
        </Text>
        <Text className="items-center text-xs font-bold font-semibold" style={{ color: theme.textSoft }}>
          Please ensure your clip upload size is under 350MB and must be at least {clipsDurationMin} second and no more than {clipsDurationMax / 60}{" "}
          minutes long.
        </Text>
        <TouchableOpacity className="py-2" onPress={() => openPicker("videos")}>
          <View
            className="aspect-video w-full items-center justify-center rounded-md"
            style={{ backgroundColor: clipForm?.clipUrl ? theme.accentGreen : theme.surfaceStrong }}
          >
            {clipLoading ? (
              <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primaryContrast} />
            ) : clipForm?.clipUrl ? (
              <FontAwesome name={"check-circle"} size={80} color={theme.primaryContrast} />
            ) : (
              <ClipsIcon width={85} height={85} color={theme.icon} />
            )}
          </View>
        </TouchableOpacity>
      </View>

      {/* Thumbnail */}
      <View className="py-3">
        <Text className="items-center text-lg font-bold font-semibold" style={{ color: theme.text }}>
          Thumbnail
        </Text>
        <TouchableOpacity className="py-2" onPress={() => openPicker("images")}>
          <View className="aspect-video w-full items-center justify-center rounded-md" style={{ backgroundColor: theme.surfaceStrong }}>
            {thumbnailLoading ? (
              <LoaderKit style={{ width: 50, height: 50 }} name="LineScale" color={theme.primary} />
            ) : clipForm?.thumbnail?.uri ? (
              <FastImage
                className="h-full w-full"
                source={{ uri: clipForm?.thumbnail?.uri, priority: FastImage.priority.high }}
                resizeMode={FastImage.resizeMode.contain}
              />
            ) : (
              <FontAwesome name="image" size={80} color={theme.iconMuted} />
            )}
          </View>
        </TouchableOpacity>
      </View>

      {/* Title */}
      <View className="py-3">
        <View className="flex-row items-center justify-between">
          <Text className="items-center text-lg font-bold font-semibold" style={{ color: theme.text }}>
            Title
          </Text>
          <Text
            className="text-[10px] font-medium"
            style={{ color: theme.textSoft }}
          >{`${clipForm?.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
        </View>
        <TextInput
          value={clipForm?.title}
          onChangeText={(text) => handleChange("title", text)}
          placeholder="Your clip's title"
          placeholderTextColor={theme.placeholder}
          className="my-2 w-full rounded-md p-3"
          style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
          maxLength={Number(sizeLimitTitleChars)}
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
        />
      </View>

      {/* Description */}
      <View className="py-3">
        <Text className="items-center text-lg font-bold font-semibold" style={{ color: theme.text }}>
          Description
        </Text>
        <TextInput
          value={clipForm.description}
          onChangeText={(text) => handleChange("description", text)}
          multiline
          textAlignVertical="top"
          placeholder="Your clip's description"
          placeholderTextColor={theme.placeholder}
          className="my-2 h-[150px] w-full justify-start rounded-md p-3"
          style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
        />
      </View>

      <TouchableOpacity
        onPress={handlePublish}
        className="ml-auto flex w-fit flex-row items-center justify-center rounded-full px-4 py-2"
        style={{ backgroundColor: theme.accentGreen }}
      >
        <FontAwesome name="cloud-upload" size={24} color={theme.primaryContrast} />
        <Text className="ml-1.5 font-semibold" style={{ color: theme.primaryContrast }}>
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
            className="relative mx-5 flex w-full max-w-[300px] flex-col items-center justify-center rounded-3xl p-6"
            style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
          >
            {/* Loading Spinner */}
            <LoaderKit style={{ width: 75, height: 75, opacity: 1 }} name={"LineScalePulseOutRapid"} color={theme.primary} />
            <Text className="my-2 text-lg font-semibold" style={{ color: theme.text }}>
              Publishing Clip
            </Text>
            {/* Progress Bar */}
            <View className="h-2 w-full rounded-md" style={{ backgroundColor: theme.surfaceStrong }}>
              <View className="h-full rounded-md" style={{ width: `${progress}%`, backgroundColor: theme.accentAmber }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default UploadClips;
