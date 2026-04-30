import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Switch, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";

import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { UploadVideoToBunnyStorage } from "../lib/fetch-bunny-storage";
import FormatNumber from "../lib/utils/format-number";
import { NotificationService } from "../lib/notifications";
import { createNewPost, deletePost, findPostByVideoId } from "../lib/posts";
import TimeAgo from "../lib/utils/time-ago";
import { VideosService, updateVideoDocument } from "../lib/video";
import secrets from "../private/secrets";
import CustomAlertModal from "./CustomAlertModal";
import EditVideoFormModal from "./EditVideoFormModal";

const MIN_MONETIZATION_DURATION_SECONDS = 180;

const parseDurationString = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return null;

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return null;
};

const normalizeDurationSeconds = (value) => {
  if (value === null || value === undefined) return null;

  const parsedFromString = parseDurationString(value);
  if (parsedFromString !== null) return parsedFromString;

  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return numeric > 10000 ? numeric / 1000 : numeric;
};

const extractDurationSeconds = (video) => {
  const candidates = [
    video?.durationSeconds,
    video?.duration_sec,
    video?.duration,
    video?.videoDuration,
    video?.video_duration,
    video?.length,
    video?.lengthSeconds,
    video?.videoStats?.duration,
    video?.videoStats?.durationSeconds,
  ];

  const raw = candidates.find((val) => val !== undefined && val !== null);
  return normalizeDurationSeconds(raw);
};

const fetchDurationFromPlaylist = async (playlistUrl) => {
  if (!playlistUrl) return null;

  const fetchText = async (url) => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.text();
    } catch (err) {
      console.warn("Failed to fetch playlist", err?.message || err);
      return null;
    }
  };

  const parseMediaPlaylistSeconds = (text) => {
    if (!text) return null;
    let totalSeconds = 0;
    const regex = /#EXTINF:([0-9.]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = parseFloat(match[1]);
      if (!Number.isNaN(value)) {
        totalSeconds += value;
      }
    }
    return totalSeconds > 0 ? totalSeconds : null;
  };

  // Fetch root playlist (may be master or media)
  const rootText = await fetchText(playlistUrl);
  if (!rootText) return null;

  // Master playlist: fetch first variant
  if (rootText.includes("#EXT-X-STREAM-INF")) {
    const lines = rootText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const variantLine = lines.find((line) => !line.startsWith("#") && line.toLowerCase().endsWith(".m3u8"));
    if (variantLine) {
      const variantUrl = new URL(variantLine, playlistUrl).toString();
      const variantText = await fetchText(variantUrl);
      const variantSeconds = parseMediaPlaylistSeconds(variantText);
      if (variantSeconds !== null) return variantSeconds;
    }
  }

  // Fallback: treat root as media playlist
  return parseMediaPlaylistSeconds(rootText);
};

const formatDuration = (seconds) => {
  if (seconds === null) return null;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

const CreatorVideoCard = ({ item, onDeleted, onUpdated }) => {
  const { theme } = useAppTheme();
  const { globalSettings } = useGlobalContext();
  const [menuVisible, setMenuVisible] = useState(false);
  const [localStatus, setLocalStatus] = useState(item.status);
  const [monetization, setMonetization] = useState(item.monetization_enabled ?? false);
  const [monetizationEligible, setMonetizationEligible] = useState(true);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(null);
  const [durationFetching, setDurationFetching] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editSuccess, setEditSuccess] = useState(false);
  const [localPublishDate, setLocalPublishDate] = useState(item.publishDate);
  const durationFetchAttempted = useRef(false);

  const notificationService = new NotificationService();
  const videosService = new VideosService();
  const statusColors = {
    uploading: theme.accentAmber,
    processing: theme.accentAmber,
    ready: theme.accentBlue,
    published: theme.accentGreen,
    unpublished: theme.danger,
    failed: theme.danger,
  };
  const statusColor = statusColors[localStatus] || theme.textSoft;
  const publishDisabled = ["uploading", "processing", "failed"].includes(localStatus);

  useEffect(() => {
    const durationSeconds = extractDurationSeconds(item);

    const eligible = durationSeconds !== null && durationSeconds >= MIN_MONETIZATION_DURATION_SECONDS;

    setLocalStatus(item.status);
    setVideoDurationSeconds(durationSeconds);
    setMonetizationEligible(eligible);
    setMonetization(eligible ? (item.monetization_enabled ?? false) : false);
    setLocalPublishDate(item.publishDate);
    durationFetchAttempted.current = false; // allow refetch when item changes
  }, [item]);

  useEffect(() => {
    const shouldFetchFromPlaylist =
      item?.videoUrl &&
      !durationFetchAttempted.current &&
      (videoDurationSeconds === null || videoDurationSeconds < MIN_MONETIZATION_DURATION_SECONDS);

    if (!shouldFetchFromPlaylist) return;

    durationFetchAttempted.current = true;
    const loadDuration = async () => {
      setDurationFetching(true);
      const fetchedDuration = await fetchDurationFromPlaylist(item.videoUrl);
      if (fetchedDuration !== null) {
        const eligible = fetchedDuration >= MIN_MONETIZATION_DURATION_SECONDS;
        setVideoDurationSeconds(fetchedDuration);
        setMonetizationEligible(eligible);
        setMonetization(eligible ? (item.monetization_enabled ?? false) : false);
      }
      setDurationFetching(false);
    };

    loadDuration();
  }, [item?.videoUrl, videoDurationSeconds, item?.monetization_enabled]);

  /* ---------- PUBLISH STATUS TOGGLE ---------- */
  const handleTogglePublish = async (isOn) => {
    if (publishDisabled) return;

    const newStatus = isOn ? "published" : "unpublished";

    const proceedPublish = async () => {
      try {
        setLocalStatus(newStatus);
        const nowIso = new Date().toISOString();
        const updateData = { status: newStatus };
        if (newStatus === "published") {
          updateData.publishDate = nowIso;
        }

        // Update video status
        await updateVideoDocument({
          id: item.$id,
          data: updateData,
        });

        if (newStatus === "published") {
          setLocalPublishDate(nowIso);
        } else {
          setLocalPublishDate(null);
        }

        // Create post ONLY when publishing and Notify followers
        if (newStatus === "published") {
          await ensureVideoPostExists({
            videoId: item.$id,
            ownerId: item.uploader,
          });

          notificationService.notifyFollowers({
            sender: item.uploader,
            type: "video",
            resourceId: item.$id,
            message: `${item.title} has just been published!`,
          });
        }
      } catch (err) {
        console.error("Publish toggle error:", err);
        setLocalStatus(item.status);
      }
    };

    // Scheduled confirmation
    if (newStatus === "published" && isScheduledInFuture(item.scheduled_publish_at)) {
      Alert.alert(
        "Publish Now?",
        `This video is scheduled to publish at ${formatScheduleDate(item.scheduled_publish_at)}.\n\nDo you want to publish it now instead?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Publish Now", style: "default", onPress: proceedPublish },
        ],
      );
      return;
    }

    // Default flow
    proceedPublish();
  };

  /* ---------- MONETIZATION TOGGLE ---------- */
  const handleToggleMonetization = async (bool) => {
    if (!monetizationEligible) {
      const reason =
        videoDurationSeconds === null
          ? "Duration is not available yet. Please wait for processing to finish and refresh, then try again."
          : "Videos must be at least 3 minutes long to enable monetization. Please upload a longer video to turn this on.";
      Alert.alert("Monetization unavailable", reason);
      setMonetization(false);
      return;
    }

    try {
      setMonetization(bool);
      await updateVideoDocument({ id: item.$id, data: { monetization_enabled: bool } });
    } catch (err) {
      console.error("Monetization toggle error:", err);
      setMonetization(item.monetization_enabled ?? false);
    }
  };

  /* ---------- DELETE VIDEO ---------- */
  const handleDelete = () => {
    Alert.alert("Delete Video", "Are you sure you want to delete this video? This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setIsDeleting(true);
          try {
            // delete post
            const relatedPost = await findPostByVideoId(item.$id);
            if (relatedPost) {
              await deletePost({ ID: relatedPost.$id });
            }
            // delete video
            await updateVideoDocument({
              id: item.$id,
              data: { status: "deleted" },
            });
            // update UI
            if (onDeleted) onDeleted(item.$id);
          } catch (err) {
            console.error("Delete failed:", err);
          }
          setIsDeleting(false);
          setMenuVisible(false);
        },
      },
    ]);
  };

  // Helpers
  const ensureVideoPostExists = async ({ videoId, ownerId }) => {
    const existing = await findPostByVideoId(videoId);

    if (existing) {
      return existing; // already created
    }

    return createNewPost({
      postResourceId: videoId,
      postResourceType: "video",
      postOwner: ownerId,
    });
  };

  const isScheduledInFuture = (scheduledAt) => {
    if (!scheduledAt) return false;
    return new Date(scheduledAt).getTime() > Date.now();
  };

  const formatScheduleDate = (date) => {
    return new Date(date).toLocaleString();
  };

  const getStatusText = () => {
    if (localStatus === "ready" && isScheduledInFuture(item.scheduled_publish_at)) {
      return `SCHEDULED • ${formatScheduleDate(item.scheduled_publish_at)}`;
    }

    return localStatus.toUpperCase();
  };

  // helpers
  const canEditSchedule = (video) => {
    if (!video) return false;
    if (video.status !== "ready") return false;
    if (!video.scheduled_publish_at) return false;

    const scheduledTime = new Date(video.scheduled_publish_at).getTime();
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    return scheduledTime - now >= FIVE_MINUTES;
  };

  const views = item.videoStats?.totalViews ?? 0;
  const likes = item.videoStats?.likes ?? 0;
  const comments = item.videoStats?.comments ?? 0;

  return (
    <>
      {/* ─────────────── CARD ─────────────── */}
      <View className="mb-2.5 w-full rounded-lg p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row space-x-3">
          {/* Thumbnail */}
          <FastImage source={{ uri: item.thumbnail }} style={{ width: 130, height: 90, borderRadius: 8 }} resizeMode="cover" />

          {/* Info */}
          <View className="flex-1">
            {/* Title + Menu */}
            <View className="flex-row justify-between">
              <Text className="mr-2 flex-1 font-semibold" style={{ color: theme.text }} numberOfLines={2}>
                {item.title}
              </Text>
              <TouchableOpacity onPress={() => setMenuVisible(true)} className="p-1">
                <MaterialIcons name="more-vert" size={20} color={theme.icon} />
              </TouchableOpacity>
            </View>

            <Text className="mt-1 text-xs" style={{ color: statusColor }}>
              {getStatusText()}
              {localStatus === "published" && localPublishDate && <Text> • {TimeAgo(localPublishDate)}</Text>}
            </Text>

            {/* Stats */}
            <View className="mt-3 flex-row flex-wrap items-center space-x-4">
              <View className="flex-row items-center space-x-1">
                <MaterialCommunityIcons name="cash" size={18} color={monetization ? theme.accentGreen : theme.danger} />
                <Text style={{ color: theme.textMuted }}>{monetization ? "On" : "Off"}</Text>
              </View>
              <View className="flex-row items-center space-x-1">
                <MaterialIcons name="visibility" size={18} color={theme.accentPurple} />
                <Text style={{ color: theme.textMuted }}>{FormatNumber(views)}</Text>
              </View>
              <View className="flex-row items-center space-x-1">
                <MaterialIcons name="favorite" size={18} color={theme.danger} />
                <Text style={{ color: theme.textMuted }}>{FormatNumber(likes)}</Text>
              </View>
              <View className="flex-row items-center space-x-1">
                <MaterialIcons name="comment" size={18} color={theme.accentBlue} />
                <Text style={{ color: theme.textMuted }}>{FormatNumber(comments)}</Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* ─────────────── MODAL MENU ─────────────── */}
      <Modal
        isVisible={menuVisible}
        onBackdropPress={() => setMenuVisible(false)}
        onBackButtonPress={() => setMenuVisible(false)}
        swipeDirection="down"
        onSwipeComplete={() => setMenuVisible(false)}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.4}
        propagateSwipe
      >
        <View
          className="w-full rounded-t-3xl px-6 pb-8 pt-4"
          style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border }}
        >
          {/* Grab Handle */}
          <View className="mb-3 h-1.5 w-10 self-center rounded-full" style={{ backgroundColor: theme.handle }} />

          {/* Title */}
          <Text className="mb-5 px-6 text-center text-lg font-bold" style={{ color: theme.text }} numberOfLines={2}>
            {item.title}
          </Text>

          <View className="gap-3">
            {/* Publish Status */}
            <View className="flex-row items-center justify-between rounded-xl px-4 py-3" style={{ backgroundColor: theme.cardStrong }}>
              <View className="flex-row items-center gap-3">
                <MaterialIcons name="public" size={22} color={publishDisabled ? theme.textSubtle : theme.accentGreen} />
                <Text className="text-base font-medium" style={{ color: publishDisabled ? theme.textSubtle : theme.text }}>
                  {localStatus === "published" ? "Published" : "Private"}
                </Text>
              </View>
              <Switch
                value={localStatus === "published"}
                disabled={publishDisabled}
                onValueChange={handleTogglePublish}
                trackColor={{ false: theme.surfaceStrong, true: theme.primary }}
                thumbColor={localStatus === "published" ? theme.primaryContrast : theme.surfaceElevated}
                ios_backgroundColor={theme.surfaceStrong}
              />
            </View>

            {/* Monetization */}
            <View className="flex-row items-center justify-between rounded-xl px-4 py-3" style={{ backgroundColor: theme.cardStrong }}>
              <View className="flex-1">
                <View className="flex-row items-center gap-3">
                  <MaterialCommunityIcons name="cash-multiple" size={22} color={monetization ? theme.accentGreen : theme.coin} />
                  <Text className="text-base font-medium" style={{ color: theme.text }}>
                    Monetization {monetization ? "Enabled" : "Disabled"}
                  </Text>
                </View>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Monetization is available for videos longer than 3 minutes.
                  {formatDuration(videoDurationSeconds) ? ` Current length: ${formatDuration(videoDurationSeconds)}.` : " Duration unavailable."}
                  {durationFetching ? " Fetching exact duration..." : ""}
                </Text>
                {!monetizationEligible && videoDurationSeconds !== null && (
                  <Text className="text-xs" style={{ color: theme.accentAmber }}>
                    This video is under 3 minutes; monetization is disabled.
                  </Text>
                )}
                {!monetizationEligible && videoDurationSeconds === null && (
                  <Text className="text-xs" style={{ color: theme.accentAmber }}>
                    Duration missing; monetization will unlock once length is known and over 3 minutes.
                  </Text>
                )}
              </View>
              <Switch
                value={monetization}
                disabled={!monetizationEligible}
                onValueChange={handleToggleMonetization}
                trackColor={{ false: theme.surfaceStrong, true: theme.primary }}
                thumbColor={monetization ? theme.primaryContrast : theme.surfaceElevated}
                ios_backgroundColor={theme.surfaceStrong}
              />
            </View>

            {/* Edit Details */}
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                setTimeout(() => setEditVisible(true), 600);
              }}
              className="flex-row items-center justify-between rounded-xl px-4 py-3"
              style={{ backgroundColor: theme.cardStrong }}
            >
              <View className="flex-row items-center gap-3">
                <MaterialIcons name="edit" size={22} color={theme.accentBlue} />
                <Text className="text-base font-medium" style={{ color: theme.text }}>
                  Edit Details
                </Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color={theme.accentBlue} />
            </TouchableOpacity>

            {/* Delete Video */}
            <TouchableOpacity
              onPress={!isDeleting ? handleDelete : null}
              className="flex-row items-center justify-between rounded-xl px-4 py-3"
              style={{ backgroundColor: theme.cardStrong }}
            >
              <View className="flex-row items-center gap-3">
                <MaterialIcons name="delete" size={22} color={theme.danger} />
                <Text className="text-base font-medium" style={{ color: theme.danger }}>
                  Delete Video
                </Text>
              </View>
              {isDeleting ? (
                <ActivityIndicator size="small" color={theme.danger} />
              ) : (
                <MaterialIcons name="chevron-right" size={22} color={theme.danger} />
              )}
            </TouchableOpacity>
          </View>

          {/* Close */}
          <TouchableOpacity onPress={() => setMenuVisible(false)} className="mt-5 self-center">
            <Text className="font-medium" style={{ color: theme.textSoft }}>
              Close
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <EditVideoFormModal
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        mode="edit"
        initialData={item}
        globalSettings={globalSettings}
        allowScheduleEdit={canEditSchedule(item)}
        onSubmit={async (form) => {
          const updates = {
            title: form.title,
            description: form.description,
            tags: form.tags,
          };

          if (form.scheduled_publish_at) {
            updates.scheduled_publish_at = form.scheduled_publish_at;
          }

          // Thumbnail update only if changed
          if (form.thumbnail && form.thumbnail.uri !== item.thumbnail) {
            const videoId = item.$id;
            const timestamp = Date.now();
            const thumbnailPath = `${videoId}/${videoId}-${timestamp}.jpg`;
            const uploadThumb = await UploadVideoToBunnyStorage(thumbnailPath, form.thumbnail);
            if (uploadThumb) {
              updates.thumbnail = `${secrets.BUNNY_VIDEOS_STORAGE_CDN_HOSTNAME}/${thumbnailPath}`;
            }
          }

          console.log("updates.thumbnail", updates.thumbnail);

          // Update Appwrite
          await updateVideoDocument({ id: item.$id, data: updates });

          // Update UI instantly
          const updatedData = { ...item, ...updates };
          onUpdated?.(updatedData);

          // Close and show success modal
          setEditVisible(false);
          setTimeout(() => setEditSuccess(true), 600);
        }}
      />

      {/* Success Modal */}
      <CustomAlertModal
        message="Video updated successfully!"
        iconName="check-circle"
        iconColor={theme.accentGreen}
        messageOpen={editSuccess}
        closeMessage={() => setEditSuccess(false)}
      />
    </>
  );
};

export default CreatorVideoCard;
