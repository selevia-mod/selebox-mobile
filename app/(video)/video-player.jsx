import { FontAwesome, Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  AppState,
  Dimensions,
  Image,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { ID, Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import { AdEventType, InterstitialAd, TestIds } from "react-native-google-mobile-ads";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDispatch, useSelector } from "react-redux";
import {
  ContentNotFound,
  CustomAlertModal,
  StarIcon,
  StyledCoinIndicator,
  StyledLikeCommentShare,
  StyledPlaylistButton,
  StyledSafeAreaView,
  StyledStarIndicator,
  UserRoleBadgeIcons,
  VideoUnlockChoiceModal,
  VideosDownloadQualityModal,
} from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import logger from "../../lib/utils/logger";
import ReactionPicker from "../../components/ReactionPicker";
import UserMention from "../../components/UserMention";
import { useGlobalContext } from "../../context/global-provider";
import { useVideosStats } from "../../context/video-stats-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useAutoUnlock from "../../hooks/useAutoUnlock";
import useCommentReactionState from "../../hooks/useCommentReactionState";
import useIsOffline from "../../hooks/useIsOffline";
import { addToHistory, databases, getCoinDeductionByTags, getCoinPacks, limitVideos, ShuffleVideos } from "../../lib/appwrite";
import { FollowService } from "../../lib/follows";

import FormatNumber from "../../lib/utils/format-number";
import { buildVideoNotificationResourceId, NotificationService } from "../../lib/notifications";
import TimeAgo from "../../lib/utils/time-ago";
import { useModalMessage } from "../../hooks/useModalMessage";
import {
  buildMentionSearchTerms,
  extractMentionTargetsFromMarkup,
  extractMentionUsernames,
  findComposerMentionAtPosition,
  hasMentionLabelInText,
  MENTION_SEARCH_DEBOUNCE_MS,
  normalizeExternalUrl,
  normalizeMentionSearchQuery,
  normalizeMentionToken,
  rankMentionCandidatesByUsername,
  sanitizeMentionLabel,
  serializeMentionsForStorage,
} from "../../lib/user-mentions";
import { fetchUsersByQuery, getUserByID } from "../../lib/users";
import {
  createVideoCommentLike,
  fetchVideoCommentLikesByCommentIds,
  fetchVideoCommentRepliesByParentIds,
  removeVideoCommentLike,
  resolveVideoCommentCount,
  VideosService,
} from "../../lib/video";
import {
  downloadVideoOffline,
  formatBytes,
  getAvailableVideoDownloadQualities,
  getVideoDownloadId,
  isInsufficientVideoStorageError,
  isVideoDownloadCancelledError,
  SUPPORTED_VIDEO_DOWNLOAD_QUALITIES,
} from "../../lib/video-downloads";
import { VideoUnlocksService } from "../../lib/video-unlocks";
import secrets from "../../private/secrets";
import { downloadQuality, upsertVideoDownload } from "../../store/reducers/videos";

const formatTimecode = (seconds) => {
  const totalSeconds = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

// Android keyboard behavior is inconsistent across OEMs: some devices fully resize
// the viewport, while others leave part or all of the IME overlaid on top of it.
const getKeyboardViewportInset = ({ keyboardHeight, baselineWindowHeight, windowHeight }) => {
  if (!keyboardHeight) return 0;
  if (Platform.OS !== "android") return keyboardHeight;

  const viewportReduction = Math.max(0, (baselineWindowHeight || windowHeight) - windowHeight);
  return Math.max(0, keyboardHeight - viewportReduction);
};

const AUTOPLAY_STORAGE_KEY_PREFIX = "video_player_autoplay";
const NEXT_NAV_THROTTLE_MS = 700;
const MAX_PLAYED_HISTORY = 80;
const INITIAL_VISIBLE_REPLIES = 3;
const SUBMITTED_REPLY_HIGHLIGHT_MS = 3200;
const EMPTY_MENTION_OVERLAY = {
  visible: false,
  suggestions: [],
  selectedUserIds: [],
  ready: false,
  top: 0,
  left: 0,
  width: 220,
  maxHeight: 0,
  onSelect: null,
};
const createOptimisticCommentId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const getCommentLikes = (comment) => {
  if (Array.isArray(comment?.videoCommentLikes)) return comment.videoCommentLikes;
  if (Array.isArray(comment?.videosCommentLikes)) return comment.videosCommentLikes;
  if (Array.isArray(comment?.videoCommentsLikes)) return comment.videoCommentsLikes;
  return [];
};

const normalizeNotificationTargetId = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const normalizeTag = (tag) => (typeof tag === "string" ? tag.trim().toLowerCase() : "");

const resolvePrimaryCategory = (video) => {
  if (!Array.isArray(video?.tags)) return null;
  const firstTag = video.tags.find((tag) => typeof tag === "string" && tag.trim().length > 0);
  return firstTag ? firstTag.trim() : null;
};

const pickRandomVideo = (videos = []) => {
  if (!Array.isArray(videos) || videos.length === 0) return null;
  const index = Math.floor(Math.random() * videos.length);
  return videos[index] || null;
};

const isUnplayedCandidate = ({ candidate, currentUri, playedSet }) =>
  Boolean(candidate?.uri) && candidate.uri !== currentUri && !playedSet.has(candidate.uri);

const hasCategoryTag = ({ candidate, normalizedCategory }) => {
  if (!normalizedCategory) return false;
  const tags = Array.isArray(candidate?.tags) ? candidate.tags : [];
  return tags.some((tag) => normalizeTag(tag) === normalizedCategory);
};

const pickUnplayedSameCategoryVideo = ({ videos, currentUri, category, playedSet }) => {
  if (!Array.isArray(videos) || videos.length === 0 || !currentUri || !category) return null;
  const normalizedCategory = normalizeTag(category);
  if (!normalizedCategory) return null;

  const matches = videos.filter(
    (candidate) => isUnplayedCandidate({ candidate, currentUri, playedSet }) && hasCategoryTag({ candidate, normalizedCategory }),
  );

  return pickRandomVideo(matches);
};

const pickRandomUnplayedDifferentCategoryVideo = ({ videos, currentUri, category, playedSet }) => {
  if (!Array.isArray(videos) || videos.length === 0 || !currentUri) return null;

  const normalizedCategory = normalizeTag(category);
  const candidates = videos.filter((candidate) => {
    if (!isUnplayedCandidate({ candidate, currentUri, playedSet })) return false;
    if (!normalizedCategory) return true;
    return !hasCategoryTag({ candidate, normalizedCategory });
  });

  return pickRandomVideo(candidates);
};

const parsePlayedHistoryParam = (raw) => {
  if (!raw || typeof raw !== "string") return [];
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  return decoded
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);
};

const appendToHistory = (history, uri) => {
  if (!uri || typeof uri !== "string") return history.slice(-MAX_PLAYED_HISTORY);
  const filtered = history.filter((item) => item !== uri);
  filtered.push(uri);
  return filtered.slice(-MAX_PLAYED_HISTORY);
};

const serializePlayedHistoryParam = (history) => {
  if (!Array.isArray(history) || history.length === 0) return undefined;
  return encodeURIComponent(history.join(","));
};

const Description = ({ item, onOpenComments, onDownloadPress, downloadStatus, downloadDisabled }) => {
  const { user } = useGlobalContext();
  const { getVideoStats, loadVideoStats } = useVideosStats();
  const { globalSettings } = useSelector((state) => state.app);
  const { theme } = useAppTheme();
  const [isFollowing, setIsFollowing] = useState(false);
  const [isLoadingFollow, setIsLoadingFollow] = useState(false);
  // Mirrors PostCard's See more / See less behavior (web uses Show more / less).
  const [descExpanded, setDescExpanded] = useState(false);

  const videoId = item?.$id;
  const notificationService = new NotificationService();

  useEffect(() => {
    if (videoId && user?.$id) loadVideoStats(videoId, user.$id);
    const fetchIsFollowing = async () => {
      const response = await FollowService.isFollowing({ followerId: user?.$id, followingId: item?.uploader?.$id });
      setIsFollowing(response);
    };

    fetchIsFollowing();
  }, [videoId, user?.$id]);

  const stats = getVideoStats(videoId);
  const likeCount = stats.videoLikes ?? item.videoStats?.totalLikes ?? 0;
  const joinedTags = Array.isArray(item?.tags) ? item.tags.filter(Boolean).join(" • ") : "";
  const postedDate = new Date(item?.$createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const handleCreatorProfilePressed = () => {
    if (user?.$id === item?.uploader?.$id) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: item?.uploader?.$id } });
  };

  const handleFollow = async () => {
    if (isLoadingFollow) return;
    setIsLoadingFollow(true);
    try {
      try {
        if (isFollowing) {
          handleCreatorProfilePressed();
        } else {
          await FollowService.followUser({ followerId: user?.$id, followingId: item?.uploader?.$id });
          setIsFollowing(true);

          // Prevent duplicate follow notifications on the same day
          const alreadyNotified = await notificationService.checkFollowNotificationExists({
            senderId: user?.$id,
            recipientId: item?.uploader?.$id,
          });

          if (!alreadyNotified) {
            notificationService.notifyUser({
              sender: user,
              recipient: item?.uploader,
              type: "follow",
              resourceId: user?.$id,
              message: `started following you`,
            });
          }
        }
      } catch (err) {
        console.error("Follow toggle failed", err);
      } finally {
        setIsLoadingFollow(false);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const isDownloaded = downloadStatus === "completed";
  const isDownloading = ["preparing", "downloading", "cancelling"].includes(downloadStatus);
  const downloadButtonLabel = isDownloading
    ? "Downloading..."
    : isDownloaded
      ? "Downloaded"
      : downloadStatus === "failed"
        ? "Retry Download"
        : "Download";

  return (
    <View className="space-y-3 px-2 py-2">
      <View className="rounded-2xl border p-3" style={{ borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row justify-between space-x-2">
          <Text className="flex-1 font-sans text-base font-bold" style={{ color: theme.text }}>
            {item.title}
          </Text>
          <StyledPlaylistButton videoId={item.uri} />
        </View>

        <View className="mt-3 flex-row items-center justify-between space-x-2">
          <TouchableOpacity onPress={handleCreatorProfilePressed} className="flex-1 flex-row items-center space-x-2">
            <View className="h-9 w-9 items-center justify-center overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
              <FastImage
                source={{ uri: item?.uploader?.avatar, priority: FastImage.priority.high }}
                style={{ height: 36, width: 36 }}
                resizeMode={FastImage.resizeMode.cover}
              />
            </View>
            <View className="flex-1">
              <View className="flex-row items-center self-start pr-2" style={{ maxWidth: "100%" }}>
                <Text className="font-sans text-sm font-semibold" numberOfLines={1} style={{ flexShrink: 1, color: theme.text }}>
                  {item?.uploader?.username || "Unknown"}
                </Text>
                <UserRoleBadgeIcons user={item?.uploader} size={16} />
              </View>
              <View className="flex-row">
                <Text className="font-sans text-[11px]" style={{ color: theme.textMuted }}>
                  {FormatNumber((likeCount || 0) * (Number(globalSettings["LIKES_MULTIPLIER"]) || 1))} {"Likes "}
                </Text>
                <Text className="font-sans text-[11px]" style={{ color: theme.textMuted }}>
                  {FormatNumber((item?.videoStats?.totalViews || 0) * (Number(globalSettings["VIEWS_MULTIPLIER"]) || 1))} {"Views "}
                </Text>
                <Text className="font-sans text-[11px]" style={{ color: theme.textSoft }} numberOfLines={1}>
                  {postedDate}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>

        <View className="mt-3 flex-row items-center">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <StyledLikeCommentShare
              following={isFollowing}
              downloaded={isDownloaded}
              handleComment={onOpenComments}
              onFollowPress={handleFollow}
              onDownloadPress={onDownloadPress}
              item={item}
              showDownloadButton
              showFollowButton
              downloading={isDownloading}
              downloadDisabled={downloadDisabled}
              downloadLabel={downloadButtonLabel}
            />
          </ScrollView>
        </View>

        {(joinedTags || item?.description) &&
          (() => {
            const description = item?.description || "No description provided.";
            const descLineCount = description.split(/\r\n|\r|\n/).length;
            const showToggle = description.length > 130 || descLineCount > 3;

            return (
              <View className="mt-3 rounded-xl p-1" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className="mb-2 font-sans text-xs font-semibold" style={{ color: theme.textMuted }}>
                  Description
                </Text>
                {joinedTags ? (
                  <Text className="mb-2 font-sans text-xs" style={{ color: theme.textSoft }}>
                    {joinedTags}
                  </Text>
                ) : null}
                <Text
                  className="font-sans text-sm leading-5"
                  style={{ color: theme.textMuted }}
                  numberOfLines={descExpanded ? undefined : 3}
                  ellipsizeMode="tail"
                  // Tap anywhere on the description to toggle — matches web.
                  onPress={showToggle ? () => setDescExpanded((prev) => !prev) : undefined}
                  suppressHighlighting
                >
                  {description}
                </Text>
                {showToggle ? (
                  <TouchableOpacity onPress={() => setDescExpanded((prev) => !prev)}>
                    <Text className="mt-1 font-sans text-sm" style={{ color: theme.primary }}>
                      {descExpanded ? "See less" : "See more"}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })()}
      </View>
    </View>
  );
};

const RecommendedVideos = React.memo(({ videos, isHidden }) => {
  const { globalSettings } = useSelector((state) => state.app);
  const { theme } = useAppTheme();
  const [filteredVideos, setFilteredVideos] = useState([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const videosService = useRef(new VideosService()).current;

  const fetchRecommendations = useCallback(async () => {
    try {
      const tempVideos = await videosService.fetchVideos({ limit: 100, status: "published" });
      setFilteredVideos(limitVideos(ShuffleVideos(tempVideos.documents), Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])));
    } catch (error) {
      console.error("fetchRecommendations error:", error?.message || error);
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, [globalSettings, videosService]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  useEffect(() => {
    setFilteredVideos((prev) =>
      prev
        .map((filteredVideo) => videos.find((video) => (filteredVideo?.$id ? video.$id === filteredVideo.$id : video.uri === filteredVideo?.uri)))
        .filter(Boolean),
    );
  }, [videos]);

  return (
    <View className={`${isHidden ? "hidden" : ""} px-2 pb-6`}>
      {/* Section header — violet sparkles chip + letter-spaced title +
          premium refresh disc. Replaces the yellow "coin star" with the
          app's primary violet so this row reads as part of the same
          system as the Books / Videos section titles. */}
      <View className="mb-2 flex-row items-center justify-between px-1 py-2">
        <View className="flex-row items-center">
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
              marginRight: 10,
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 3 },
              shadowOpacity: 0.35,
              shadowRadius: 6,
              elevation: 3,
            }}
          >
            <Ionicons name="sparkles" size={13} color={theme.primary} />
          </View>
          <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.6, textTransform: "uppercase" }}>
            Recommended
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            if (refreshing) return;
            setRefreshing(true);
            fetchRecommendations();
          }}
          className="items-center justify-center rounded-full"
          style={{
            height: 30,
            width: 30,
            backgroundColor: theme.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          {refreshing ? (
            <LoaderKit style={{ width: 14, height: 14, opacity: 0.85 }} name={"BallSpinFadeLoader"} color={theme.primary} />
          ) : (
            <MaterialIcons name="refresh" size={16} color={theme.iconMuted} />
          )}
        </TouchableOpacity>
      </View>

      {initialLoading ? (
        <View className="space-y-3 px-1 pb-3">
          {[1, 2, 3].map((i) => (
            <View key={i} className="flex-row space-x-3 rounded-2xl border p-2" style={{ borderColor: theme.border, backgroundColor: theme.card }}>
              {/* Skeleton mirrors the new 1.8× thumbnail size (212×119). */}
              <AnimatedSkeleton className="rounded-lg" style={{ width: 212, height: 119 }} />
              <View className="flex-1 space-y-2 py-1">
                <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: "88%" }} />
                <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: "64%" }} />
                <AnimatedSkeleton className="h-3 rounded-lg" style={{ width: "50%" }} />
              </View>
            </View>
          ))}
        </View>
      ) : filteredVideos.length === 0 ? (
        <View className="rounded-2xl border px-4 py-5" style={{ borderColor: theme.border, backgroundColor: theme.card }}>
          <Text className="text-center font-sans text-sm" style={{ color: theme.textSoft }}>
            No recommendations available right now.
          </Text>
        </View>
      ) : (
        <View className="space-y-2 px-1">
          {filteredVideos.map((item) => {
            if (!item?.uri) return null;

            const tagText = Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 3).join(" · ") : "";

            return (
              <TouchableOpacity
                key={item.uri}
                activeOpacity={0.85}
                onPress={() => {
                  try {
                    router.replace({
                      pathname: "video-player",
                      params: { id: item.uri, docId: item.$id, view: "RECOMMENDED" },
                    });
                  } catch (error) {
                    console.error(error);
                  }
                }}
                style={{
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: theme.card,
                  padding: 8,
                  // Subtle violet shadow lift only — dropped the right-edge
                  // violet wash that was reading as a broken gradient on
                  // light card surfaces.
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.12,
                  shadowRadius: 10,
                  elevation: 2,
                }}
              >
                <View className="flex-row" style={{ gap: 10 }}>
                  {/* Thumbnail bumped 1.8× from 118 → 212 wide for a
                      chunkier, more cinematic feel. Aspect-video keeps the
                      16:9 ratio so height grows proportionally to ~119 px. */}
                  <View
                    style={{
                      borderRadius: 12,
                      overflow: "hidden",
                      borderWidth: 1,
                      borderColor: theme.border,
                    }}
                  >
                    <FastImage
                      source={{ uri: item?.thumbnail, priority: FastImage.priority.high }}
                      className="aspect-video"
                      style={{ width: 212, backgroundColor: theme.surfaceMuted }}
                      resizeMode={FastImage.resizeMode.cover}
                    />
                  </View>
                  <View className="flex-1 justify-between" style={{ paddingVertical: 2 }}>
                    <View>
                      <Text
                        className="font-sans"
                        style={{ color: theme.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.1, lineHeight: 17 }}
                        numberOfLines={3}
                      >
                        {item?.title}
                      </Text>
                      <View className="mt-1 flex-row items-center self-start pr-2" style={{ maxWidth: "100%" }}>
                        <Text
                          className="font-sans"
                          style={{ flexShrink: 1, color: theme.textSoft, fontSize: 11, fontWeight: "500", letterSpacing: 0.1 }}
                          numberOfLines={1}
                        >
                          {item?.uploader?.username || "Unknown"}
                        </Text>
                        <UserRoleBadgeIcons user={item?.uploader} size={14} />
                      </View>
                    </View>
                    <View className="flex-col" style={{ gap: 4, marginTop: 4 }}>
                      {tagText ? (
                        <View
                          style={{
                            alignSelf: "flex-start",
                            paddingHorizontal: 6,
                            paddingVertical: 1.5,
                            borderRadius: 999,
                            backgroundColor: theme.primarySoft,
                            borderWidth: 0.5,
                            borderColor: theme.primary,
                            maxWidth: "100%",
                          }}
                        >
                          <Text
                            className="font-sans"
                            style={{ color: theme.primary, fontSize: 9, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}
                            numberOfLines={1}
                          >
                            {tagText}
                          </Text>
                        </View>
                      ) : null}
                      {/* Views · time-ago row. Same formula as VideoCardNew
                          so the displayed count matches the home/main video
                          tabs: raw totalViews × VIEWS_MULTIPLIER from
                          globalSettings (default 1). */}
                      <View className="flex-row items-center" style={{ gap: 4 }}>
                        <Ionicons name="eye-outline" size={11} color={theme.textSoft} />
                        <Text
                          className="font-sans"
                          style={{ color: theme.textSoft, fontSize: 10, fontWeight: "600", letterSpacing: 0.1 }}
                          numberOfLines={1}
                        >
                          {FormatNumber((item?.videoStats?.totalViews || 0) * (Number(globalSettings?.["VIEWS_MULTIPLIER"]) || 1))}
                          {" views"}
                        </Text>
                        <Text className="font-sans" style={{ color: theme.textSoft, fontSize: 10 }}>
                          {"·"}
                        </Text>
                        <Text
                          className="font-sans"
                          style={{ color: theme.textSoft, fontSize: 10, fontWeight: "500", letterSpacing: 0.1, flexShrink: 1 }}
                          numberOfLines={1}
                        >
                          {TimeAgo(item?.$createdAt)}
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
});

const CommentSection = React.memo(
  ({
    id,
    isHidden,
    videoDocId,
    uploader,
    focusCommentId,
    focusReplyId,
    onMentionOverlayChange,
    suppressMentionOverlay,
    onCloseComments,
    onCommentCountChange,
  }) => {
    const insets = useSafeAreaInsets();
    const { theme } = useAppTheme();
    const { user } = useGlobalContext();
    const { globalSettings } = useSelector((state) => state.app);
    const { updateVideoStats } = useVideosStats();
    const videoID = id.replace("/videos/", "");
    const [comments, setComments] = useState([]);
    const [commentsLoading, setCommentsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [replyTarget, setReplyTarget] = useState(null); // { id, username }
    const [commentText, setCommentText] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [selectedMentionUsers, setSelectedMentionUsers] = useState([]);
    const [mentionSuggestions, setMentionSuggestions] = useState([]);
    const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
    const [mentionReady, setMentionReady] = useState(false);
    const [mentionTriggerIndex, setMentionTriggerIndex] = useState(null);
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const [mentionListMaxHeight, setMentionListMaxHeight] = useState(220);
    const [mentionListTop, setMentionListTop] = useState(0);
    const [mentionListLeft, setMentionListLeft] = useState(0);
    const [mentionListWidth, setMentionListWidth] = useState(0);
    const [highlightedCommentId, setHighlightedCommentId] = useState(null);
    const [highlightedReplyId, setHighlightedReplyId] = useState(null);
    const [allowExternalFocus, setAllowExternalFocus] = useState(true);
    const [isComposerFocused, setIsComposerFocused] = useState(false);
    const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
    const [actionTarget, setActionTarget] = useState(null);
    const [isDeletingTarget, setIsDeletingTarget] = useState(false);
    const mentionTimerRef = useRef(null);
    const mentionSearchRequestIdRef = useRef(0);
    const mentionUserCacheRef = useRef(new Map());
    const selectedMentionMapRef = useRef(new Map());
    const committedMentionRangeRef = useRef(null);
    const focusHighlightTimeoutRef = useRef(null);
    const selectionRef = useRef(null);
    const composerPressInRef = useRef(false);
    const notificationService = useRef(new NotificationService()).current;
    const inputRef = useRef();
    const panelContainerRef = useRef(null);
    const composerContainerRef = useRef(null);
    const commentsScrollRef = useRef(null);
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const screenHeight = Dimensions.get("screen").height;
    const normalizedFocusCommentId = normalizeNotificationTargetId(focusCommentId);
    const normalizedFocusReplyId = normalizeNotificationTargetId(focusReplyId);
    const commentItemOffsetsRef = useRef(new Map());
    const targetScrollPendingRef = useRef(false);
    const submitScrollTargetCommentIdRef = useRef(null);
    const submitScrollRafRef = useRef(null);
    const submittedReplyHighlightTimeoutRef = useRef(null);
    const openedRepliesRef = useRef(new Set());
    const replyVisibleCountRef = useRef(new Map());
    const focusedCommentId = normalizedFocusCommentId ? String(normalizedFocusCommentId) : null;
    const focusedReplyId = normalizedFocusReplyId ? String(normalizedFocusReplyId) : null;
    const effectiveFocusCommentId = allowExternalFocus ? focusedCommentId : null;
    const effectiveFocusReplyId = allowExternalFocus ? focusedReplyId : null;
    const [composerHeight, setComposerHeight] = useState(0);
    const [panelBottomInWindow, setPanelBottomInWindow] = useState(0);
    const baseComposerBottomPadding = useMemo(() => Math.max(insets.bottom + 10, 12), [insets.bottom]);
    const [keyboardScreenTop, setKeyboardScreenTop] = useState(screenHeight);
    const keyboardTop = useMemo(() => (keyboardHeight > 0 ? keyboardScreenTop : screenHeight), [keyboardHeight, keyboardScreenTop, screenHeight]);
    const composerLift = useMemo(() => Math.max(0, panelBottomInWindow - keyboardTop), [panelBottomInWindow, keyboardTop]);
    const composerPaddingBottom = useMemo(() => {
      if (keyboardHeight <= 0) return baseComposerBottomPadding;
      return Platform.OS === "android" ? baseComposerBottomPadding : 0;
    }, [baseComposerBottomPadding, keyboardHeight]);
    const commentsListBottomPadding = useMemo(() => Math.max(20, composerHeight + composerLift + 12), [composerHeight, composerLift]);
    const totalDiscussionCount = useMemo(
      () =>
        comments.reduce((total, comment) => {
          const replyCount = Array.isArray(comment?.videoComments) ? comment.videoComments.length : 0;
          return total + 1 + replyCount;
        }, 0),
      [comments],
    );

    const updatePanelBottomInWindow = useCallback(() => {
      if (!panelContainerRef.current?.measureInWindow) return;
      panelContainerRef.current.measureInWindow((_, y, __, height) => {
        const nextBottom = y + height;
        setPanelBottomInWindow((prev) => (Math.abs(prev - nextBottom) < 1 ? prev : nextBottom));
      });
    }, []);

    const focusedTargetCommentId = useMemo(() => {
      if (!effectiveFocusCommentId && !effectiveFocusReplyId) return null;
      if (effectiveFocusCommentId) return String(effectiveFocusCommentId);

      const replyMatch = comments.find(
        (comment) =>
          Array.isArray(comment.videoComments) && comment.videoComments.some((reply) => String(reply.$id) === String(effectiveFocusReplyId)),
      );

      return replyMatch?.$id ? String(replyMatch.$id) : null;
    }, [comments, effectiveFocusCommentId, effectiveFocusReplyId]);

    const resolveReplyFocusIndex = useCallback((replyList, targetReplyId) => {
      if (!targetReplyId) return -1;
      return (replyList || []).findIndex((reply) => String(reply.$id) === targetReplyId);
    }, []);

    const normalizeMentionUsernames = useCallback((text) => extractMentionUsernames(text), []);
    const syncSelectedMentionUsers = useCallback(() => {
      const uniqueUsers = Array.from(new Map(Array.from(selectedMentionMapRef.current.values()).map((user) => [String(user.$id), user])).values());
      setSelectedMentionUsers(uniqueUsers);
    }, []);

    const cacheMentionUsers = useCallback((users = []) => {
      users.forEach((candidate) => {
        const usernameToken = normalizeMentionToken(candidate?.username);
        if (usernameToken && candidate?.$id) {
          mentionUserCacheRef.current.set(usernameToken, candidate);
        }
      });
    }, []);

    const resolveMentionedUsers = useCallback(
      async (usernames) => {
        const resolved = new Map();
        const normalizedUsernames = Array.from(new Set((usernames || []).map((username) => normalizeMentionToken(username)).filter(Boolean)));

        await Promise.all(
          normalizedUsernames.map(async (username) => {
            const cached = mentionUserCacheRef.current.get(username);
            if (cached?.$id) {
              resolved.set(cached.$id, cached);
              return;
            }

            try {
              const userDocs = await fetchUsersByQuery([Query.contains("username", username), Query.limit(20)]);
              const candidates = userDocs?.documents || [];
              const exactUsername = candidates.find((candidate) => normalizeMentionToken(candidate?.username) === username);

              if (exactUsername?.$id) {
                resolved.set(exactUsername.$id, exactUsername);
              }
            } catch (err) {
              console.log("resolveMentionedUsers: error", err);
            }
          }),
        );

        const resolvedUsers = Array.from(resolved.values());
        cacheMentionUsers(resolvedUsers);
        return resolvedUsers;
      },
      [cacheMentionUsers],
    );

    const resolveOwnerId = useCallback((owner) => {
      if (!owner) return null;
      if (typeof owner === "string") return owner;
      return owner?.$id || null;
    }, []);

    const isOwnedByCurrentUser = useCallback(
      (owner) => {
        const ownerId = resolveOwnerId(owner);
        return Boolean(user?.$id && ownerId && String(ownerId) === String(user.$id));
      },
      [resolveOwnerId, user?.$id],
    );

    const clearMentionSuggestions = useCallback(() => {
      mentionSearchRequestIdRef.current += 1;
      setShowMentionSuggestions(false);
      setMentionSuggestions([]);
      setMentionTriggerIndex(null);
      setMentionReady(false);
    }, []);

    const handleDeleteComment = useCallback(
      async (comment) => {
        const commentId = String(comment?.$id || "");
        if (!commentId || !isOwnedByCurrentUser(comment?.commentOwner)) return;

        try {
          try {
            const repliesToDelete = await databases.listDocuments(
              secrets.appwriteConfig.databaseId,
              secrets.appwriteConfig.videosCommentRepliesCollectionId,
              [Query.equal("videoComments", commentId), Query.limit(200)],
            );

            await Promise.all(
              (repliesToDelete?.documents || [])
                .filter((reply) => reply?.$id)
                .map((reply) =>
                  databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentRepliesCollectionId, reply.$id),
                ),
            );
          } catch (replyDeleteErr) {
            console.log("handleDeleteComment (replies): error", replyDeleteErr);
          }

          await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentsCollectionId, commentId);

          setComments((prev) => prev.filter((existingComment) => String(existingComment?.$id || "") !== commentId));

          if (replyTarget?.id && String(replyTarget.id) === commentId) {
            setReplyTarget(null);
            setCommentText("");
            clearMentionSuggestions();
          }

          if (videoDocId) {
            updateVideoStats(videoDocId, {
              commentsCount: Math.max(0, comments.length - 1),
            });
          }
        } catch (err) {
          console.warn("handleDeleteComment: error", err?.message || err);
          Alert.alert("Unable to delete", "Please try again.");
        }
      },
      [clearMentionSuggestions, comments.length, isOwnedByCurrentUser, replyTarget?.id, updateVideoStats, videoDocId],
    );

    const handleDeleteReply = useCallback(
      async (commentId, reply) => {
        const normalizedCommentId = String(commentId || "");
        const replyId = String(reply?.$id || "");
        if (!normalizedCommentId || !replyId || !isOwnedByCurrentUser(reply?.commentOwner)) return;

        try {
          await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentRepliesCollectionId, replyId);

          setComments((prev) =>
            prev.map((commentItem) =>
              String(commentItem?.$id || "") === normalizedCommentId
                ? {
                    ...commentItem,
                    videoComments: (commentItem?.videoComments || []).filter((existingReply) => String(existingReply?.$id || "") !== replyId),
                  }
                : commentItem,
            ),
          );
        } catch (err) {
          console.warn("handleDeleteReply: error", err?.message || err);
          Alert.alert("Unable to delete", "Please try again.");
        }
      },
      [isOwnedByCurrentUser],
    );

    const openCommentActions = useCallback(
      (comment) => {
        if (!isOwnedByCurrentUser(comment?.commentOwner)) return;
        setActionTarget({ type: "comment", comment, commentId: String(comment?.$id || "") });
        setActionsSheetVisible(true);
      },
      [isOwnedByCurrentUser],
    );

    const openReplyActions = useCallback(
      (commentId, reply) => {
        if (!isOwnedByCurrentUser(reply?.commentOwner)) return;
        setActionTarget({ type: "reply", reply, commentId: String(commentId || "") });
        setActionsSheetVisible(true);
      },
      [isOwnedByCurrentUser],
    );

    const closeActionsSheet = useCallback(() => {
      if (isDeletingTarget) return;
      setActionsSheetVisible(false);
      setActionTarget(null);
    }, [isDeletingTarget]);

    const handleConfirmDeleteAction = useCallback(async () => {
      if (!actionTarget || isDeletingTarget) return;

      setIsDeletingTarget(true);
      try {
        if (actionTarget.type === "comment") {
          await handleDeleteComment(actionTarget.comment);
        } else if (actionTarget.type === "reply") {
          await handleDeleteReply(actionTarget.commentId, actionTarget.reply);
        }
        setActionsSheetVisible(false);
        setActionTarget(null);
      } finally {
        setIsDeletingTarget(false);
      }
    }, [actionTarget, handleDeleteComment, handleDeleteReply, isDeletingTarget]);

    const resolveRecipientForNotification = useCallback(async (candidate) => {
      const candidateId = typeof candidate === "string" ? candidate : candidate?.$id;
      if (!candidateId) return null;

      if (typeof candidate === "object" && candidate?.expoPushToken) {
        return candidate;
      }

      try {
        const fullRecipient = await getUserByID({ ID: candidateId });
        if (fullRecipient?.$id) return fullRecipient;
      } catch (err) {
        console.log("resolveRecipientForNotification: error", err);
      }

      return typeof candidate === "object" ? candidate : { $id: candidateId };
    }, []);

    const notifyCommentRecipients = useCallback(
      async (text, isReply, commentId, replyId, replyRecipient, selectedMentionedUsers = []) => {
        try {
          const resolvedVideoNotificationId = videoDocId || videoID;
          if (!user?.$id || !resolvedVideoNotificationId) return;

          const notifiedIds = new Set();
          const commentNotificationResourceId = buildVideoNotificationResourceId({
            videoId: resolvedVideoNotificationId,
            commentId,
            replyId,
          });
          const ownerNotificationType = isReply ? "video-reply" : "video-comment";

          const mentionTargetsFromMarkup = extractMentionTargetsFromMarkup(text);
          const mentionUsersFromMarkup = await Promise.all(
            mentionTargetsFromMarkup.map(async ({ userId, label }) => {
              const resolvedMentionUser = await resolveRecipientForNotification(userId);
              if (!resolvedMentionUser?.$id) return null;
              return {
                ...resolvedMentionUser,
                ...(resolvedMentionUser?.username ? {} : { username: label }),
              };
            }),
          );
          const mentionedUsernames = normalizeMentionUsernames(text);
          const resolvedMentionedUsers = mentionedUsernames.length > 0 ? await resolveMentionedUsers(mentionedUsernames) : [];
          const mentionedUsersMap = new Map();
          [...(selectedMentionedUsers || []), ...mentionUsersFromMarkup, ...resolvedMentionedUsers].forEach((mentionedUser) => {
            if (!mentionedUser?.$id) return;
            mentionedUsersMap.set(mentionedUser.$id, mentionedUser);
          });
          const mentionedUsers = Array.from(mentionedUsersMap.values());
          cacheMentionUsers(mentionedUsers);
          const isUploaderMentionedInReply = isReply ? mentionedUsers.some((mentionedUser) => mentionedUser?.$id === uploader?.$id) : false;

          if (isReply) {
            const resolvedReplyRecipient = await resolveRecipientForNotification(replyRecipient);
            if (resolvedReplyRecipient?.$id && resolvedReplyRecipient.$id !== user.$id && !notifiedIds.has(resolvedReplyRecipient.$id)) {
              notifiedIds.add(resolvedReplyRecipient.$id);
              await notificationService.notifyUser({
                sender: user,
                recipient: resolvedReplyRecipient,
                type: "video-reply",
                resourceId: commentNotificationResourceId,
                message: `replied to your comment`,
              });
            }
          }

          const shouldNotifyUploader = uploader?.$id && uploader.$id !== user.$id && (!isReply || isUploaderMentionedInReply);
          if (shouldNotifyUploader && !notifiedIds.has(uploader.$id)) {
            notifiedIds.add(uploader.$id);
            await notificationService.notifyUser({
              sender: user,
              recipient: uploader,
              type: ownerNotificationType,
              resourceId: commentNotificationResourceId,
              message: `${isReply ? "replied" : "commented"} on your video`,
            });
          }

          await Promise.all(
            mentionedUsers.map((mentionedUser) => {
              if (!mentionedUser?.$id || mentionedUser.$id === user.$id || notifiedIds.has(mentionedUser.$id)) return null;

              notifiedIds.add(mentionedUser.$id);
              return notificationService.notifyUser({
                sender: user,
                recipient: mentionedUser,
                type: isReply ? "video-reply" : "video-comment",
                resourceId: commentNotificationResourceId,
                message: `${user?.username || "Someone"} mentioned you in a ${isReply ? "reply" : "comment"}`,
              });
            }),
          );
        } catch (error) {
          console.warn("notifyCommentRecipients: error", error?.message || error);
        }
      },
      [cacheMentionUsers, notificationService, resolveMentionedUsers, resolveRecipientForNotification, user, uploader, videoDocId, videoID],
    );

    const fetchComments = useCallback(async () => {
      try {
        setCommentsLoading(true);

        const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentsCollectionId, [
          Query.limit(Number(globalSettings["COMMENT_SECTION_QUERY_LIMIT"])),
          Query.equal("video", videoID),
          Query.orderDesc("$createdAt"),
        ]);

        const baseComments = res.documents || [];
        const topCommentIds = baseComments.map((comment) => comment?.$id).filter(Boolean);
        let commentsWithReplies = baseComments;

        if (topCommentIds.length > 0) {
          try {
            const [repliesResponse, likesResponse] = await Promise.all([
              fetchVideoCommentRepliesByParentIds({ parentCommentIds: topCommentIds, limit: 200 }),
              fetchVideoCommentLikesByCommentIds({ commentIds: topCommentIds, limit: 1000 }),
            ]);

            commentsWithReplies = baseComments.map((comment) => ({
              ...comment,
              videoComments: repliesResponse?.byParentId?.[comment.$id] || [],
              videoCommentLikes: likesResponse?.byCommentId?.[comment.$id] || getCommentLikes(comment),
            }));
          } catch (error) {
            console.log("fetchComments (thread hydration): error", error);
          }
        }

        setComments(commentsWithReplies);
      } catch (error) {
        logger.error("video-player", "fetchComments failed", error);
      } finally {
        setCommentsLoading(false);
        setRefreshing(false);
      }
    }, [globalSettings, videoID]);

    const handleReplyPress = (comment, mentionUser) => {
      setReplyTarget({ id: comment.$id, username: comment.commentOwner?.username, recipient: comment.commentOwner });
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();
      // Reply-on-reply: prefill the composer with @username so the reply
      // visually addresses the original reply author, while threading to the
      // top-level parent (matches web's flat-thread model).
      if (mentionUser?.username) {
        setCommentText(`@${mentionUser.username} `);
      }
      setTimeout(() => {
        scrollToCommentThread(comment?.$id, true);
        inputRef.current?.focus();
        requestAnimationFrame(scrollToComposerInput);
      }, 100);
    };

    const scrollToComposerInput = useCallback(() => {
      if (isHidden || !inputRef.current) return;

      inputRef.current.measureInWindow((_, y, __, height) => {
        const bottomOverlap = Math.max(0, y + height + 16 - keyboardTop);
        if (bottomOverlap <= 0) return;
        commentsScrollRef.current?.scrollToEnd?.({ animated: true });
      });
    }, [isHidden, keyboardTop]);

    const handleCommentComposerLayout = useCallback((event) => {
      const nextHeight = event?.nativeEvent?.layout?.height || 0;
      setComposerHeight((prev) => (Math.abs(prev - nextHeight) < 1 ? prev : nextHeight));
    }, []);

    const scrollToCommentThread = useCallback(
      (commentId, animated = true) => {
        if (!commentsScrollRef.current?.scrollTo || isHidden) return false;

        const normalizedCommentId = String(commentId || "");
        if (!normalizedCommentId) return false;

        const targetOffset = commentItemOffsetsRef.current.get(normalizedCommentId);
        if (typeof targetOffset !== "number") return false;

        commentsScrollRef.current.scrollTo({ y: Math.max(0, targetOffset - 18), animated });
        return true;
      },
      [isHidden],
    );

    const requestScrollToSubmittedComment = useCallback(
      (commentId) => {
        const normalizedCommentId = String(commentId || "");
        if (!normalizedCommentId) return;

        submitScrollTargetCommentIdRef.current = normalizedCommentId;

        if (scrollToCommentThread(normalizedCommentId, true)) {
          submitScrollTargetCommentIdRef.current = null;
          return;
        }

        if (submitScrollRafRef.current) {
          cancelAnimationFrame(submitScrollRafRef.current);
        }

        submitScrollRafRef.current = requestAnimationFrame(() => {
          submitScrollRafRef.current = null;
          const pendingTargetId = submitScrollTargetCommentIdRef.current;
          if (!pendingTargetId) return;
          if (scrollToCommentThread(pendingTargetId, true)) {
            submitScrollTargetCommentIdRef.current = null;
          }
        });
      },
      [scrollToCommentThread],
    );

    const highlightSubmittedReply = useCallback((commentId, replyId) => {
      const normalizedCommentId = String(commentId || "");
      const normalizedReplyId = String(replyId || "");
      if (!normalizedCommentId || !normalizedReplyId) return;

      setHighlightedCommentId(normalizedCommentId);
      setHighlightedReplyId(normalizedReplyId);

      if (submittedReplyHighlightTimeoutRef.current) {
        clearTimeout(submittedReplyHighlightTimeoutRef.current);
      }

      submittedReplyHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedCommentId(null);
        setHighlightedReplyId(null);
        submittedReplyHighlightTimeoutRef.current = null;
      }, SUBMITTED_REPLY_HIGHLIGHT_MS);
    }, []);

    const getActiveMention = (text, cursorPos) => {
      const cursor = Math.max(0, Math.min(text.length, cursorPos));
      const beforeCursor = text.slice(0, cursor);
      const lastAt = beforeCursor.lastIndexOf("@");

      if (lastAt === -1) return null;
      if (lastAt > 0 && /[a-zA-Z0-9._-]/.test(beforeCursor[lastAt - 1])) return null;

      const rawQuery = beforeCursor.slice(lastAt + 1);
      if (rawQuery.includes("\n")) return null;
      if (/[^a-zA-Z0-9._\-\s]/.test(rawQuery)) return null;
      const query = rawQuery.replace(/\s+/g, " ").trimStart();
      if (query.split(" ").filter(Boolean).length > 2) return null;

      return { start: lastAt, query };
    };

    const findMentionSuggestions = async (query, requestId) => {
      try {
        const normalizedQuery = String(query || "")
          .replace(/\s+/g, " ")
          .trim();
        const normalizedUsernameQuery = normalizeMentionSearchQuery(normalizedQuery);
        const mentionSearchTerms = buildMentionSearchTerms(normalizedQuery);
        const fetchByUsername = async (usernameQuery) =>
          fetchUsersByQuery([Query.contains("username", usernameQuery), Query.limit(20), Query.orderDesc("$createdAt")]);
        const fetchByName = async (nameQuery) =>
          fetchUsersByQuery([Query.contains("name", nameQuery), Query.limit(20), Query.orderDesc("$createdAt")]);

        let users = [];

        if (!normalizedUsernameQuery) {
          const result = await fetchUsersByQuery([Query.limit(20), Query.orderDesc("$createdAt")]);
          users = rankMentionCandidatesByUsername(result?.documents || [], "", user?.$id);
        } else {
          const candidates = [];
          const queryResults = await Promise.all(
            mentionSearchTerms.flatMap((searchTerm) => [fetchByUsername(searchTerm).catch(() => null), fetchByName(searchTerm).catch(() => null)]),
          );

          queryResults.forEach((result) => {
            candidates.push(...(result?.documents || []));
          });

          Array.from(mentionUserCacheRef.current.values()).forEach((candidate) => {
            candidates.push(candidate);
          });

          users = rankMentionCandidatesByUsername(candidates, normalizedUsernameQuery, user?.$id);
        }

        if (requestId !== mentionSearchRequestIdRef.current) return;
        cacheMentionUsers(users);
        setMentionSuggestions(users.slice(0, 20));
        setShowMentionSuggestions(Boolean(users.length) || !normalizedUsernameQuery);
        setMentionReady(true);
      } catch (error) {
        if (requestId !== mentionSearchRequestIdRef.current) return;
        console.log("findMentionSuggestions: error", error);
        setMentionSuggestions([]);
        setShowMentionSuggestions(false);
        setMentionReady(false);
      }
    };

    const handleSelectionChange = ({ nativeEvent: { selection } }) => {
      if (!selection) return;
      selectionRef.current = selection;

      if (!composerPressInRef.current) return;
      composerPressInRef.current = false;
      if (selection.start !== selection.end) return;

      const selectedMention = findComposerMentionAtPosition(commentText, selectedMentionUsers, selection.start);
      if (!selectedMention?.userId) return;

      inputRef.current?.blur?.();
      openMentionProfile(selectedMention.userId);
    };

    const handleComposerPressIn = useCallback(() => {
      composerPressInRef.current = true;
      requestAnimationFrame(() => {
        if (!composerPressInRef.current) return;
        composerPressInRef.current = false;

        const selection = selectionRef.current;
        if (!selection || selection.start !== selection.end) return;

        const selectedMention = findComposerMentionAtPosition(commentText, selectedMentionUsers, selection.start);
        if (!selectedMention?.userId) return;

        inputRef.current?.blur?.();
        openMentionProfile(selectedMention.userId);
      });
    }, [commentText, openMentionProfile, selectedMentionUsers]);

    const handleCommentTextChange = (text) => {
      setCommentText(text);
      let hasRemovedMention = false;
      selectedMentionMapRef.current.forEach((mentionedUser, username) => {
        const mentionLabel = sanitizeMentionLabel(mentionedUser?.username || mentionedUser?.name || "");
        if (!mentionLabel) {
          selectedMentionMapRef.current.delete(username);
          hasRemovedMention = true;
          return;
        }
        if (!hasMentionLabelInText(text, mentionLabel)) {
          selectedMentionMapRef.current.delete(username);
          hasRemovedMention = true;
        }
      });
      if (hasRemovedMention) {
        syncSelectedMentionUsers();
      }

      const cursor = typeof selectionRef.current?.start === "number" ? Math.max(0, Math.min(text.length, selectionRef.current.start)) : text.length;
      const activeMention = getActiveMention(text, cursor);

      if (mentionTimerRef.current) {
        clearTimeout(mentionTimerRef.current);
        mentionTimerRef.current = null;
      }

      const committedMentionRange = committedMentionRangeRef.current;
      if (committedMentionRange) {
        const committedSlice = text.slice(committedMentionRange.start, committedMentionRange.end);
        if (committedSlice !== committedMentionRange.token) {
          committedMentionRangeRef.current = null;
        } else if (activeMention && activeMention.start === committedMentionRange.start && cursor > committedMentionRange.end) {
          const trailingText = text.slice(committedMentionRange.end, cursor);
          if (!trailingText.includes("@")) {
            clearMentionSuggestions();
            return;
          }
        }
      }

      if (!activeMention) {
        clearMentionSuggestions();
        return;
      }

      setMentionTriggerIndex(activeMention.start);
      setShowMentionSuggestions(true);
      setMentionReady(false);
      const requestId = mentionSearchRequestIdRef.current + 1;
      mentionSearchRequestIdRef.current = requestId;

      mentionTimerRef.current = setTimeout(() => {
        findMentionSuggestions(activeMention.query, requestId);
      }, MENTION_SEARCH_DEBOUNCE_MS);
    };

    const handleMentionSelect = useCallback(
      (selectedUser) => {
        if (!selectedUser?.username || mentionTriggerIndex === null) return;

        const cursor = selectionRef.current?.start ?? commentText.length;
        const prefix = commentText.slice(0, mentionTriggerIndex);
        const suffix = commentText.slice(cursor);
        const mentionToken = normalizeMentionToken(selectedUser.username);
        const mentionLabel = sanitizeMentionLabel(selectedUser?.username || selectedUser?.name || "");
        const alreadySelected = mentionToken ? selectedMentionMapRef.current.has(mentionToken) : false;
        const alreadyMentionedInText = mentionLabel ? hasMentionLabelInText(commentText, mentionLabel) : false;
        const insertedText = alreadySelected && alreadyMentionedInText ? "" : `${selectedUser.username} `;
        const nextTextRaw = `${prefix}${insertedText}${suffix}`;
        const nextText = insertedText ? nextTextRaw : nextTextRaw.replace(/\s{2,}/g, " ");
        if (mentionToken) {
          selectedMentionMapRef.current.set(mentionToken, selectedUser);
          mentionUserCacheRef.current.set(mentionToken, selectedUser);
        }
        syncSelectedMentionUsers();
        committedMentionRangeRef.current = insertedText
          ? {
              start: prefix.length,
              end: prefix.length + insertedText.length,
              token: insertedText,
            }
          : null;
        const nextCursor = prefix.length + insertedText.length;
        selectionRef.current = {
          start: nextCursor,
          end: nextCursor,
        };
        setCommentText(nextText);
        clearMentionSuggestions();
        setTimeout(() => {
          inputRef.current?.focus();
          requestAnimationFrame(scrollToComposerInput);
        }, 0);
      },
      [commentText, mentionTriggerIndex, scrollToComposerInput, clearMentionSuggestions, syncSelectedMentionUsers],
    );

    const handleCancelReply = () => {
      setReplyTarget(null);
      setCommentText("");
      selectedMentionMapRef.current.clear();
      setSelectedMentionUsers([]);
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();
    };

    const handlePostComment = async () => {
      if (isSubmitting || !commentText.trim() || !user?.$id) return;
      inputRef.current?.blur?.();
      Keyboard.dismiss();
      setIsComposerFocused(false);
      setIsSubmitting(true);

      const trimmedCommentText = commentText.trim();
      const isReply = Boolean(replyTarget);
      const replyContext = replyTarget;
      setAllowExternalFocus(false);
      const selectedMentionedUsersSnapshot = Array.from(selectedMentionMapRef.current.values()).filter((mentionedUser) => mentionedUser?.$id);
      const persistedCommentText = serializeMentionsForStorage(trimmedCommentText, selectedMentionedUsersSnapshot);
      const optimisticCommentOwner = {
        $id: user.$id,
        username: user?.username || "You",
        avatar: user?.avatar || "",
      };
      const optimisticCreatedAt = new Date().toISOString();
      let optimisticCommentId = null;
      let optimisticReplyId = null;

      setCommentText("");
      clearMentionSuggestions();
      selectedMentionMapRef.current.clear();
      setSelectedMentionUsers([]);
      committedMentionRangeRef.current = null;
      if (isReply) {
        setReplyTarget(null);
      }

      try {
        if (replyContext) {
          optimisticReplyId = createOptimisticCommentId("temp-reply");
          const optimisticReply = {
            $id: optimisticReplyId,
            comment: persistedCommentText,
            commentOwner: optimisticCommentOwner,
            videoComments: replyContext.id,
            $createdAt: optimisticCreatedAt,
          };
          setComments((prev) =>
            prev.map((comment) =>
              String(comment?.$id || "") === String(replyContext.id)
                ? { ...comment, videoComments: [...(comment.videoComments || []), optimisticReply] }
                : comment,
            ),
          );
          requestScrollToSubmittedComment(replyContext.id);
          highlightSubmittedReply(replyContext.id, optimisticReplyId);

          const replyPayload = {
            comment: persistedCommentText,
            commentOwner: user?.$id,
            videoComments: replyContext.id,
          };

          const newReply = await databases.createDocument(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.videosCommentRepliesCollectionId,
            ID.unique(),
            replyPayload,
          );
          const hydratedReply = typeof newReply?.commentOwner === "object" ? { ...newReply } : { ...newReply, commentOwner: optimisticCommentOwner };
          highlightSubmittedReply(replyContext.id, newReply?.$id);

          setComments((prev) =>
            prev.map((comment) =>
              String(comment?.$id || "") === String(replyContext.id)
                ? {
                    ...comment,
                    videoComments: (comment.videoComments || []).map((reply) => (reply.$id === optimisticReplyId ? hydratedReply : reply)),
                  }
                : comment,
            ),
          );
          void notifyCommentRecipients(
            persistedCommentText,
            isReply,
            replyContext.id,
            newReply.$id,
            replyContext.recipient,
            selectedMentionedUsersSnapshot,
          );
        } else {
          optimisticCommentId = createOptimisticCommentId("temp-comment");
          const optimisticComment = {
            $id: optimisticCommentId,
            comment: persistedCommentText,
            commentOwner: optimisticCommentOwner,
            video: videoID,
            $createdAt: optimisticCreatedAt,
            videoComments: [],
            videoCommentLikes: [],
          };
          setComments((prev) => [optimisticComment, ...prev]);
          requestScrollToSubmittedComment(optimisticCommentId);

          const newComment = await databases.createDocument(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.videosCommentsCollectionId,
            ID.unique(),
            {
              comment: persistedCommentText,
              video: videoID,
              commentOwner: user?.$id,
            },
          );
          const hydratedComment =
            typeof newComment?.commentOwner === "object"
              ? {
                  ...newComment,
                  videoComments: Array.isArray(newComment?.videoComments) ? newComment.videoComments : [],
                  videoCommentLikes: getCommentLikes(newComment),
                }
              : { ...newComment, commentOwner: optimisticCommentOwner, videoComments: [], videoCommentLikes: [] };

          if (submitScrollTargetCommentIdRef.current && String(submitScrollTargetCommentIdRef.current) === String(optimisticCommentId)) {
            submitScrollTargetCommentIdRef.current = String(newComment?.$id || "");
          }
          setComments((prev) => prev.map((comment) => (comment.$id === optimisticCommentId ? hydratedComment : comment)));
          void notifyCommentRecipients(persistedCommentText, isReply, newComment.$id, null, null, selectedMentionedUsersSnapshot);

          if (videoDocId) {
            updateVideoStats(videoDocId, { commentsCount: comments.length + 1 });
          }
        }
      } catch (err) {
        if (optimisticReplyId && replyContext?.id) {
          if (submittedReplyHighlightTimeoutRef.current) {
            clearTimeout(submittedReplyHighlightTimeoutRef.current);
            submittedReplyHighlightTimeoutRef.current = null;
          }
          setHighlightedCommentId((prev) => (String(prev || "") === String(replyContext.id) ? null : prev));
          setHighlightedReplyId((prev) => (String(prev || "") === String(optimisticReplyId) ? null : prev));
          setComments((prev) =>
            prev.map((comment) =>
              String(comment?.$id || "") === String(replyContext.id)
                ? { ...comment, videoComments: (comment.videoComments || []).filter((reply) => reply.$id !== optimisticReplyId) }
                : comment,
            ),
          );
        }
        if (optimisticCommentId) {
          if (String(submitScrollTargetCommentIdRef.current || "") === String(optimisticCommentId)) {
            submitScrollTargetCommentIdRef.current = null;
          }
          setComments((prev) => prev.filter((comment) => comment.$id !== optimisticCommentId));
        }
        if (replyContext) setReplyTarget(replyContext);
        setCommentText(trimmedCommentText);
        console.warn("Failed to submit comment:", err?.message || err);
      } finally {
        setIsSubmitting(false);
      }
    };

    const openMentionProfile = useCallback(
      (targetUserId) => {
        if (!targetUserId) return;
        if (String(targetUserId) === String(user?.$id)) {
          router.push("/profile");
          return;
        }

        router.push({
          pathname: "/creator-profile",
          params: {
            userId: targetUserId,
          },
        });
      },
      [user?.$id],
    );

    const handleMentionPress = useCallback(
      async (username, targetUserId = null) => {
        try {
          if (targetUserId) {
            openMentionProfile(targetUserId);
            return;
          }

          const normalizedUsername = normalizeMentionToken(username);
          if (!normalizedUsername) return;
          let mentionedUser = mentionUserCacheRef.current.get(normalizedUsername);
          if (!mentionedUser?.$id) {
            const resolvedUsers = await resolveMentionedUsers([normalizedUsername]);
            mentionedUser = resolvedUsers.find((candidate) => normalizeMentionToken(candidate?.username) === normalizedUsername) || resolvedUsers[0];
          }
          if (!mentionedUser?.$id) return;

          openMentionProfile(mentionedUser.$id);
        } catch (error) {
          console.log("handleMentionPress: error", error);
        }
      },
      [openMentionProfile, resolveMentionedUsers],
    );

    const handleOpenExternalUrl = useCallback(async (url) => {
      const targetUrl = normalizeExternalUrl(url);
      if (!targetUrl) return;

      try {
        await Linking.openURL(targetUrl);
      } catch (error) {
        console.log("handleOpenExternalUrl: error", error);
      }
    }, []);

    const renderMentionText = useCallback(
      (value, className, mentionClassName, textStyle, mentionStyle) => {
        return (
          <UserMention
            variant="text"
            value={value}
            className={className}
            mentionClassName={mentionClassName}
            textStyle={textStyle}
            mentionStyle={mentionStyle}
            onMentionPress={handleMentionPress}
            onUrlPress={handleOpenExternalUrl}
          />
        );
      },
      [handleMentionPress, handleOpenExternalUrl],
    );

    const renderComposerMentionText = useMemo(() => {
      if (!commentText) return null;

      return (
        <UserMention
          variant="text"
          value={commentText}
          className="font-sans text-sm leading-5"
          mentionClassName="font-sans font-semibold"
          textStyle={{ color: theme.inputText }}
          mentionStyle={{ color: theme.accentBlue }}
          selectedMentionUsers={selectedMentionUsers}
          onMentionPress={(_username, userId) => {
            if (userId) openMentionProfile(userId);
          }}
        />
      );
    }, [commentText, openMentionProfile, selectedMentionUsers, theme.accentBlue, theme.inputText]);

    const updateMentionListHeight = useCallback(() => {
      if (!showMentionSuggestions || !inputRef.current) return;

      inputRef.current.measureInWindow((x, y, width, height) => {
        const availableAbove = Math.max(0, y - 10);
        const availableBelow = Math.max(0, keyboardTop - (y + height) - 10);
        const canPlaceAbove = availableAbove >= 60;
        const renderAbove = Platform.OS === "android" ? availableAbove > 0 : canPlaceAbove || availableBelow <= 0;
        const availableHeight = renderAbove ? availableAbove : availableBelow;

        if (availableHeight <= 0) {
          setMentionListMaxHeight(0);
          setMentionListTop(0);
          setMentionListLeft(0);
          setMentionListWidth(0);
          return;
        }

        const clamped = Math.min(220, Math.max(1, availableHeight));
        const measuredWidth = Math.max(1, width);
        const preferredWidth = Math.min(Math.max(measuredWidth, 220), windowWidth - 16);
        const left = Math.max(8, Math.min(x, windowWidth - preferredWidth - 8));
        const top = renderAbove ? Math.max(8, y - clamped - 8) : y + height + 8;

        setMentionListMaxHeight(clamped);
        setMentionListTop(top);
        setMentionListLeft(left);
        setMentionListWidth(preferredWidth);
      });
    }, [keyboardTop, showMentionSuggestions, windowWidth]);

    const scrollToFocusedComment = useCallback(() => {
      if (!focusedTargetCommentId) return;
      if (!scrollToCommentThread(focusedTargetCommentId, true)) return;
      targetScrollPendingRef.current = false;
    }, [focusedTargetCommentId, scrollToCommentThread]);

    const handleCommentItemLayout = useCallback(
      (commentId, event) => {
        const normalizedCommentId = String(commentId || "");
        if (!normalizedCommentId) return;
        const nextOffset = event?.nativeEvent?.layout?.y;
        if (typeof nextOffset !== "number") return;

        commentItemOffsetsRef.current.set(normalizedCommentId, nextOffset);
        if (submitScrollTargetCommentIdRef.current && normalizedCommentId === submitScrollTargetCommentIdRef.current) {
          if (scrollToCommentThread(normalizedCommentId, true)) {
            submitScrollTargetCommentIdRef.current = null;
          }
        }
        if (targetScrollPendingRef.current && normalizedCommentId === focusedTargetCommentId) {
          scrollToFocusedComment();
        }
      },
      [focusedTargetCommentId, scrollToCommentThread, scrollToFocusedComment],
    );

    const updateFocusHighlight = useCallback(() => {
      if (focusHighlightTimeoutRef.current) {
        clearTimeout(focusHighlightTimeoutRef.current);
        focusHighlightTimeoutRef.current = null;
      }

      if (!effectiveFocusCommentId && !effectiveFocusReplyId) {
        if (submittedReplyHighlightTimeoutRef.current) {
          targetScrollPendingRef.current = false;
          return;
        }
        setHighlightedCommentId(null);
        setHighlightedReplyId(null);
        targetScrollPendingRef.current = false;
        return;
      }

      setHighlightedCommentId(effectiveFocusCommentId);
      setHighlightedReplyId(effectiveFocusReplyId);
      targetScrollPendingRef.current = true;

      focusHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedCommentId(null);
        setHighlightedReplyId(null);
        targetScrollPendingRef.current = false;
      }, 3000);
    }, [effectiveFocusCommentId, effectiveFocusReplyId]);

    useEffect(() => {
      updateFocusHighlight();
      return () => {
        if (focusHighlightTimeoutRef.current) {
          clearTimeout(focusHighlightTimeoutRef.current);
          focusHighlightTimeoutRef.current = null;
        }
      };
    }, [updateFocusHighlight]);

    useEffect(() => {
      if (isHidden || commentsLoading || !focusedTargetCommentId) return;
      if (comments.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId))) return;

      let isCancelled = false;

      const ensureFocusedCommentLoaded = async () => {
        try {
          const focusedComment = await databases.getDocument(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.videosCommentsCollectionId,
            focusedTargetCommentId,
          );
          if (!focusedComment || isCancelled) return;

          let hydratedFocusedComment = focusedComment;
          try {
            const [repliesResult, likesResult] = await Promise.all([
              fetchVideoCommentRepliesByParentIds({ parentCommentIds: [focusedTargetCommentId], limit: 200 }),
              fetchVideoCommentLikesByCommentIds({ commentIds: [focusedTargetCommentId], limit: 1000 }),
            ]);

            hydratedFocusedComment = {
              ...focusedComment,
              videoComments: repliesResult?.byParentId?.[focusedTargetCommentId] || [],
              videoCommentLikes: likesResult?.byCommentId?.[focusedTargetCommentId] || getCommentLikes(focusedComment),
            };
          } catch (error) {
            console.log("ensureFocusedCommentLoaded: hydrate error", error);
          }

          if (isCancelled) return;

          setComments((prev) =>
            prev.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId)) ? prev : [...prev, hydratedFocusedComment],
          );
        } catch (error) {
          console.log("ensureFocusedCommentLoaded: error", error);
        }
      };

      void ensureFocusedCommentLoaded();

      return () => {
        isCancelled = true;
      };
    }, [comments, commentsLoading, focusedTargetCommentId, isHidden]);

    useEffect(() => {
      if (!effectiveFocusCommentId && !effectiveFocusReplyId) return;
      if (isHidden) return;

      const scrollTimer = setTimeout(() => {
        if (!focusedTargetCommentId) return;

        if (commentItemOffsetsRef.current.has(focusedTargetCommentId)) {
          scrollToFocusedComment();
          return;
        }

        targetScrollPendingRef.current = true;
        scrollToFocusedComment();
      }, 250);

      return () => {
        clearTimeout(scrollTimer);
        targetScrollPendingRef.current = false;
      };
    }, [comments, commentsLoading, effectiveFocusCommentId, effectiveFocusReplyId, focusedTargetCommentId, isHidden, scrollToFocusedComment]);

    useEffect(() => {
      const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
      const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

      const onShow = (event) => {
        if (event) {
          Keyboard.scheduleLayoutAnimation?.(event);
        }
        const nextKeyboardHeight = event?.endCoordinates?.height || 0;
        const nextKeyboardTop =
          typeof event?.endCoordinates?.screenY === "number" ? event.endCoordinates.screenY : Math.max(0, screenHeight - nextKeyboardHeight);
        setKeyboardHeight(nextKeyboardHeight);
        setKeyboardScreenTop(nextKeyboardTop);
        requestAnimationFrame(() => {
          updatePanelBottomInWindow();
          scrollToComposerInput();
          updateMentionListHeight();
        });
      };
      const onHide = (event) => {
        if (event) {
          Keyboard.scheduleLayoutAnimation?.(event);
        }
        setKeyboardHeight(0);
        setKeyboardScreenTop(screenHeight);
        requestAnimationFrame(updatePanelBottomInWindow);
      };

      const showSub = Keyboard.addListener(showEvent, onShow);
      const hideSub = Keyboard.addListener(hideEvent, onHide);

      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }, [screenHeight, scrollToComposerInput, updateMentionListHeight, updatePanelBottomInWindow]);

    useEffect(() => {
      requestAnimationFrame(updatePanelBottomInWindow);
    }, [keyboardHeight, updatePanelBottomInWindow, windowHeight]);

    useEffect(() => {
      if (isHidden || !isComposerFocused || keyboardHeight <= 0) return;
      requestAnimationFrame(scrollToComposerInput);
    }, [composerLift, isComposerFocused, isHidden, keyboardHeight, scrollToComposerInput]);

    useEffect(() => {
      if (!showMentionSuggestions || !isComposerFocused) return;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        updateMentionListHeight();
        if (Platform.OS !== "android") {
          scrollToComposerInput();
        }
      });
    }, [showMentionSuggestions, isComposerFocused, keyboardHeight, mentionSuggestions.length, updateMentionListHeight, scrollToComposerInput]);

    useEffect(() => {
      if (!suppressMentionOverlay) return;
      inputRef.current?.blur?.();
      setIsComposerFocused(false);
      clearMentionSuggestions();
    }, [suppressMentionOverlay, clearMentionSuggestions]);

    useEffect(() => {
      if (!isHidden) return;
      inputRef.current?.blur?.();
      setIsComposerFocused(false);
      clearMentionSuggestions();
    }, [isHidden, clearMentionSuggestions]);

    useEffect(() => {
      if (!onMentionOverlayChange) return;

      onMentionOverlayChange({
        visible: !suppressMentionOverlay && !isHidden && isComposerFocused && showMentionSuggestions && mentionListMaxHeight > 0,
        suggestions: showMentionSuggestions ? mentionSuggestions : [],
        selectedUserIds: selectedMentionUsers.map((selectedUser) => String(selectedUser?.$id || "")).filter(Boolean),
        ready: mentionReady,
        top: mentionListTop,
        left: mentionListLeft,
        width: Math.max(220, mentionListWidth),
        maxHeight: mentionListMaxHeight,
        onSelect: handleMentionSelect,
      });
    }, [
      onMentionOverlayChange,
      suppressMentionOverlay,
      isHidden,
      isComposerFocused,
      showMentionSuggestions,
      mentionSuggestions,
      selectedMentionUsers,
      mentionReady,
      mentionListTop,
      mentionListLeft,
      mentionListWidth,
      mentionListMaxHeight,
      handleMentionSelect,
    ]);

    useEffect(() => {
      return () => {
        onMentionOverlayChange?.(null);
      };
    }, [onMentionOverlayChange]);

    useEffect(() => {
      if (commentsLoading) return;
      onCommentCountChange?.(totalDiscussionCount);
    }, [commentsLoading, onCommentCountChange, totalDiscussionCount]);

    const VideoCommentItem = ({ item, onReplyPress, highlightedCommentId, highlightedReplyId }) => {
      const commentId = String(item?.$id || "");
      const [showReplies, setShowReplies] = useState(() => Boolean(commentId && openedRepliesRef.current.has(commentId)));
      const [visibleCount, setVisibleCount] = useState(() => {
        if (!commentId) return INITIAL_VISIBLE_REPLIES;
        const savedVisibleCount = replyVisibleCountRef.current.get(commentId);
        return typeof savedVisibleCount === "number" ? savedVisibleCount : INITIAL_VISIBLE_REPLIES;
      });

      const replies = Array.isArray(item.videoComments) ? item.videoComments : [];
      const likes = useMemo(() => getCommentLikes(item), [item?.videoCommentLikes, item?.videosCommentLikes, item?.videoCommentsLikes]);
      const likesSignature = useMemo(
        () =>
          likes
            .map((like) => String(like?.$id || resolveOwnerId(like?.likeOwner) || ""))
            .sort()
            .join("|"),
        [likes],
      );
      const normalizedCurrentUserId = String(user?.$id || "");
      const replyFocusIndex = resolveReplyFocusIndex(replies, effectiveFocusReplyId);
      const hasReplyFocus = replyFocusIndex !== -1 && Boolean(effectiveFocusReplyId);
      const hasCommentFocus = String(item.$id) === effectiveFocusCommentId;
      const highlightedReplyIndex = resolveReplyFocusIndex(replies, highlightedReplyId);
      const hasHighlightedReply = highlightedReplyIndex !== -1 && Boolean(highlightedReplyId);
      const isHighlightedComment = String(item.$id) === highlightedCommentId;
      const isOwnComment = isOwnedByCurrentUser(item?.commentOwner);
      const visibleReplies = showReplies ? replies.slice(0, visibleCount) : [];
      const [liked, setLiked] = useState(() => likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId));
      const [likeCount, setLikeCount] = useState(likes.length);
      const committedLikedRef = useRef(likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId));
      const committedCountRef = useRef(likes.length);
      const desiredLikedRef = useRef(committedLikedRef.current);
      const syncInFlightRef = useRef(false);
      const isMountedRef = useRef(true);
      const appliedLikesSignatureRef = useRef(likesSignature);
      useEffect(() => {
        if (!commentId) return;
        if (showReplies) {
          openedRepliesRef.current.add(commentId);
        } else {
          openedRepliesRef.current.delete(commentId);
        }
      }, [commentId, showReplies]);
      useEffect(() => {
        if (!commentId) return;
        replyVisibleCountRef.current.set(commentId, visibleCount);
      }, [commentId, visibleCount]);
      useEffect(() => {
        if (!hasCommentFocus && !hasReplyFocus && !hasHighlightedReply) return;
        setShowReplies(true);
        if (hasReplyFocus) {
          setVisibleCount(Math.max(INITIAL_VISIBLE_REPLIES, replyFocusIndex + 1));
        } else if (hasHighlightedReply) {
          setVisibleCount(Math.max(INITIAL_VISIBLE_REPLIES, highlightedReplyIndex + 1));
        } else {
          setVisibleCount(Math.max(INITIAL_VISIBLE_REPLIES, replies.length));
        }
      }, [hasCommentFocus, hasReplyFocus, hasHighlightedReply, replyFocusIndex, highlightedReplyIndex, replies.length]);

      const applyOptimisticLikeState = useCallback((nextLiked, baseLiked = committedLikedRef.current, baseCount = committedCountRef.current) => {
        const delta = nextLiked === baseLiked ? 0 : nextLiked ? 1 : -1;
        const nextCount = Math.max(0, baseCount + delta);

        setLiked(nextLiked);
        setLikeCount(nextCount);
      }, []);

      useEffect(() => {
        if (likesSignature === appliedLikesSignatureRef.current) return;

        appliedLikesSignatureRef.current = likesSignature;
        const nextLiked = likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
        const nextCount = likes.length;
        const hasPendingLocalPreference = desiredLikedRef.current !== committedLikedRef.current;

        committedLikedRef.current = nextLiked;
        committedCountRef.current = nextCount;

        if (hasPendingLocalPreference) {
          applyOptimisticLikeState(desiredLikedRef.current, nextLiked, nextCount);
          return;
        }

        desiredLikedRef.current = nextLiked;
        setLiked(nextLiked);
        setLikeCount(nextCount);
      }, [applyOptimisticLikeState, likes, likesSignature, normalizedCurrentUserId]);

      useEffect(() => {
        return () => {
          isMountedRef.current = false;
        };
      }, []);

      const syncLikeMutation = useCallback(() => {
        if (syncInFlightRef.current || !item?.$id || !normalizedCurrentUserId) return;

        syncInFlightRef.current = true;

        InteractionManager.runAfterInteractions(() => {
          const runSync = async () => {
            try {
              while (desiredLikedRef.current !== committedLikedRef.current) {
                const nextTargetLiked = desiredLikedRef.current;
                const previousCommittedLiked = committedLikedRef.current;

                if (nextTargetLiked) {
                  const existingLike = likes.find((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
                  if (!existingLike) {
                    const newLike = await createVideoCommentLike({
                      commentId: item.$id,
                      likeOwner: normalizedCurrentUserId,
                    });
                    if (!newLike) throw new Error("Video comment like not created");
                  }
                } else {
                  await removeVideoCommentLike({
                    commentId: item.$id,
                    likeOwner: normalizedCurrentUserId,
                  });
                }

                committedLikedRef.current = nextTargetLiked;
                if (nextTargetLiked !== previousCommittedLiked) {
                  committedCountRef.current = Math.max(0, committedCountRef.current + (nextTargetLiked ? 1 : -1));
                }
              }
            } catch (error) {
              logger.error("video-player", "handleLikeComment failed", error);
              desiredLikedRef.current = committedLikedRef.current;
              if (isMountedRef.current) {
                applyOptimisticLikeState(committedLikedRef.current, committedLikedRef.current, committedCountRef.current);
              }
            } finally {
              syncInFlightRef.current = false;
              if (desiredLikedRef.current !== committedLikedRef.current) {
                syncLikeMutation();
              }
            }
          };

          void runSync();
        });
      }, [applyOptimisticLikeState, item?.$id, likes, normalizedCurrentUserId]);

      const handleLikeComment = useCallback(() => {
        if (!item?.$id || !normalizedCurrentUserId) return;

        const nextDesiredLiked = !desiredLikedRef.current;
        desiredLikedRef.current = nextDesiredLiked;
        applyOptimisticLikeState(nextDesiredLiked);
        syncLikeMutation();
      }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, syncLikeMutation]);

      // Reaction overlay over the existing binary like wiring.
      const reactions = useCommentReactionState({ initialLiked: liked });

      const handleReactionTap = useCallback(() => {
        if (!item?.$id || !normalizedCurrentUserId) return;
        const wasReacted = !!reactions.userReactionKey;
        reactions.toggleTopLevelDefault();
        const targetLiked = !wasReacted;
        if (targetLiked !== desiredLikedRef.current) {
          desiredLikedRef.current = targetLiked;
          applyOptimisticLikeState(targetLiked);
          syncLikeMutation();
        }
      }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, reactions, syncLikeMutation]);

      const handlePickReactionWithSync = useCallback(
        (key) => {
          const wasTopLevel = reactions.isPickerForTopLevel;
          reactions.handlePickReaction(key);
          if (wasTopLevel && !desiredLikedRef.current) {
            desiredLikedRef.current = true;
            applyOptimisticLikeState(true);
            syncLikeMutation();
          }
        },
        [applyOptimisticLikeState, reactions, syncLikeMutation],
      );

      const handleToggleReplies = () => {
        if (!showReplies) {
          setShowReplies(true);
          setVisibleCount(INITIAL_VISIBLE_REPLIES);
        } else {
          setShowReplies(false);
          setVisibleCount(INITIAL_VISIBLE_REPLIES);
        }
      };

      const handleViewMoreReplies = () => {
        setVisibleCount((prev) => Math.min(prev + INITIAL_VISIBLE_REPLIES, replies.length));
      };

      return (
        <View className="mb-4">
          <View className="flex-row space-x-2">
            <FastImage
              source={{ uri: item?.commentOwner?.avatar || "", priority: FastImage.priority.high }}
              className="h-9 w-9 rounded-full"
              style={{ backgroundColor: theme.surfaceStrong }}
            />
            <View className="flex-1 flex-row items-start">
              <View className="flex-1">
                <View
                  className="relative rounded-[8px] px-3 py-2 pr-9"
                  style={{ backgroundColor: isHighlightedComment ? theme.primarySoft : theme.surfaceMuted }}
                >
                  <View className="flex-row items-center pr-3">
                    <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                      {item?.commentOwner?.username || "Deleted User"}
                    </Text>
                    <UserRoleBadgeIcons user={item?.commentOwner} size={16} />
                  </View>
                  {isOwnComment ? (
                    <TouchableOpacity
                      onPress={() => openCommentActions(item)}
                      hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                      className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                    >
                      <MaterialIcons name="more-vert" size={16} color={theme.iconMuted} />
                    </TouchableOpacity>
                  ) : null}
                  {renderMentionText(
                    item?.comment,
                    "mt-1 font-sans text-sm leading-5",
                    "font-sans font-semibold",
                    { color: theme.textMuted },
                    { color: theme.primary },
                  )}
                </View>

                <View className="mt-1 flex-row items-center px-1" style={{ gap: 12 }}>
                  <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                    {TimeAgo(item?.$createdAt)}
                  </Text>
                  <TouchableOpacity
                    ref={reactions.likeButtonRef}
                    onPress={handleReactionTap}
                    onLongPress={reactions.openTopLevelPicker}
                    delayLongPress={220}
                    disabled={!normalizedCurrentUserId}
                    hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                    style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                  >
                    {reactions.activeReaction ? (
                      <Text style={{ fontSize: 13, lineHeight: 16 }}>{reactions.activeReaction.emoji}</Text>
                    ) : (
                      <Text className="font-sans text-xs font-semibold" style={{ color: theme.textSoft }}>
                        React
                      </Text>
                    )}
                    {likeCount > 0 ? (
                      <Text className="font-sans text-xs font-semibold" style={{ color: reactions.activeReaction ? theme.like : theme.textSoft }}>
                        {likeCount}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onReplyPress(item)}>
                    {/* "Reply" promoted to violet primary so it lives in the
                        same accent system as the rest of the surface. Was
                        accentBlue, which read as a different design language. */}
                    <Text className="font-sans text-xs font-bold" style={{ color: theme.primary, letterSpacing: 0.3 }}>
                      Reply
                    </Text>
                  </TouchableOpacity>
                </View>

                {replies.length > 0 && (
                  <View className="mt-3 border-l pl-3" style={{ borderLeftColor: `${theme.primary}40` }}>
                    {!showReplies ? (
                      <TouchableOpacity onPress={handleToggleReplies}>
                        {/* "View N replies" — violet bold so it reads as an
                            interactive affordance, not body copy. */}
                        <Text className="font-sans text-xs font-bold" style={{ color: theme.primary, letterSpacing: 0.3 }}>
                          View {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <>
                        {visibleReplies.map((reply) => (
                          <View key={reply.$id} className="mb-3 flex-row space-x-2">
                            <FastImage
                              source={{ uri: reply?.commentOwner?.avatar || "", priority: FastImage.priority.high }}
                              className="h-7 w-7 rounded-full"
                              style={{ backgroundColor: theme.surfaceStrong }}
                            />

                            <View className="flex-1">
                              <View
                                className="relative rounded-[8px] px-2.5 py-2 pr-8"
                                style={{ backgroundColor: String(reply.$id) === highlightedReplyId ? theme.primarySoft : theme.cardStrong }}
                              >
                                <View className="flex-row items-center pr-2">
                                  <Text className="pr-2 font-sans text-xs font-semibold" style={{ color: theme.text }}>
                                    {reply?.commentOwner?.username || "Deleted User"}
                                  </Text>
                                  <UserRoleBadgeIcons user={reply?.commentOwner} size={16} />
                                </View>
                                {isOwnedByCurrentUser(reply?.commentOwner) ? (
                                  <TouchableOpacity
                                    onPress={() => openReplyActions(item?.$id, reply)}
                                    hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                                    className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                                  >
                                    <MaterialIcons name="more-vert" size={15} color={theme.iconMuted} />
                                  </TouchableOpacity>
                                ) : null}
                                {renderMentionText(
                                  reply?.comment,
                                  "mt-0.5 font-sans text-xs leading-5",
                                  "font-sans font-semibold",
                                  { color: theme.textMuted },
                                  { color: theme.primary },
                                )}
                              </View>
                              <View className="mt-1 flex-row items-center px-1" style={{ gap: 12 }}>
                                <Text className="font-sans text-[11px]" style={{ color: theme.textSoft }}>
                                  {TimeAgo(reply?.$createdAt)}
                                </Text>
                                <TouchableOpacity
                                  ref={(el) => reactions.registerReplyButton(reply.$id, el)}
                                  onPress={() => reactions.toggleReplyDefault(reply.$id)}
                                  onLongPress={() => reactions.openReplyPicker(reply.$id)}
                                  delayLongPress={220}
                                  disabled={!normalizedCurrentUserId}
                                  hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                                  style={{ flexDirection: "row", alignItems: "center" }}
                                >
                                  {reactions.getReplyReaction(reply.$id) ? (
                                    <Text style={{ fontSize: 13, lineHeight: 16 }}>{reactions.getReplyReaction(reply.$id).emoji}</Text>
                                  ) : (
                                    <Text className="font-sans text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                                      React
                                    </Text>
                                  )}
                                </TouchableOpacity>
                                {normalizedCurrentUserId ? (
                                  <TouchableOpacity
                                    onPress={() => onReplyPress(item, reply?.commentOwner)}
                                    hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                                  >
                                    <Text className="font-sans text-[11px] font-semibold" style={{ color: theme.accentBlue }}>
                                      Reply
                                    </Text>
                                  </TouchableOpacity>
                                ) : null}
                              </View>
                            </View>
                          </View>
                        ))}

                        {visibleCount < replies.length && (
                          <TouchableOpacity onPress={handleViewMoreReplies}>
                            <Text className="font-sans text-xs" style={{ color: theme.textSubtle }}>
                              View {Math.min(INITIAL_VISIBLE_REPLIES, replies.length - visibleCount)} more{" "}
                              {replies.length - visibleCount === 1 ? "reply" : "replies"}
                            </Text>
                          </TouchableOpacity>
                        )}

                        <TouchableOpacity onPress={handleToggleReplies} className="mt-1">
                          <Text className="font-sans text-xs" style={{ color: theme.textSubtle }}>
                            Hide replies
                          </Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                )}
              </View>
            </View>
          </View>

          <ReactionPicker
            visible={reactions.pickerVisible}
            anchor={reactions.pickerAnchor}
            activeKey={reactions.pickerActiveKey}
            onSelect={handlePickReactionWithSync}
            onClose={reactions.closePicker}
          />
        </View>
      );
    };

    useEffect(() => {
      if (!focusedCommentId && !focusedReplyId) return;
      setAllowExternalFocus(true);
    }, [focusedCommentId, focusedReplyId]);

    useEffect(() => {
      setReplyTarget(null);
      setCommentText("");
      selectedMentionMapRef.current.clear();
      setSelectedMentionUsers([]);
      committedMentionRangeRef.current = null;
      setAllowExternalFocus(Boolean(focusedCommentId || focusedReplyId));
      commentItemOffsetsRef.current.clear();
      submitScrollTargetCommentIdRef.current = null;
      openedRepliesRef.current.clear();
      replyVisibleCountRef.current.clear();
      if (submitScrollRafRef.current) {
        cancelAnimationFrame(submitScrollRafRef.current);
        submitScrollRafRef.current = null;
      }
      if (submittedReplyHighlightTimeoutRef.current) {
        clearTimeout(submittedReplyHighlightTimeoutRef.current);
        submittedReplyHighlightTimeoutRef.current = null;
      }
      setHighlightedCommentId(null);
      setHighlightedReplyId(null);
      commentsScrollRef.current?.scrollTo?.({ y: 0, animated: false });
      clearMentionSuggestions();
      fetchComments();
    }, [videoID, fetchComments, clearMentionSuggestions, focusedCommentId, focusedReplyId]);

    useEffect(() => {
      return () => {
        if (mentionTimerRef.current) {
          clearTimeout(mentionTimerRef.current);
        }
        if (submitScrollRafRef.current) {
          cancelAnimationFrame(submitScrollRafRef.current);
          submitScrollRafRef.current = null;
        }
        if (submittedReplyHighlightTimeoutRef.current) {
          clearTimeout(submittedReplyHighlightTimeoutRef.current);
          submittedReplyHighlightTimeoutRef.current = null;
        }
      };
    }, []);

    return (
      <View
        ref={panelContainerRef}
        className={`${isHidden ? "hidden" : ""} relative flex-1 overflow-hidden rounded-t-[28px] border-t`}
        style={{ borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
        onLayout={updatePanelBottomInWindow}
      >
        {/* Header — premium violet chip + uppercase letter-spaced "COMMENTS"
            label + count badge. Same accent system as the Library / Recommended
            section headers. The handle pill is dropped because this surface
            isn't a draggable sheet — it's a pinned panel with its own close
            affordance. */}
        <View className="px-4 pb-3 pt-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center" style={{ flex: 1 }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.primarySoft,
                  borderWidth: 1,
                  borderColor: theme.primary,
                  marginRight: 10,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.3,
                  shadowRadius: 6,
                  elevation: 3,
                }}
              >
                <Ionicons name="chatbubble-ellipses" size={14} color={theme.primary} />
              </View>
              <View className="flex-1">
                <Text className="font-psemibold" style={{ color: theme.text, fontSize: 12, letterSpacing: 1.6, textTransform: "uppercase" }}>
                  Comments
                </Text>
                <Text className="font-sans" style={{ color: theme.textSoft, fontSize: 11, letterSpacing: 0.2, marginTop: 1 }} numberOfLines={1}>
                  {commentsLoading
                    ? "Loading conversation…"
                    : totalDiscussionCount === 1
                      ? "1 comment"
                      : `${FormatNumber(totalDiscussionCount)} comments`}
                </Text>
              </View>
            </View>

            <View className="flex-row items-center" style={{ gap: 6 }}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  if (refreshing) return;
                  setRefreshing(true);
                  fetchComments();
                }}
                accessibilityLabel="Refresh comments"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: theme.border,
                }}
              >
                {refreshing ? (
                  <LoaderKit style={{ width: 14, height: 14, opacity: 0.85 }} name={"BallSpinFadeLoader"} color={theme.primary} />
                ) : (
                  <MaterialIcons name="refresh" size={16} color={theme.iconMuted} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={onCloseComments}
                accessibilityLabel="Close comments"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: theme.border,
                }}
              >
                <MaterialIcons name="close" size={16} color={theme.iconMuted} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <ScrollView
          ref={commentsScrollRef}
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingTop: 4,
            paddingBottom: commentsListBottomPadding,
            flexGrow: commentsLoading || comments.length === 0 ? 1 : 0,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
        >
          {commentsLoading ? (
            <View className="flex-1 items-center justify-center py-10">
              <LoaderKit style={{ width: 40, height: 40, opacity: 0.4 }} name={"BallTrianglePath"} color={theme.primary} />
            </View>
          ) : comments.length === 0 ? (
            // Premium empty state — violet chip + headline + nudge to type.
            // Same language as the Library / From-Creators-You-Follow empties.
            <View className="flex-1 items-center justify-center px-6 py-10">
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.primarySoft,
                  borderWidth: 1,
                  borderColor: theme.primary,
                  marginBottom: 14,
                }}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={24} color={theme.primary} />
              </View>
              <Text className="font-bold" style={{ color: theme.text, fontSize: 15, letterSpacing: 0.2 }}>
                Start the conversation
              </Text>
              <Text className="mt-1.5 max-w-[260px] text-center" style={{ color: theme.textSoft, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 }}>
                No comments yet — be the first to share your thoughts on this video.
              </Text>
            </View>
          ) : (
            <View className="space-y-2 pb-2">
              {comments.map((item) => {
                const commentId = item?.$id;
                if (!commentId) return null;
                return (
                  <View key={commentId} onLayout={(event) => handleCommentItemLayout(commentId, event)}>
                    <VideoCommentItem
                      item={item}
                      onReplyPress={handleReplyPress}
                      highlightedCommentId={highlightedCommentId}
                      highlightedReplyId={highlightedReplyId}
                    />
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>

        <View
          ref={composerContainerRef}
          className="border-t px-3 pt-3"
          style={{
            backgroundColor: theme.surfaceElevated,
            borderTopColor: theme.border,
            position: "absolute",
            left: 0,
            right: 0,
            bottom: composerLift,
            overflow: "visible",
            paddingBottom: composerPaddingBottom,
            zIndex: 20,
            elevation: 20,
          }}
          onLayout={handleCommentComposerLayout}
        >
          {replyTarget ? (
            // Reply target chip — uses violet primary instead of the previous
            // blue so the composer reads as part of the same accent system as
            // the rest of the surface.
            <View
              className="mb-3 flex-row items-center justify-between rounded-2xl"
              style={{
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderWidth: 1,
                borderColor: theme.primary,
                backgroundColor: theme.primarySoft,
              }}
            >
              <View className="flex-row items-center" style={{ flex: 1 }}>
                <Ionicons name="return-down-forward" size={13} color={theme.primary} style={{ marginRight: 6 }} />
                <Text className="font-medium" style={{ color: theme.text, fontSize: 12, letterSpacing: 0.1 }} numberOfLines={1}>
                  Replying to <Text style={{ color: theme.primary, fontWeight: "700" }}>{replyTarget.username}</Text>
                </Text>
              </View>
              <TouchableOpacity onPress={handleCancelReply} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Cancel reply">
                <Text className="font-bold" style={{ color: theme.primary, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase" }}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View className="flex-row items-end" style={{ gap: 10 }}>
            {/* Composer wrapper — gains a violet 1.5px ring when focused so
                the input clearly signals "you're typing here" without being
                noisy when blurred. Background stays at theme.inputBackground
                in either state. */}
            <View
              className="flex-1 rounded-3xl"
              style={{
                paddingHorizontal: 16,
                paddingVertical: 9,
                borderWidth: isComposerFocused ? 1.5 : 1,
                borderColor: isComposerFocused ? theme.primary : theme.inputBorder,
                backgroundColor: theme.inputBackground,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: isComposerFocused ? 0.18 : 0,
                shadowRadius: 8,
                elevation: isComposerFocused ? 2 : 0,
              }}
            >
              <TextInput
                ref={inputRef}
                onPressIn={handleComposerPressIn}
                multiline
                textAlignVertical="top"
                onChangeText={handleCommentTextChange}
                onSelectionChange={handleSelectionChange}
                onFocus={() => {
                  setIsComposerFocused(true);
                  requestAnimationFrame(() => {
                    updateMentionListHeight();
                    scrollToComposerInput();
                  });
                }}
                onBlur={() => {
                  setTimeout(() => {
                    if (inputRef.current?.isFocused?.()) return;
                    setIsComposerFocused(false);
                    clearMentionSuggestions();
                  }, 40);
                }}
                placeholder={replyTarget ? "Write a reply…" : "Add a comment…"}
                placeholderTextColor={theme.placeholder}
                selectionColor={theme.primary}
                className="font-sans"
                style={{
                  maxHeight: 112,
                  minHeight: 22,
                  fontSize: 14,
                  lineHeight: 20,
                  color: theme.inputText,
                  letterSpacing: 0.1,
                }}
              >
                {renderComposerMentionText}
              </TextInput>
            </View>

            {/* Send button — premium violet pill with shadow lift when there's
                content to post. Disabled state stays muted so the button
                doesn't beg for taps on an empty input. */}
            <TouchableOpacity
              disabled={isSubmitting || !commentText.trim()}
              accessibilityLabel="Post comment"
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: isSubmitting ? theme.surfaceStrong : commentText.trim() ? theme.primary : theme.surfaceMuted,
                borderWidth: commentText.trim() ? 0 : 1,
                borderColor: theme.border,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: commentText.trim() && !isSubmitting ? 0.35 : 0,
                shadowRadius: 10,
                elevation: commentText.trim() && !isSubmitting ? 5 : 0,
              }}
              activeOpacity={0.85}
              onPress={handlePostComment}
            >
              {isSubmitting ? (
                <LoaderKit style={{ width: 14, height: 14, opacity: 0.9 }} name={"BallSpinFadeLoader"} color={theme.primaryContrast} />
              ) : (
                <Ionicons name="send" size={17} color={commentText.trim() ? theme.primaryContrast : theme.iconMuted} style={{ marginLeft: -1 }} />
              )}
            </TouchableOpacity>
          </View>
        </View>

        <Modal
          isVisible={actionsSheetVisible}
          onBackdropPress={closeActionsSheet}
          onBackButtonPress={closeActionsSheet}
          backdropOpacity={0.6}
          useNativeDriver
        >
          <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
            <Text className="text-lg font-semibold" style={{ color: theme.text }}>
              {actionTarget?.type === "reply" ? "Reply actions" : "Comment actions"}
            </Text>

            <TouchableOpacity
              className={`mt-4 rounded-xl px-4 py-3 ${isDeletingTarget ? "opacity-60" : ""}`}
              style={{ backgroundColor: theme.cardStrong }}
              onPress={handleConfirmDeleteAction}
              disabled={isDeletingTarget}
            >
              <View className="flex flex-row items-center justify-between">
                <View className="flex flex-row items-center">
                  <MaterialIcons name="delete-outline" size={22} color={theme.danger} style={{ marginRight: 12 }} />
                  <View>
                    <Text className="text-base font-semibold" style={{ color: theme.text }}>
                      Delete
                    </Text>
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      {actionTarget?.type === "reply" ? "Remove this reply" : "Remove this comment"}
                    </Text>
                  </View>
                </View>
                {isDeletingTarget ? (
                  <LoaderKit style={{ width: 16, height: 16, opacity: 0.9 }} name={"BallSpinFadeLoader"} color={theme.primary} />
                ) : null}
              </View>
            </TouchableOpacity>

            <TouchableOpacity className="mt-3 items-center" onPress={closeActionsSheet} disabled={isDeletingTarget}>
              <Text className="text-sm" style={{ color: theme.textSoft }}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </Modal>
      </View>
    );
  },
);

const VideoPlayerSkeleton = React.memo(() => (
  <View className="flex-1">
    <AnimatedSkeleton className="mx-2 aspect-video rounded-lg" />
    <View className="space-y-3 p-3">
      <AnimatedSkeleton className="h-5 rounded-lg" style={{ width: "82%" }} />
      <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: "60%" }} />
      <View className="flex-row gap-2">
        <AnimatedSkeleton className="h-6 flex-1 rounded-lg" />
        <AnimatedSkeleton className="h-6 flex-1 rounded-lg" />
      </View>
    </View>
    <View className="mt-2 space-y-2 px-2">
      {[1, 2, 3].map((i) => (
        <View key={i} className="flex-row items-center space-x-3 rounded-xl p-2">
          <AnimatedSkeleton className="h-16 w-28 rounded-lg" />
          <View className="flex-1 space-y-2">
            <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: "80%" }} />
            <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: "60%" }} />
          </View>
        </View>
      ))}
    </View>
  </View>
));

const VideoPlayer = () => {
  const params = useLocalSearchParams();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const screenHeight = Dimensions.get("screen").height;
  const { id, view, startAt, played, docId, localUri, focusCommentId, focusReplyId, playlistUris, playlistIndex } = params;
  const currentVideoUri = Array.isArray(id) ? id[0] : id;
  const currentVideoDocId = Array.isArray(docId) ? docId[0] : docId;
  const localVideoUriParam = Array.isArray(localUri) ? localUri[0] : localUri;
  const viewParam = Array.isArray(view) ? view[0] : view;
  const playedParam = Array.isArray(played) ? played[0] : played;
  const focusCommentIdParam = normalizeNotificationTargetId(focusCommentId);
  const focusReplyIdParam = normalizeNotificationTargetId(focusReplyId);
  // Playlist-context params — set by VideosPlaylist when a row is tapped. When
  // present, we override the category-similarity nextVideo resolver below with
  // the next URI in the queue so auto-advance follows the user's saved order.
  const playlistUrisParam = Array.isArray(playlistUris) ? playlistUris[0] : playlistUris;
  const playlistIndexParam = Array.isArray(playlistIndex) ? playlistIndex[0] : playlistIndex;
  const playlistQueue = useMemo(() => {
    if (!playlistUrisParam || typeof playlistUrisParam !== "string") return null;
    const uris = playlistUrisParam
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (uris.length === 0) return null;
    const idx = Number(playlistIndexParam);
    return { uris, index: Number.isFinite(idx) ? idx : 0 };
  }, [playlistIndexParam, playlistUrisParam]);
  const shouldOpenCommentsFromNotification = Boolean(focusCommentIdParam || focusReplyIdParam);
  const currentVideoIdentityKey = currentVideoDocId || currentVideoUri;

  const { user, refetchBalance, allVideos, balance, starsData, refetchStars, setStarsData } = useGlobalContext();
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const { globalSettings } = useSelector((state) => state.app);
  const downloadSettings = useSelector((state) => state.videos.downloadSettings);
  const isOffline = useIsOffline();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isUploader, setIsUploader] = useState(false);
  const [isWatchWithAds, setIsWatchWithAds] = useState(false);
  const [isEnabledFeatures, setIsEnabledFeatures] = useState(false);
  const [displayComp, setDisplayComp] = useState(shouldOpenCommentsFromNotification ? "COMMENTS" : viewParam || "RECOMMENDED");
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [autoplayToastVisible, setAutoplayToastVisible] = useState(false);
  const [autoplayToastOn, setAutoplayToastOn] = useState(false);
  const [nextVideo, setNextVideo] = useState(null);
  const [nextVideoLoading, setNextVideoLoading] = useState(false);
  const [nextActionLoading, setNextActionLoading] = useState(false);
  const [unlockStatusReady, setUnlockStatusReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [coinDeduction, setCoinDeduction] = useState(null);
  const [lockedProgressVisible, setLockedProgressVisible] = useState(false);
  const [lockedProgress, setLockedProgress] = useState({ current: 0, duration: 0 });
  const [showResumeUnlockModal, setShowResumeUnlockModal] = useState(false);

  // Coin store overlay
  const [showCoinOverlay, setShowCoinOverlay] = useState(false);
  const [coinPacks, setCoinPacks] = useState([]);
  const [coinOverlayLoading, setCoinOverlayLoading] = useState(false);
  const [downloadConfirmationVisible, setDownloadConfirmationVisible] = useState(false);
  const [downloadConfirmationLocked, setDownloadConfirmationLocked] = useState(false);
  const [downloadQualityPickerVisible, setDownloadQualityPickerVisible] = useState(false);
  const [downloadQualityPickerOptions, setDownloadQualityPickerOptions] = useState([]);
  const [mentionOverlay, setMentionOverlay] = useState(EMPTY_MENTION_OVERLAY);
  const [screenOverlayOrigin, setScreenOverlayOrigin] = useState({ x: 0, y: 0 });
  const [screenKeyboardHeight, setScreenKeyboardHeight] = useState(0);
  const [commentTabCount, setCommentTabCount] = useState(() => resolveVideoCommentCount(video) ?? 0);
  const [androidNativeControlsReady, setAndroidNativeControlsReady] = useState(Platform.OS !== "android");

  const firstLoad = useRef(true);
  const interval = useRef(null);
  const videoUnlockService = useRef(new VideoUnlocksService()).current;

  const videoViewRef = useRef(null);
  const playerRef = useRef(null);
  const videoPlayerContainerRef = useRef(null);

  const lockedProgressTimeoutRef = useRef(null);
  const resumeUnlockDismissedRef = useRef(false);
  const navigatingToNextRef = useRef(false);
  const nextTapGuardRef = useRef({ locked: false, lastAt: 0 });
  const autoplayToastTimeoutRef = useRef(null);
  const autoplayToastOpacity = useRef(new Animated.Value(0)).current;
  const autoplayToastTranslateY = useRef(new Animated.Value(6)).current;
  const playerHeightAnim = useRef(new Animated.Value(Dimensions.get("window").width * (9 / 16))).current;
  const keyboardClosedWindowHeightRef = useRef(windowHeight);
  const isScreenFocusedRef = useRef(false);
  const isMountedRef = useRef(true);
  const pendingPlayRef = useRef(false);
  const shouldResumeOnActiveRef = useRef(false);
  const appStateRef = useRef(AppState.currentState ?? "active");
  const manualPauseRef = useRef(false);
  const lastManualPauseAtRef = useRef(0);
  const lastPlayingAtRef = useRef(0);
  const pauseRequestedRef = useRef(false);
  const lastKnownPlayingRef = useRef(false);
  const downloadConfirmationResolverRef = useRef(null);
  const downloadQualityPickerResolverRef = useRef(null);
  const videoScrollRef = useRef(null);
  const androidControlsTimerRef = useRef(null);
  const screenContainerRef = useRef(null);
  const mentionOverlaySuppressed = showCoinOverlay;

  const handleMentionOverlayChange = useCallback(
    (nextOverlay) => {
      if (mentionOverlaySuppressed) {
        setMentionOverlay(EMPTY_MENTION_OVERLAY);
        return;
      }

      setMentionOverlay((prev) => {
        const resolved = nextOverlay ? { ...EMPTY_MENTION_OVERLAY, ...nextOverlay } : EMPTY_MENTION_OVERLAY;
        const hasSamePosition =
          prev.top === resolved.top && prev.left === resolved.left && prev.width === resolved.width && prev.maxHeight === resolved.maxHeight;
        const hasSameFlags = prev.visible === resolved.visible && prev.ready === resolved.ready;
        const previousSelectedUsers = Array.isArray(prev.selectedUserIds) ? prev.selectedUserIds.join(",") : "";
        const nextSelectedUsers = Array.isArray(resolved.selectedUserIds) ? resolved.selectedUserIds.join(",") : "";
        const hasSameData =
          prev.suggestions === resolved.suggestions && prev.onSelect === resolved.onSelect && previousSelectedUsers === nextSelectedUsers;
        return hasSamePosition && hasSameFlags && hasSameData ? prev : resolved;
      });
    },
    [mentionOverlaySuppressed],
  );

  const updateScreenOverlayOrigin = useCallback(() => {
    if (!screenContainerRef.current?.measureInWindow) return;
    screenContainerRef.current.measureInWindow((x, y) => {
      setScreenOverlayOrigin((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
    });
  }, []);

  useEffect(() => {
    if (shouldOpenCommentsFromNotification) {
      setDisplayComp("COMMENTS");
      return;
    }
    if (viewParam) setDisplayComp(viewParam);
  }, [shouldOpenCommentsFromNotification, viewParam]);

  useEffect(() => {
    setCommentTabCount(resolveVideoCommentCount(video) ?? 0);
  }, [video]);

  useEffect(() => {
    requestAnimationFrame(() => {
      updateScreenOverlayOrigin();
    });
  }, [updateScreenOverlayOrigin, video?.$id]);

  useEffect(() => {
    if (!mentionOverlaySuppressed) return;
    Keyboard.dismiss();
    setMentionOverlay(EMPTY_MENTION_OVERLAY);
  }, [mentionOverlaySuppressed]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (event) => {
      setScreenKeyboardHeight(event?.endCoordinates?.height || 0);
    };
    const onHide = () => {
      setScreenKeyboardHeight(0);
    };

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (screenKeyboardHeight > 0 || windowHeight <= 0) return;
    keyboardClosedWindowHeightRef.current = windowHeight;
  }, [screenKeyboardHeight, windowHeight]);

  const videosService = useRef(new VideosService()).current;

  const productionID = Platform.OS === "android" ? globalSettings["ANDROID_INTERSTITIAL_PROD_ID"] : globalSettings["IOS_INTERSTITIAL_PROD_ID"];
  const adUnitID = __DEV__ ? TestIds.INTERSTITIAL : productionID;
  const interstitial = useMemo(() => {
    if (!adUnitID) return null;
    try {
      return InterstitialAd.createForAdRequest(adUnitID);
    } catch {
      return null;
    }
  }, [adUnitID]);

  const monetizationActive = video?.monetization_enabled && !isUploader;
  const canControlPlayer = !monetizationActive || isUnlocked;
  const unlockTimeSeconds = useMemo(() => {
    const parsed = Number(globalSettings?.["VIDEO_UNLOCK_TIME"]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
  }, [globalSettings]);
  const unlockTimeDisplay = useMemo(() => formatTimecode(unlockTimeSeconds), [unlockTimeSeconds]);
  const startAtSeconds = useMemo(() => {
    const raw = Array.isArray(startAt) ? startAt[0] : startAt;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }, [startAt]);
  const startAtAfterUnlock = useMemo(() => startAtSeconds !== null && startAtSeconds >= unlockTimeSeconds, [startAtSeconds, unlockTimeSeconds]);
  const resumeTimeDisplay = useMemo(() => (startAtSeconds !== null ? formatTimecode(startAtSeconds) : null), [startAtSeconds]);
  const manualUnlockRequired = useMemo(
    () => monetizationActive && startAtAfterUnlock && !isUnlocked,
    [monetizationActive, startAtAfterUnlock, isUnlocked],
  );
  const lockedProgressPercent = useMemo(() => {
    const duration = lockedProgress.duration || unlockTimeSeconds || 1;
    return Math.min(100, Math.max(0, (lockedProgress.current / duration) * 100));
  }, [lockedProgress, unlockTimeSeconds]);
  const autoplayStorageKey = useMemo(() => `${AUTOPLAY_STORAGE_KEY_PREFIX}:${user?.$id || "guest"}`, [user?.$id]);
  const primaryCategory = useMemo(() => resolvePrimaryCategory(video), [video?.tags]);
  const effectiveVideoUri = video?.uri || currentVideoUri;
  const playedHistory = useMemo(() => parsePlayedHistoryParam(playedParam), [playedParam]);
  const effectivePlayedHistory = useMemo(() => appendToHistory(playedHistory, effectiveVideoUri), [playedHistory, effectiveVideoUri]);
  const playedUriSet = useMemo(() => new Set(effectivePlayedHistory), [effectivePlayedHistory]);
  const canTryNext = useMemo(() => Boolean(nextVideo?.uri), [nextVideo?.uri]);
  const currentDownloadId = useMemo(() => getVideoDownloadId(video), [video]);
  const currentVideoDownloadStatus = useSelector((state) => {
    if (!currentDownloadId) return null;
    const activeEntry = (state?.videos?.videoDownloads || []).find((entry) => entry?.id === currentDownloadId);
    if (activeEntry?.status) return activeEntry.status;
    const persistedEntry = (state?.videos?.downloadedVideos || []).find(
      (entry) => entry?.id === currentDownloadId || entry?.videoId === video?.$id || entry?.video?.$id === video?.$id,
    );
    return persistedEntry?.status || null;
  });
  const playbackLocalDownloadEntry = useSelector((state) => {
    const activeEntries = state?.videos?.videoDownloads || [];
    const persistedEntries = state?.videos?.downloadedVideos || [];
    const allEntries = [...activeEntries, ...persistedEntries];
    return (
      allEntries.find((entry) => {
        if (entry?.status !== "completed" || !entry?.video) return false;
        if (currentVideoDocId && entry.video.$id !== currentVideoDocId && entry.id !== currentVideoDocId) return false;
        if (localVideoUriParam && (entry.localUri === localVideoUriParam || entry.manifestUri === localVideoUriParam)) return true;
        return (
          entry.video.$id === currentVideoDocId ||
          entry.video.uri === currentVideoUri ||
          entry.id === currentVideoDocId ||
          entry.id === currentVideoUri
        );
      }) || null
    );
  });
  const isCurrentVideoDownloading = ["preparing", "downloading", "cancelling"].includes(currentVideoDownloadStatus);
  const downloadUnlockCost = useMemo(() => {
    const parsed = Number(coinDeduction);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [coinDeduction]);
  // Detect the video's natural aspect ratio (width/height) from its
  // thumbnail. Same approach used in PostVideo for the home feed —
  // expo-video's `videoTrack` is unreliable for HLS streams, but the
  // CDN-served thumbnail is a static image whose ratio mirrors the
  // source video. Updating this state drives the player container's
  // height so portrait videos go full-portrait inside the player
  // (YouTube-style) instead of being letterboxed at 16:9.
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);

  useEffect(() => {
    const thumbUri = video?.thumbnail;
    if (!thumbUri) return;

    let cancelled = false;
    Image.getSize(
      thumbUri,
      (w, h) => {
        if (cancelled) return;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
        const naturalRatio = w / h;
        // Clamp to keep edge cases sane:
        //   - max 16:9 (anything wider stays at 16:9 — letterbox top/bottom)
        //   - min  9:16 (anything more portrait clamps to full phone portrait)
        const clamped = Math.max(9 / 16, Math.min(16 / 9, naturalRatio));
        setVideoAspectRatio((prev) => (Math.abs(prev - clamped) > 0.01 ? clamped : prev));
      },
      (err) => {
        if (!cancelled && __DEV__) console.log("video-player Image.getSize:", err?.message || err);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [video?.thumbnail]);

  // height = width / aspectRatio. Default 16/9 → height = width * 9/16
  // (preserves the original landscape rendering); a portrait video at
  // 9/16 → height = width * 16/9 (taller player, no letterboxing).
  const defaultVideoPlayerHeight = useMemo(() => windowWidth / videoAspectRatio, [windowWidth, videoAspectRatio]);
  const compactVideoPlayerHeight = useMemo(() => {
    const compactFloor = screenHeight < 700 ? 92 : screenHeight < 780 ? 104 : 116;
    const scaledCompactHeight = defaultVideoPlayerHeight * 0.54;
    return Math.max(compactFloor, Math.min(defaultVideoPlayerHeight - 44, scaledCompactHeight));
  }, [defaultVideoPlayerHeight, screenHeight]);
  const androidKeyboardInset = useMemo(
    () =>
      getKeyboardViewportInset({
        keyboardHeight: screenKeyboardHeight,
        baselineWindowHeight: keyboardClosedWindowHeightRef.current,
        windowHeight,
      }),
    [screenKeyboardHeight, windowHeight],
  );
  const shouldCompressVideoForKeyboard = Platform.OS === "android" && displayComp === "COMMENTS" && androidKeyboardInset > 0;
  const targetVideoPlayerHeight = useMemo(() => {
    if (!shouldCompressVideoForKeyboard) return defaultVideoPlayerHeight;

    const maxReduction = Math.max(0, defaultVideoPlayerHeight - compactVideoPlayerHeight);
    const desiredReduction = Math.max(72, androidKeyboardInset * 0.38);
    return Math.max(compactVideoPlayerHeight, defaultVideoPlayerHeight - Math.min(maxReduction, desiredReduction));
  }, [androidKeyboardInset, compactVideoPlayerHeight, defaultVideoPlayerHeight, shouldCompressVideoForKeyboard]);

  useEffect(() => {
    Animated.timing(playerHeightAnim, {
      toValue: targetVideoPlayerHeight,
      duration: shouldCompressVideoForKeyboard ? 180 : 220,
      useNativeDriver: false,
    }).start();
  }, [playerHeightAnim, shouldCompressVideoForKeyboard, targetVideoPlayerHeight]);

  const enableFeatures = (player, allowed) => {
    if (!player) return;

    setIsEnabledFeatures(allowed);
    if (Platform.OS === "android") return;

    try {
      player.showNowPlayingNotification = allowed;
    } catch {}

    try {
      player.staysActiveInBackground = allowed;
    } catch {}

    try {
      player.startsPictureInPictureAutomatically = allowed;
    } catch {}

    try {
      player.allowsExternalPlayback = allowed;
    } catch {}
  };

  const player = useVideoPlayer(
    video?.videoUrl
      ? {
          uri: video?.videoUrl,
          metadata: {
            title: video?.title,
            artist: video?.uploader?.name,
            artwork: video?.uploader?.avatar,
          },
        }
      : null,
    (p) => {
      playerRef.current = p;
      try {
        p.timeUpdateEventInterval = 0.1;
      } catch {}
      try {
        p.showNowPlayingNotification = false;
      } catch {}
      try {
        p.staysActiveInBackground = false;
      } catch {}
      try {
        p.allowsExternalPlayback = false;
      } catch {}
      if (startAtSeconds !== null) {
        try {
          p.currentTime = Math.max(0, startAtSeconds);
        } catch {}
      }
      pendingPlayRef.current = !manualUnlockRequired;

      enableFeatures(p, canControlPlayer);
    },
  );

  const safePlay = useCallback(() => {
    const currentPlayer = playerRef.current;
    if (!isMountedRef.current || !currentPlayer) return;

    pendingPlayRef.current = true;
    if (currentPlayer.status === "error") return;
    if (currentPlayer.status !== "readyToPlay") return;

    try {
      pendingPlayRef.current = false;
      const result = currentPlayer.play?.();
      if (result?.catch) result.catch(() => {});
    } catch {}
  }, []);

  const safePause = useCallback(() => {
    const currentPlayer = playerRef.current;
    pendingPlayRef.current = false;
    if (!currentPlayer) return;

    try {
      if (currentPlayer.playing) {
        pauseRequestedRef.current = true;
      }
      currentPlayer.pause?.();
    } catch {}
  }, []);

  const setAndroidControlsReadyAfter = useCallback((delayMs) => {
    if (Platform.OS !== "android") return;

    if (androidControlsTimerRef.current) {
      clearTimeout(androidControlsTimerRef.current);
      androidControlsTimerRef.current = null;
    }

    androidControlsTimerRef.current = setTimeout(() => {
      androidControlsTimerRef.current = null;
      setAndroidNativeControlsReady(true);
    }, delayMs);
  }, []);

  const handleVideoScrollBeginDrag = useCallback(() => {
    Keyboard.dismiss();
    if (Platform.OS !== "android") return;

    if (androidControlsTimerRef.current) {
      clearTimeout(androidControlsTimerRef.current);
      androidControlsTimerRef.current = null;
    }
    setAndroidNativeControlsReady(false);
  }, []);

  const handleVideoScrollSettled = useCallback(() => {
    setAndroidControlsReadyAfter(300);
  }, [setAndroidControlsReadyAfter]);

  const {
    // New web-mirroring threshold-model API
    showChoiceModal,
    modalThreshold,
    initialUnlockSeconds,
    recurringSeconds,
    starRate,
    coinRate,
    loadingCurrency,
    handleChoice: handleUnlockChoice,
    handleCancel: handleUnlockCancel,
    isUnlocking,
    // Kept for the download flow + any legacy consumers
    resetUnlockFlow,
    manualUnlock,
    // Legacy fields are still returned by the hook (no-ops) so destructure
    // doesn't break — keeping the names that already had usages downstream.
    bannerMessage,
    bannerOpacity,
    bannerTranslateX,
    onBannerContainerLayout,
    onBannerContentSizeChange,
    bannerTextWidth,
    showBanner,
    countdown,
    isPurchaseBlocked,
  } = useAutoUnlock({
    player,
    user,
    video,
    isUnlocked,
    monetizationActive,
    autoUnlockEnabled: !startAtAfterUnlock,
    refetchCoins: refetchBalance,
    refetchStars: refetchStars,
    onUnlocked: () => setIsUnlocked(true),
    onOpenStore: () => {
      setShowCoinOverlay(true);
    },
  });

  const fetchCoinPacksIfNeeded = useCallback(async () => {
    if (coinOverlayLoading || coinPacks.length > 0) return;
    try {
      setCoinOverlayLoading(true);
      const packs = await getCoinPacks();
      setCoinPacks(packs);
    } catch (err) {
      console.error("Failed to load coin packs", err?.message || err);
    } finally {
      setCoinOverlayLoading(false);
    }
  }, [coinOverlayLoading, coinPacks.length]);

  useEffect(() => {
    if (showCoinOverlay) {
      fetchCoinPacksIfNeeded();
    }
  }, [showCoinOverlay, fetchCoinPacksIfNeeded]);

  useEffect(() => {
    return () => {
      if (downloadConfirmationResolverRef.current) {
        downloadConfirmationResolverRef.current(false);
        downloadConfirmationResolverRef.current = null;
      }
      if (downloadQualityPickerResolverRef.current) {
        downloadQualityPickerResolverRef.current(null);
        downloadQualityPickerResolverRef.current = null;
      }
    };
  }, []);

  const closeDownloadConfirmation = useCallback((confirmed = false) => {
    setDownloadConfirmationVisible(false);
    setDownloadConfirmationLocked(false);
    if (downloadConfirmationResolverRef.current) {
      downloadConfirmationResolverRef.current(confirmed);
      downloadConfirmationResolverRef.current = null;
    }
  }, []);

  const promptDownloadConfirmation = useCallback((isLocked) => {
    return new Promise((resolve) => {
      if (downloadConfirmationResolverRef.current) {
        downloadConfirmationResolverRef.current(false);
      }
      downloadConfirmationResolverRef.current = resolve;
      setDownloadConfirmationLocked(Boolean(isLocked));
      setDownloadConfirmationVisible(true);
    });
  }, []);

  const closeDownloadQualityPicker = useCallback((selectedQuality = null) => {
    setDownloadQualityPickerVisible(false);
    setDownloadQualityPickerOptions([]);
    if (downloadQualityPickerResolverRef.current) {
      downloadQualityPickerResolverRef.current(selectedQuality);
      downloadQualityPickerResolverRef.current = null;
    }
  }, []);

  const promptDownloadQualitySelection = useCallback((qualities) => {
    const options = (qualities || []).filter((q) => SUPPORTED_VIDEO_DOWNLOAD_QUALITIES.includes(q)).sort((a, b) => b - a);
    if (!options.length) return Promise.resolve(null);
    if (options.length === 1) return Promise.resolve(options[0]);

    return new Promise((resolve) => {
      if (downloadQualityPickerResolverRef.current) {
        downloadQualityPickerResolverRef.current(null);
      }
      downloadQualityPickerResolverRef.current = resolve;
      setDownloadQualityPickerOptions(options);
      setDownloadQualityPickerVisible(true);
    });
  }, []);

  const waitForDownloadModalTransition = useCallback(
    () =>
      new Promise((resolve) => {
        InteractionManager.runAfterInteractions(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
    [],
  );

  const handleDownloadVideo = useCallback(async () => {
    if (!video || !currentDownloadId) return;
    if (isCurrentVideoDownloading) return;
    if (currentVideoDownloadStatus === "completed") {
      showMessage("This video is already downloaded and available offline.");
      return;
    }
    if (downloadSettings?.wifiOnly) {
      const netState = await NetInfo.fetch();
      const isWifiLike = Boolean(netState?.isConnected && (netState?.type === "wifi" || netState?.type === "ethernet"));
      if (!isWifiLike) {
        showMessage("Downloads are set to Wi-Fi only. Connect to Wi-Fi or disable the setting to continue.");
        return;
      }
    } else if (isOffline) {
      showMessage("You're offline. Connect to the internet to download this video.");
      return;
    }

    if (monetizationActive && !unlockStatusReady) {
      showMessage("Please wait while we verify this video's lock status.");
      return;
    }

    const needsUnlockForDownload = monetizationActive && !isUnlocked;
    const confirmed = await promptDownloadConfirmation(needsUnlockForDownload);
    if (!confirmed) return;
    await waitForDownloadModalTransition();

    let selectedDownloadHeight = null;
    let availableQualities = [];
    try {
      availableQualities = await getAvailableVideoDownloadQualities(video.videoUrl);
    } catch (error) {
      console.warn("Failed to load available video qualities", error?.message || error);
    }

    if (downloadSettings?.quality === downloadQuality.askEachTime) {
      const promptQualities = availableQualities.length ? availableQualities : SUPPORTED_VIDEO_DOWNLOAD_QUALITIES;
      selectedDownloadHeight = await promptDownloadQualitySelection(promptQualities);
      if (!selectedDownloadHeight) return;
    }

    if (needsUnlockForDownload) {
      const unlocked = await manualUnlock?.();
      if (!unlocked) {
        showMessage(
          isPurchaseBlocked ? "Unlock the video first before downloading it for offline viewing." : "Unable to unlock this video right now.",
        );
        return;
      }
    }

    const baseEntry = {
      id: currentDownloadId,
      videoId: video.$id,
      video,
      createdAt: Date.now(),
      availableQualities: availableQualities.map((height) => `${height}p`),
    };

    dispatch(
      upsertVideoDownload({
        ...baseEntry,
        status: "preparing",
        progress: 0,
        error: null,
      }),
    );

    try {
      const result = await downloadVideoOffline({
        video,
        qualitySetting: downloadSettings?.quality,
        selectedHeight: selectedDownloadHeight,
        onStatusChange: (statusPayload) => {
          dispatch(
            upsertVideoDownload({
              ...baseEntry,
              ...statusPayload,
              quality: statusPayload?.selectedQuality || baseEntry?.quality,
            }),
          );
        },
      });

      dispatch(
        upsertVideoDownload({
          ...baseEntry,
          status: "completed",
          progress: 1,
          error: null,
          quality: result.quality,
          localUri: result.localUri,
          fileUri: result.fileUri,
          manifestUri: result.manifestUri,
          folderUri: result.folderUri,
          downloadUrl: result.downloadUrl,
          estimatedSizeBytes: result.estimatedSizeBytes,
          downloadedBytes: result.downloadedBytes,
          durationSeconds: result.durationSeconds,
          availableQualities: result.availableQualities,
        }),
      );
    } catch (error) {
      if (isVideoDownloadCancelledError(error)) {
        dispatch(
          upsertVideoDownload({
            ...baseEntry,
            status: "cancelled",
            progress: 0,
            error: null,
          }),
        );
        return;
      }

      if (isInsufficientVideoStorageError(error)) {
        dispatch(
          upsertVideoDownload({
            ...baseEntry,
            status: "failed",
            progress: 0,
            error: "Not enough device storage for this download.",
          }),
        );
        showMessage(
          `Not enough device storage. Need about ${formatBytes(error.requiredBytes)} but only ${formatBytes(error.freeBytes)} is available.`,
        );
        return;
      }

      console.error("video download error", error);
      dispatch(
        upsertVideoDownload({
          ...baseEntry,
          status: "failed",
          progress: 0,
          error: error?.message || "Download failed",
        }),
      );
      showMessage("Video download failed. Please try again.");
    }
  }, [
    video,
    currentDownloadId,
    isCurrentVideoDownloading,
    currentVideoDownloadStatus,
    downloadSettings,
    isOffline,
    monetizationActive,
    isUnlocked,
    unlockStatusReady,
    promptDownloadConfirmation,
    waitForDownloadModalTransition,
    manualUnlock,
    isPurchaseBlocked,
    dispatch,
    showMessage,
    promptDownloadQualitySelection,
  ]);

  useEffect(() => {
    let isMounted = true;

    const loadAutoplayPreference = async () => {
      try {
        const savedValue = await AsyncStorage.getItem(autoplayStorageKey);
        if (!isMounted || savedValue === null) return;
        if (isOffline) {
          setAutoplayEnabled(false);
          return;
        }
        setAutoplayEnabled(savedValue === "1");
      } catch (err) {
        console.warn("Failed to load autoplay preference:", err?.message || err);
      }
    };

    loadAutoplayPreference();

    return () => {
      isMounted = false;
    };
  }, [autoplayStorageKey, isOffline]);

  useEffect(() => {
    return () => {
      if (autoplayToastTimeoutRef.current) {
        clearTimeout(autoplayToastTimeoutRef.current);
        autoplayToastTimeoutRef.current = null;
      }
    };
  }, []);

  const showAutoplayToast = useCallback(
    (isOn) => {
      setAutoplayToastOn(isOn);
      setAutoplayToastVisible(true);

      if (autoplayToastTimeoutRef.current) {
        clearTimeout(autoplayToastTimeoutRef.current);
        autoplayToastTimeoutRef.current = null;
      }

      autoplayToastOpacity.stopAnimation();
      autoplayToastTranslateY.stopAnimation();
      autoplayToastOpacity.setValue(0);
      autoplayToastTranslateY.setValue(6);

      Animated.parallel([
        Animated.timing(autoplayToastOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(autoplayToastTranslateY, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(() => {
        autoplayToastTimeoutRef.current = setTimeout(() => {
          Animated.parallel([
            Animated.timing(autoplayToastOpacity, {
              toValue: 0,
              duration: 180,
              useNativeDriver: true,
            }),
            Animated.timing(autoplayToastTranslateY, {
              toValue: 6,
              duration: 180,
              useNativeDriver: true,
            }),
          ]).start(({ finished }) => {
            if (finished) setAutoplayToastVisible(false);
          });
        }, 1200);
      });
    },
    [autoplayToastOpacity, autoplayToastTranslateY],
  );

  const handleAutoplayToggle = useCallback(
    (value) => {
      setAutoplayEnabled(value);
      AsyncStorage.setItem(autoplayStorageKey, value ? "1" : "0").catch(() => {});
      showAutoplayToast(value);
    },
    [autoplayStorageKey, showAutoplayToast],
  );

  const pickLocalSameTagCandidate = useCallback(
    (videos) =>
      pickUnplayedSameCategoryVideo({
        videos,
        currentUri: effectiveVideoUri,
        category: primaryCategory,
        playedSet: playedUriSet,
      }),
    [effectiveVideoUri, playedUriSet, primaryCategory],
  );

  const pickLocalDifferentTagCandidate = useCallback(
    (videos) =>
      pickRandomUnplayedDifferentCategoryVideo({
        videos,
        currentUri: effectiveVideoUri,
        category: primaryCategory,
        playedSet: playedUriSet,
      }),
    [effectiveVideoUri, playedUriSet, primaryCategory],
  );

  const resolveRemoteSameTagCandidate = useCallback(async () => {
    if (!effectiveVideoUri || !primaryCategory) return null;

    const sameTagRes = await videosService.fetchVideos({ category: primaryCategory, limit: 100, status: "published" });
    return pickUnplayedSameCategoryVideo({
      videos: ShuffleVideos(sameTagRes?.documents || []),
      currentUri: effectiveVideoUri,
      category: primaryCategory,
      playedSet: playedUriSet,
    });
  }, [effectiveVideoUri, playedUriSet, primaryCategory, videosService]);

  const resolveRemoteDifferentTagCandidate = useCallback(async () => {
    if (!effectiveVideoUri) return null;

    const mixedRes = await videosService.fetchVideos({ limit: 120, status: "published" });
    return pickRandomUnplayedDifferentCategoryVideo({
      videos: ShuffleVideos(mixedRes?.documents || []),
      currentUri: effectiveVideoUri,
      category: primaryCategory,
      playedSet: playedUriSet,
    });
  }, [effectiveVideoUri, playedUriSet, primaryCategory, videosService]);

  useEffect(() => {
    let isCancelled = false;

    if (!effectiveVideoUri) {
      setNextVideo(null);
      setNextVideoLoading(false);
      return () => {
        isCancelled = true;
      };
    }

    // Playlist context override: when the user is watching a video that came
    // from VideosPlaylist, the "next" video should be the next item in their
    // saved queue, not a category-similarity recommendation. Look up the doc
    // in allVideos so the player has the title/thumbnail/uploader it needs to
    // render the "Up Next" pill.
    if (playlistQueue && Array.isArray(allVideos) && allVideos.length > 0) {
      const nextUri = playlistQueue.uris[playlistQueue.index + 1];
      if (nextUri) {
        const nextDoc = allVideos.find((v) => v?.uri === nextUri);
        if (nextDoc) {
          setNextVideo(nextDoc);
          setNextVideoLoading(false);
          return () => {
            isCancelled = true;
          };
        }
      } else {
        // End of the playlist — no next video to queue. Don't fall through to
        // category-similarity, leave it empty so autoplay simply stops.
        setNextVideo(null);
        setNextVideoLoading(false);
        return () => {
          isCancelled = true;
        };
      }
    }

    const localSameTagCandidate = pickLocalSameTagCandidate(allVideos);
    if (localSameTagCandidate) {
      setNextVideo(localSameTagCandidate);
      setNextVideoLoading(false);
      return () => {
        isCancelled = true;
      };
    }

    const fetchRemoteNextVideo = async () => {
      try {
        setNextVideoLoading(true);
        const remoteSameTagCandidate = await resolveRemoteSameTagCandidate();
        if (isCancelled) return;
        if (remoteSameTagCandidate) {
          setNextVideo(remoteSameTagCandidate);
          return;
        }

        const localDifferentTagCandidate = pickLocalDifferentTagCandidate(allVideos);
        if (localDifferentTagCandidate) {
          setNextVideo(localDifferentTagCandidate);
          return;
        }

        const remoteDifferentTagCandidate = await resolveRemoteDifferentTagCandidate();
        if (isCancelled) return;
        setNextVideo(remoteDifferentTagCandidate || null);
      } catch (err) {
        if (!isCancelled) {
          console.error("Failed to resolve next video:", err?.message || err);
        }
      } finally {
        if (!isCancelled) {
          setNextVideoLoading(false);
        }
      }
    };

    fetchRemoteNextVideo();

    return () => {
      isCancelled = true;
    };
  }, [
    allVideos,
    effectiveVideoUri,
    pickLocalDifferentTagCandidate,
    pickLocalSameTagCandidate,
    playlistQueue,
    resolveRemoteDifferentTagCandidate,
    resolveRemoteSameTagCandidate,
  ]);

  const handlePlayNext = useCallback(
    async ({ triggeredByAutoplay = false } = {}) => {
      const now = Date.now();
      if (navigatingToNextRef.current || nextActionLoading || !effectiveVideoUri) return;
      if (nextTapGuardRef.current.locked) return;
      if (now - nextTapGuardRef.current.lastAt < NEXT_NAV_THROTTLE_MS) return;

      nextTapGuardRef.current.locked = true;
      nextTapGuardRef.current.lastAt = now;

      setNextActionLoading(true);
      try {
        let targetVideo = nextVideo;

        if (!targetVideo) targetVideo = pickLocalSameTagCandidate(allVideos);
        if (!targetVideo) targetVideo = await resolveRemoteSameTagCandidate();
        if (!targetVideo) targetVideo = pickLocalDifferentTagCandidate(allVideos);
        if (!targetVideo) targetVideo = await resolveRemoteDifferentTagCandidate();

        if (!targetVideo?.uri) return;
        if (targetVideo.uri === effectiveVideoUri) return;

        navigatingToNextRef.current = true;
        setShowCoinOverlay(false);
        setShowResumeUnlockModal(false);
        resetUnlockFlow();
        safePause();

        // Carry playlist context forward so auto-advance chains beyond the
        // first hop. If we're inside a playlist queue, increment the index;
        // when the next video isn't actually the queue's next item (because
        // category-similarity fallback kicked in), drop the playlist params
        // entirely so the player stops trying to advance through the queue.
        const playlistForwardParams = (() => {
          if (!playlistQueue) return {};
          const expectedNextUri = playlistQueue.uris[playlistQueue.index + 1];
          if (expectedNextUri && expectedNextUri === targetVideo.uri) {
            return { playlistUris: playlistQueue.uris.join(","), playlistIndex: String(playlistQueue.index + 1) };
          }
          return {};
        })();

        router.replace({
          pathname: "video-player",
          params: {
            id: targetVideo.uri,
            docId: targetVideo.$id,
            view: displayComp || "RECOMMENDED",
            played: serializePlayedHistoryParam(appendToHistory(effectivePlayedHistory, targetVideo.uri)),
            ...playlistForwardParams,
          },
        });
      } catch (err) {
        console.error(triggeredByAutoplay ? "Autoplay next video failed:" : "Next video navigation failed:", err?.message || err);
        navigatingToNextRef.current = false;
        nextTapGuardRef.current.locked = false;
      } finally {
        if (!navigatingToNextRef.current) {
          nextTapGuardRef.current.locked = false;
          setNextActionLoading(false);
        }
      }
    },
    [
      allVideos,
      displayComp,
      effectivePlayedHistory,
      effectiveVideoUri,
      nextActionLoading,
      nextVideo,
      pickLocalDifferentTagCandidate,
      pickLocalSameTagCandidate,
      playlistQueue,
      safePause,
      resetUnlockFlow,
      resolveRemoteDifferentTagCandidate,
      resolveRemoteSameTagCandidate,
    ],
  );

  useEffect(() => {
    navigatingToNextRef.current = false;
    nextTapGuardRef.current.locked = false;
    manualPauseRef.current = false;
    pauseRequestedRef.current = false;
    lastKnownPlayingRef.current = false;
    lastPlayingAtRef.current = 0;
    lastManualPauseAtRef.current = 0;
    shouldResumeOnActiveRef.current = false;
    if (autoplayToastTimeoutRef.current) {
      clearTimeout(autoplayToastTimeoutRef.current);
      autoplayToastTimeoutRef.current = null;
    }
    setNextActionLoading(false);
    setAutoplayToastVisible(false);
    if (Platform.OS === "android") {
      setAndroidNativeControlsReady(false);
      setAndroidControlsReadyAfter(650);
    }
  }, [currentVideoIdentityKey, setAndroidControlsReadyAfter]);

  useEffect(() => {
    if (!player) return;

    const sub = player.addListener("playToEnd", () => {
      if (playerRef.current !== player) return;
      if (!autoplayEnabled || !nextVideo?.uri) return;
      handlePlayNext({ triggeredByAutoplay: true });
    });

    return () => sub?.remove();
  }, [autoplayEnabled, handlePlayNext, nextVideo?.uri, player]);

  useEffect(() => {
    if (!player) return;

    const handleStatusChange = ({ status } = {}) => {
      if (playerRef.current !== player) return;

      const resolvedStatus = status || player.status;
      if (resolvedStatus === "readyToPlay" && pendingPlayRef.current) {
        setAndroidControlsReadyAfter(650);
        if (isScreenFocusedRef.current && !manualUnlockRequired && !showResumeUnlockModal && !isUnlocking) {
          safePlay();
        }
        return;
      }

      if (resolvedStatus === "error") {
        pendingPlayRef.current = false;
        if (Platform.OS === "android") setAndroidNativeControlsReady(false);
      }
    };

    handleStatusChange({ status: player.status });
    const sub = player.addListener("statusChange", handleStatusChange);

    return () => sub?.remove();
  }, [isUnlocking, manualUnlockRequired, player, safePlay, setAndroidControlsReadyAfter, showResumeUnlockModal]);

  useEffect(() => {
    if (!player) return;

    const sub = player.addListener("playingChange", ({ isPlaying }) => {
      if (playerRef.current !== player) return;
      lastKnownPlayingRef.current = isPlaying;

      if (isPlaying) {
        lastPlayingAtRef.current = Date.now();
        manualPauseRef.current = false;
        pauseRequestedRef.current = false;
        return;
      }

      if (pauseRequestedRef.current) {
        pauseRequestedRef.current = false;
        return;
      }

      const currentAppState = AppState.currentState ?? appStateRef.current;
      if (currentAppState !== "active") {
        return;
      }

      manualPauseRef.current = true;
      lastManualPauseAtRef.current = Date.now();
    });

    return () => sub?.remove();
  }, [player]);

  useEffect(() => {
    if (!player) return;

    const sub = player.addListener("timeUpdate", () => {
      if (playerRef.current !== player) return;
      if (playerRef.current?.playing || lastKnownPlayingRef.current) {
        lastPlayingAtRef.current = Date.now();
      }
    });

    return () => sub?.remove();
  }, [player]);

  useFocusEffect(
    useCallback(() => {
      isScreenFocusedRef.current = true;
      if (manualUnlockRequired) safePause();
      else if (!manualPauseRef.current) safePlay();

      return () => {
        isScreenFocusedRef.current = false;
        shouldResumeOnActiveRef.current = false;
        safePause();
      };
    }, [manualUnlockRequired, safePause, safePlay]),
  );

  // Pause on background/inactive, resume when returning to active if we were playing.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === "active") {
        if (isScreenFocusedRef.current && shouldResumeOnActiveRef.current) {
          shouldResumeOnActiveRef.current = false;
          if (!manualUnlockRequired && !showResumeUnlockModal && !isUnlocking) {
            safePlay();
          }
        }
        shouldResumeOnActiveRef.current = false;
        return;
      }

      if (prevState === "active") {
        const now = Date.now();
        const wasPlayingRecently = lastPlayingAtRef.current > 0 && now - lastPlayingAtRef.current < 2000;
        const wasPlaying = Boolean(playerRef.current?.playing || lastKnownPlayingRef.current || wasPlayingRecently);
        const manualPauseLikelyBackground = manualPauseRef.current && lastManualPauseAtRef.current > 0 && now - lastManualPauseAtRef.current < 800;
        shouldResumeOnActiveRef.current = wasPlaying && (!manualPauseRef.current || manualPauseLikelyBackground);
      }
      safePause();
    });

    return () => subscription.remove();
  }, [isUnlocking, manualUnlockRequired, safePause, safePlay, showResumeUnlockModal]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      pendingPlayRef.current = false;
      if (androidControlsTimerRef.current) {
        clearTimeout(androidControlsTimerRef.current);
        androidControlsTimerRef.current = null;
      }
      safePause();
      playerRef.current = null;
    };
  }, [safePause]);

  useEffect(() => {
    resumeUnlockDismissedRef.current = false;
    setShowResumeUnlockModal(false);
  }, [video?.$id]);

  useEffect(() => {
    if (!playerRef.current || startAtSeconds === null) return;
    try {
      playerRef.current.currentTime = Math.max(0, startAtSeconds);
    } catch {}
  }, [player, startAtSeconds]);

  useEffect(() => {
    if (!manualUnlockRequired) return;
    safePause();
  }, [manualUnlockRequired, safePause]);

  useEffect(() => {
    if (!startAtAfterUnlock || !monetizationActive) {
      resumeUnlockDismissedRef.current = false;
      setShowResumeUnlockModal(false);
      return;
    }

    if (!unlockStatusReady) return;

    if (isUnlocked) {
      resumeUnlockDismissedRef.current = false;
      setShowResumeUnlockModal(false);
      return;
    }

    if (!resumeUnlockDismissedRef.current) {
      setShowResumeUnlockModal(true);
    }
  }, [startAtAfterUnlock, monetizationActive, unlockStatusReady, isUnlocked, video?.$id]);

  useEffect(() => {
    const uploaderId = video?.uploader?.$id || video?.uploader;
    setIsUploader(Boolean(user?.$id && uploaderId === user.$id));
  }, [video, user?.$id]);

  useEffect(() => {
    if (!player || !monetizationActive || isUnlocked) return;

    let lastAllowedTime = startAtSeconds ?? 0;

    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      if (currentTime < lastAllowedTime) {
        // allow rewind
        lastAllowedTime = currentTime;
        return;
      }

      if (currentTime - lastAllowedTime > 1.5) {
        try {
          player.seek(lastAllowedTime);
        } catch {}
        return;
      }

      lastAllowedTime = currentTime;
    });

    return () => sub?.remove();
  }, [player, monetizationActive, isUnlocked, startAtSeconds]);

  useEffect(() => {
    if (!player || !monetizationActive || isUnlocked) return;

    const sub = player.addListener("timeUpdate", ({ currentTime, duration }) => {
      setLockedProgress((prev) => {
        const resolvedDuration = Number.isFinite(duration) && duration > 0 ? duration : prev.duration || unlockTimeSeconds;
        return { current: currentTime, duration: resolvedDuration };
      });
    });

    return () => sub?.remove();
  }, [player, monetizationActive, isUnlocked, unlockTimeSeconds]);

  useEffect(() => {
    setLockedProgress({ current: 0, duration: unlockTimeSeconds || 0 });
    setLockedProgressVisible(false);
    if (lockedProgressTimeoutRef.current) {
      clearTimeout(lockedProgressTimeoutRef.current);
      lockedProgressTimeoutRef.current = null;
    }
  }, [video?.$id, unlockTimeSeconds]);

  useEffect(() => {
    if (monetizationActive && !isUnlocked) return;
    setLockedProgressVisible(false);
    if (lockedProgressTimeoutRef.current) {
      clearTimeout(lockedProgressTimeoutRef.current);
      lockedProgressTimeoutRef.current = null;
    }
  }, [monetizationActive, isUnlocked]);

  useEffect(() => {
    return () => {
      if (lockedProgressTimeoutRef.current) {
        clearTimeout(lockedProgressTimeoutRef.current);
        lockedProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!playerRef.current) return;

    enableFeatures(playerRef.current, canControlPlayer);

    if (canControlPlayer) {
      safePlay();
    }
  }, [canControlPlayer, safePlay]);

  useEffect(() => {
    if (isUnlocked && !isWatchWithAds) {
      enableFeatures(player, true);
    }
    if (isUnlocked && playerRef.current) {
      safePlay();
    }
  }, [isUnlocked, isWatchWithAds, player, safePlay]);

  useEffect(() => {
    let isCancelled = false;

    const resolveVideoByIdentifier = async ({ uri, docId: resolvedDocId }) => {
      if (!uri && !resolvedDocId) return null;

      if (resolvedDocId) {
        try {
          const byId = await videosService.getVideo({ id: resolvedDocId });
          if (byId) return byId;
        } catch (_) {}
      }

      try {
        if (!uri) return null;
        const byUri = await videosService.searchVideo({ uri });
        const matched = byUri?.documents?.[0];
        if (matched) return matched;
      } catch (_) {}

      try {
        if (!uri) return null;
        const byId = await videosService.getVideo({ id: uri });
        if (byId) return byId;
      } catch (_) {}

      if (typeof uri === "string" && uri.startsWith("http")) {
        try {
          const byUrl = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCollectionId, [
            Query.equal("videoUrl", uri),
          ]);
          return byUrl?.documents?.[0] || null;
        } catch (_) {}
      }

      return null;
    };

    const runMonetizationChecks = async (foundVideo, uploaderMatch) => {
      if (!foundVideo) return;
      try {
        setProcessing(false);
        setError(false);
        setSuccess(false);

        const videoUrl = foundVideo?.videoUrl;
        const guid = typeof videoUrl === "string" ? videoUrl.split("/").filter(Boolean)[2] : null;
        if (guid) {
          const videoData = await videosService.checkVideoStatus({ videoId: guid });
          if (videoData?.status === 4) {
            !isCancelled && setSuccess(true);
          } else if (videoData?.status === 2 || videoData?.status === 3) {
            !isCancelled && setProcessing(true);
          } else if (videoData?.status === 5 || videoData?.status === 6) {
            !isCancelled && setError(true);
          }
        }

        const coinData = await getCoinDeductionByTags(foundVideo.tags);
        !isCancelled && setCoinDeduction(coinData.coinDeduction);

        let alreadyUnlocked = !foundVideo?.monetization_enabled || uploaderMatch;

        if (!alreadyUnlocked && user?.$id) {
          try {
            const unlockedRes = await videoUnlockService.getUserUnlockedVideo({ videoId: foundVideo.$id, userId: user.$id });
            alreadyUnlocked = unlockedRes?.total > 0;
          } catch (unlockErr) {
            console.error("Check unlock failed:", unlockErr?.message || unlockErr);
          }
        }

        !isCancelled && setIsUnlocked(alreadyUnlocked);
        !isCancelled && setUnlockStatusReady(true);

        if (user?.$id) {
          addToHistory(foundVideo.uri, user.$id);
          await videosService.viewVideo({ videoId: foundVideo.$id, userId: user.$id });
        }
      } catch (err) {
        console.error(err?.message || err);
        !isCancelled && setUnlockStatusReady(true);
      }
    };

    const processVideo = async () => {
      let foundVideo = null;
      try {
        const shouldUseLocalDownload = Boolean(playbackLocalDownloadEntry && (localVideoUriParam || isOffline));
        if (shouldUseLocalDownload) {
          const offlineVideo = {
            ...playbackLocalDownloadEntry.video,
            videoUrl: playbackLocalDownloadEntry.localUri || playbackLocalDownloadEntry.manifestUri,
            offlineVideoUrl: playbackLocalDownloadEntry.localUri || playbackLocalDownloadEntry.manifestUri,
            remoteVideoUrl: playbackLocalDownloadEntry.video?.videoUrl,
            offlineDownloadId: playbackLocalDownloadEntry.id,
          };

          if (isCancelled) return;
          const uploaderId = offlineVideo?.uploader?.$id || offlineVideo?.uploader;
          const uploaderMatch = Boolean(user?.$id && uploaderId === user.$id);
          setProcessing(false);
          setError(false);
          setSuccess(true);
          setCoinDeduction(null);
          setIsUploader(uploaderMatch);
          setVideo(offlineVideo);
          setIsUnlocked(true);
          setUnlockStatusReady(true);
          setLoading(false);
          return;
        }

        foundVideo = await resolveVideoByIdentifier({ uri: currentVideoUri, docId: currentVideoDocId });
        if (!foundVideo) {
          setVideo(null);
          return;
        }
        if (isCancelled) return;

        const uploaderId = foundVideo?.uploader?.$id || foundVideo?.uploader;
        const uploaderMatch = Boolean(user?.$id && uploaderId === user.$id);
        setIsUploader(uploaderMatch);
        setVideo(foundVideo);
        setLoading(false); // render player immediately; monetization checks continue
        runMonetizationChecks(foundVideo, uploaderMatch);
      } catch (err) {
        console.error(err?.message || err);
      } finally {
        if (!isCancelled) setLoading(false);
        if (!isCancelled && foundVideo && !foundVideo?.monetization_enabled) {
          setUnlockStatusReady(true);
        }
      }
    };

    setUnlockStatusReady(false);
    setLoading(true);
    setVideo(null);
    setProcessing(false);
    setError(false);
    setSuccess(false);
    setIsUnlocked(false);
    setIsUploader(false);
    activateKeepAwakeAsync();
    processVideo();

    return () => {
      deactivateKeepAwake();
      isCancelled = true;
    };
  }, [currentVideoUri, currentVideoDocId, user?.$id, playbackLocalDownloadEntry, localVideoUriParam, isOffline]);

  useEffect(() => {
    if (localVideoUriParam) return;
    (async () => {
      const matching = currentVideoDocId
        ? allVideos.find((v) => v.$id === currentVideoDocId)
        : allVideos.find((v) => v.uri === currentVideoUri || v.$id === currentVideoUri || v.videoUrl === currentVideoUri);
      if (matching && (!video?.$id || matching.$id === video.$id)) setVideo(matching);
    })();
  }, [allVideos, currentVideoUri, currentVideoDocId, localVideoUriParam, video?.$id]);

  useEffect(() => {
    if (!isWatchWithAds || !interstitial) return;
    const unsubscribeLoaded = interstitial.addAdEventListener(AdEventType.LOADED, () => {
      if (firstLoad.current) {
        interstitial.show();
        safePause();
      } else {
        interval.current = setInterval(
          () => {
            try {
              interstitial.show();
              safePause();
            } catch (error) {
              console.error(error.message);
            }
          },
          globalSettings["DEFAULT_ADS_INTERVAL_MIN"] * 60 * 1000,
        );
      }
    });

    const unsubscribeClosed = interstitial.addAdEventListener(AdEventType.CLOSED, () => {
      safePlay();
      if (firstLoad.current) {
        firstLoad.current = false;
      }
      if (interval.current) clearInterval(interval.current);
      interstitial.load();
    });

    interstitial.load();
    return () => {
      unsubscribeLoaded();
      unsubscribeClosed();
      if (interval.current) clearInterval(interval.current);
    };
  }, [isWatchWithAds, safePause, safePlay, interstitial]);

  const handleBackPress = useCallback(() => {
    try {
      if (router.canGoBack?.()) {
        router.back();
        return;
      }
    } catch (_) {}

    router.replace("/home");
  }, []);

  const topBar = useMemo(
    () => (
      <View className="flex-row items-center justify-between p-2">
        <TouchableOpacity activeOpacity={0.7} onPress={handleBackPress}>
          <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
        </TouchableOpacity>
        {!isOffline && (
          <View className="flex-row gap-2">
            <StyledStarIndicator
              onPress={() => {
                router.push("/store");
              }}
              style={[styles.coinPill, { borderColor: theme.border, backgroundColor: theme.surface }]}
            />
            <StyledCoinIndicator
              onPress={() => {
                router.push("/store");
              }}
              style={[styles.coinPill, { borderColor: theme.border, backgroundColor: theme.surface }]}
            />
          </View>
        )}
      </View>
    ),
    [handleBackPress, isOffline, theme.border, theme.icon, theme.surface],
  );

  const keyboardAvoidingBehavior = Platform.OS === "ios" ? "padding" : undefined;
  const keyboardAvoidingOffset = 0;

  const memoizedSkeleton = useMemo(() => <VideoPlayerSkeleton />, []);

  const handleLockedVideoPress = useCallback(() => {
    if (!monetizationActive || isUnlocked || !unlockStatusReady) return;
    setLockedProgressVisible(true);
    if (lockedProgressTimeoutRef.current) clearTimeout(lockedProgressTimeoutRef.current);
    lockedProgressTimeoutRef.current = setTimeout(() => setLockedProgressVisible(false), 3500);
  }, [monetizationActive, isUnlocked, unlockStatusReady]);

  const handleDismissResumeUnlockModal = useCallback(() => {
    resumeUnlockDismissedRef.current = true;
    setShowResumeUnlockModal(false);
  }, []);

  if (loading) {
    return (
      <StyledSafeAreaView>
        <KeyboardAvoidingView
          behavior={keyboardAvoidingBehavior}
          keyboardVerticalOffset={keyboardAvoidingOffset}
          enabled={Platform.OS === "ios"}
          className="h-full w-full"
        >
          <View ref={screenContainerRef} onLayout={updateScreenOverlayOrigin} className="relative h-full w-full">
            {topBar}
            <View className="flex-1">{memoizedSkeleton}</View>
          </View>
        </KeyboardAvoidingView>
      </StyledSafeAreaView>
    );
  }

  let isExcluded = false;
  try {
    isExcluded = JSON.parse(globalSettings["EXCLUDE_ADS_ON_GENRE"] || "[]").includes(video?.tags?.[0]);
  } catch {}

  return (
    <StyledSafeAreaView>
      <KeyboardAvoidingView
        behavior={keyboardAvoidingBehavior}
        keyboardVerticalOffset={keyboardAvoidingOffset}
        enabled={Platform.OS === "ios"}
        className="h-full w-full"
      >
        <View ref={screenContainerRef} onLayout={updateScreenOverlayOrigin} className="relative h-full w-full">
          {/* TOP BAR */}
          {topBar}

          {!video ? (
            <ContentNotFound type={"Video"} iconName={"video-off"} />
          ) : (
            <>
              {/* VIDEO + OVERLAYS */}
              <Animated.View
                ref={videoPlayerContainerRef}
                className="relative w-full overflow-hidden"
                style={{ height: playerHeightAnim, backgroundColor: theme.mediaBackground }}
              >
                {/* Top banner messages */}
                {monetizationActive && showBanner && (
                  <Animated.View
                    style={{
                      opacity: bannerOpacity,
                      position: "absolute",
                      top: 0,
                      left: 16,
                      right: 16,
                      zIndex: 9999,
                      elevation: 9999,
                    }}
                    pointerEvents="none"
                    className="items-center"
                  >
                    <View
                      onLayout={onBannerContainerLayout}
                      className="overflow-hidden rounded-2xl border px-5 py-3 shadow-lg shadow-black"
                      style={{ borderColor: theme.border, backgroundColor: theme.mediaOverlayStrong }}
                    >
                      <ScrollView
                        horizontal
                        scrollEnabled={false}
                        showsHorizontalScrollIndicator={false}
                        onContentSizeChange={(w) => onBannerContentSizeChange(w)}
                      >
                        <Animated.View style={{ transform: [{ translateX: bannerTranslateX }] }}>
                          <Text
                            numberOfLines={1}
                            ellipsizeMode="clip"
                            className="text-center font-sans text-sm font-semibold"
                            style={{ color: theme.primaryContrast }}
                            style={{ flexShrink: 0, width: bannerTextWidth || undefined }}
                          >
                            {bannerMessage}
                          </Text>
                        </Animated.View>
                      </ScrollView>
                    </View>
                  </Animated.View>
                )}

                {/* The 0:00–2:00 floating "Unlock now" pill was removed when
                    we ported the web's threshold model — the web has no
                    early-watching CTA, the choice modal at 3:00 is the only
                    paywall affordance. The modal itself is rendered at the
                    bottom of the page (see <VideoUnlockChoiceModal /> below). */}

                {/* Countdown bottom-right */}
                {monetizationActive && !isUnlocked && countdown && (
                  <View
                    style={{
                      zIndex: 9999,
                      elevation: 9999,
                    }}
                    className="absolute bottom-6 right-4 rounded-2xl border px-4 py-2 shadow-lg shadow-black"
                    style={{ borderColor: theme.accentAmber, backgroundColor: theme.mediaOverlayStrong }}
                  >
                    <Text className="font-sans text-base font-semibold" style={{ color: theme.accentAmber }}>
                      Sending support in {countdown}s
                    </Text>
                  </View>
                )}

                {/* Unlocking spinner (small subtle indicator) */}
                {isUnlocking && (
                  <View className="absolute inset-0 z-20 items-center justify-center px-6" style={{ backgroundColor: theme.mediaOverlayStrong }}>
                    <View
                      className="w-full max-w-md items-center rounded-2xl border px-5 py-4 shadow-lg shadow-black"
                      style={{ borderColor: theme.border, backgroundColor: theme.mediaOverlayStrong }}
                    >
                      <View className="flex-row items-center space-x-3">
                        <LoaderKit style={{ width: 22, height: 22, opacity: 0.95 }} name="BallSpinFadeLoader" color={theme.coin} />
                        <View>
                          <Text className="font-sans text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                            Processing your support...
                          </Text>
                          <Text className="font-sans text-xs" style={{ color: theme.textMuted }}>
                            Please stay on this screen while we unlock the video.
                          </Text>
                        </View>
                      </View>
                    </View>
                  </View>
                )}

                <VideoView
                  className="h-full w-full"
                  player={player}
                  ref={videoViewRef}
                  // Native controls are now allowed on LOCKED monetized videos so
                  // the user can pause / seek / scrub before the 3:00 unlock.
                  // Was previously gated on canControlPlayer, which forced
                  // nativeControls=false until the video unlocked. Revenue is
                  // still protected: useAutoUnlock's timeUpdate listener fires
                  // the deduction the moment currentTime >= unlockTime, whether
                  // that happens by watching or by scrubbing the playhead past
                  // the mark. Fullscreen / PIP / video-frame-analysis remain
                  // gated by isEnabledFeatures (post-unlock) on purpose.
                  nativeControls={Platform.OS !== "android" || (androidNativeControlsReady && player?.status === "readyToPlay")}
                  allowsFullscreen={isEnabledFeatures}
                  allowsPictureInPicture={Platform.OS === "android" ? false : isEnabledFeatures}
                  allowsVideoFrameAnalysis={Platform.OS === "android" ? false : isEnabledFeatures}
                />
                {/* The full-screen Pressable that used to sit here intercepted
                    every tap on the locked video so it could reveal the green
                    "Unlocks at 2:00" progress strip on tap. Both are gone now:
                    the new floating violet "Unlock now" pill is always visible
                    during 0:00–2:00, and the timeUpdate listener handles the
                    auto-deduction regardless of how the playhead reaches the
                    3:00 mark — so blocking taps was no longer earning its keep
                    and was preventing the user from accessing pause / seek /
                    fullscreen on the native player controls. */}

                {/* Threshold-crossing choice modal — port of the web's
                    openVideoMonetThresholdDialog, but rendered INSIDE the
                    video container so it overlays just the player area
                    (not the whole screen). 5-second auto-deduct fallback
                    inside the modal: prefers coin, falls back to star.
                    Hook owns visibility + threshold; we just render and
                    forward the pick back. */}
                <VideoUnlockChoiceModal
                  isVisible={showChoiceModal}
                  videoTitle={video?.title}
                  thresholdSeconds={modalThreshold}
                  recurringSeconds={recurringSeconds}
                  coinCost={coinRate}
                  starCost={starRate}
                  coinBalance={Number(balance) || 0}
                  starBalance={Number(starsData?.stars) || 0}
                  loadingCurrency={loadingCurrency}
                  onChoice={(currency) => {
                    // If the user picked (or auto-pick fired with) a
                    // currency they can't afford, surface the store overlay
                    // and dismiss the modal. Should be rare — auto-pick
                    // already filters by affordability and disabled tiles
                    // can't be tapped — but defensive in case rates or
                    // balances drift.
                    const cost = currency === "coin" ? coinRate : starRate;
                    const have = currency === "coin" ? Number(balance) || 0 : Number(starsData?.stars) || 0;
                    if (have < cost) {
                      handleUnlockCancel();
                      setShowCoinOverlay(true);
                      return;
                    }
                    handleUnlockChoice(currency);
                  }}
                  onCancel={handleUnlockCancel}
                />
              </Animated.View>

              {/* COIN PACK OVERLAY WHEN NO BALANCE (video area only) */}
              {showCoinOverlay && (
                <View
                  className="absolute inset-5 z-30 mt-3.5 w-full items-center justify-center px-3"
                  style={{ backgroundColor: theme.mediaOverlayStrong }}
                >
                  <TouchableOpacity
                    onPress={() => setShowCoinOverlay(false)}
                    className="absolute right-3 top-3 rounded-full px-3 py-1"
                    style={{ backgroundColor: theme.surfaceMuted }}
                    activeOpacity={0.7}
                  >
                    <Text className="font-sans text-xs" style={{ color: theme.text }}>
                      Close
                    </Text>
                  </TouchableOpacity>

                  <View
                    className="w-full max-w-md rounded-3xl border p-5 shadow-2xl shadow-black"
                    style={{ borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
                  >
                    <View className="mb-4 flex-row items-center space-x-3">
                      <View className="h-11 w-11 items-center justify-center rounded-2xl" style={{ backgroundColor: theme.accentAmberSoft }}>
                        <StarIcon size={30} color={theme.coin} />
                      </View>
                      <View className="flex-1">
                        <Text className="font-sans text-lg font-semibold" style={{ color: theme.text }}>
                          You’re out of Stars & Coins
                        </Text>
                        <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                          Top up or watch a quick ad to send support and keep watching without interruptions.
                        </Text>
                      </View>
                    </View>

                    <View className="space-y-2">
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => {
                          setShowCoinOverlay(false);
                          router.push("/store");
                        }}
                        className="flex-row items-center justify-center rounded-2xl px-4 py-3"
                        style={{ backgroundColor: theme.accentAmber }}
                      >
                        <Text className="font-sans text-sm font-semibold" style={{ color: theme.textInverse }}>
                          Get Coins
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => {
                          setShowCoinOverlay(false);
                          router.push("/store");
                        }}
                        className="flex-row items-center justify-center rounded-2xl px-4 py-3"
                        style={{ backgroundColor: theme.accentGreen }}
                      >
                        <Text className="font-sans text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                          Watch Ad · Earn 1 Star
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => {
                          setShowCoinOverlay(false);
                          resetUnlockFlow();
                          safePlay();
                        }}
                        className="items-center justify-center rounded-2xl border px-4 py-2"
                        style={{ borderColor: theme.borderStrong }}
                      >
                        <Text className="font-sans text-xs" style={{ color: theme.textMuted }}>
                          Retry unlock after topping up
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )}

              {/* RESUME UNLOCK MODAL */}
              <Modal
                isVisible={showResumeUnlockModal && !showCoinOverlay}
                backdropOpacity={0.7}
                onBackdropPress={handleDismissResumeUnlockModal}
                onBackButtonPress={handleDismissResumeUnlockModal}
                useNativeDriver
              >
                <View className="flex-1 items-center justify-center px-5">
                  <View
                    className="w-full max-w-[360px] overflow-hidden rounded-3xl border"
                    style={{ borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
                  >
                    <View className="flex-row items-center justify-between border-b px-5 py-4" style={{ borderColor: theme.border }}>
                      <View className="flex-row items-center space-x-3">
                        <View className="h-10 w-10 items-center justify-center rounded-2xl" style={{ backgroundColor: theme.accentGreenSoft }}>
                          <MaterialIcons name="lock-open" size={20} color={theme.accentGreen} />
                        </View>
                        <View>
                          <Text className="font-sans text-base font-semibold" style={{ color: theme.text }}>
                            Continue watching?
                          </Text>
                          <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                            {resumeTimeDisplay ? `Resume at ${resumeTimeDisplay}` : "Unlock to keep watching."}
                          </Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        onPress={handleDismissResumeUnlockModal}
                        className="h-8 w-8 items-center justify-center rounded-full"
                        style={{ backgroundColor: theme.surfaceMuted }}
                        activeOpacity={0.7}
                      >
                        <MaterialIcons name="close" size={18} color={theme.icon} />
                      </TouchableOpacity>
                    </View>

                    <View className="space-y-3 px-5 py-5">
                      <Text className="font-sans text-sm" style={{ color: theme.textMuted }}>
                        You're resuming past the free preview. Unlock to continue watching this video.
                      </Text>
                      <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                        Unlocking will deduct stars or coins based on this video.
                      </Text>

                      <TouchableOpacity
                        disabled={isUnlocking}
                        activeOpacity={0.8}
                        onPress={manualUnlock}
                        className="flex-row items-center justify-center space-x-2 rounded-2xl px-4 py-3"
                        style={{ backgroundColor: isUnlocking ? theme.surfaceMuted : theme.accentGreen }}
                      >
                        {isUnlocking ? (
                          <LoaderKit style={{ width: 16, height: 16, opacity: 0.9 }} name="BallSpinFadeLoader" color={theme.primaryContrast} />
                        ) : (
                          <MaterialIcons name="lock-open" size={18} color={theme.primaryContrast} />
                        )}
                        <Text className="font-sans text-sm font-semibold" style={{ color: isUnlocking ? theme.textMuted : theme.primaryContrast }}>
                          {isUnlocking ? "Unlocking..." : "Unlock Video"}
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity onPress={handleDismissResumeUnlockModal} className="items-center pt-1" activeOpacity={0.7}>
                        <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                          Not now
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </Modal>

              <View className="flex-1">
                {displayComp === "COMMENTS" ? (
                  <CommentSection
                    isHidden={false}
                    id={effectiveVideoUri}
                    videoDocId={video?.$id || currentVideoDocId}
                    uploader={video?.uploader}
                    focusCommentId={focusCommentIdParam}
                    focusReplyId={focusReplyIdParam}
                    onMentionOverlayChange={handleMentionOverlayChange}
                    suppressMentionOverlay={mentionOverlaySuppressed}
                    onCloseComments={() => {
                      Keyboard.dismiss();
                      setDisplayComp("RECOMMENDED");
                    }}
                    onCommentCountChange={setCommentTabCount}
                  />
                ) : (
                  <ScrollView
                    ref={videoScrollRef}
                    className="flex-1"
                    contentContainerStyle={{ paddingBottom: 28 }}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                    onScrollBeginDrag={handleVideoScrollBeginDrag}
                    onScrollEndDrag={handleVideoScrollSettled}
                    onMomentumScrollEnd={handleVideoScrollSettled}
                  >
                    {/* DESCRIPTION */}
                    <Description
                      item={video}
                      onOpenComments={() => {
                        setDisplayComp("COMMENTS");
                      }}
                      onDownloadPress={handleDownloadVideo}
                      downloadStatus={currentVideoDownloadStatus}
                      downloadDisabled={isCurrentVideoDownloading || isUnlocking}
                    />

                    {/* PLAYBACK ACTIONS + TAB TOGGLES */}
                    <View className="px-2 pb-2">
                      <View
                        className="relative overflow-visible rounded-2xl border p-3"
                        style={{ borderColor: theme.border, backgroundColor: theme.cardStrong }}
                      >
                        <View className="flex-row items-start justify-between space-x-3">
                          <View className="flex-1">
                            <Text className="font-sans text-[11px]" style={{ color: theme.textSubtle }}>
                              {primaryCategory ? `${primaryCategory} · Up Next` : "Up Next"}
                            </Text>
                            <Text className="mt-1 font-sans text-sm font-semibold" style={{ color: theme.text }} numberOfLines={2}>
                              {nextVideo?.title || (nextVideoLoading ? "Finding another video..." : "No unplayed videos available")}
                            </Text>
                          </View>

                          <TouchableOpacity
                            activeOpacity={0.8}
                            disabled={nextActionLoading || !canTryNext || isOffline}
                            onPress={() => handlePlayNext()}
                            className="h-10 min-w-[88px] flex-row items-center justify-center space-x-1.5 rounded-full px-3"
                            style={{ backgroundColor: nextActionLoading || !canTryNext ? theme.surfaceMuted : theme.surfaceStrong }}
                          >
                            {nextActionLoading ? (
                              <LoaderKit style={{ width: 14, height: 14, opacity: 0.9 }} name="BallSpinFadeLoader" color={theme.primary} />
                            ) : (
                              <MaterialIcons name="skip-next" size={21} color={theme.icon} />
                            )}
                            <Text
                              className="font-sans text-xs font-semibold"
                              style={{ color: nextActionLoading || !canTryNext ? theme.textSoft : theme.text }}
                            >
                              Next
                            </Text>
                          </TouchableOpacity>
                        </View>

                        <View className="mt-3 flex-row items-center justify-between">
                          <View className="flex-row items-center space-x-2">
                            <Ionicons name="play-circle-sharp" size={18} color={autoplayEnabled ? theme.accentGreen : theme.iconMuted} />
                            <Text numberOfLines={1} ellipsizeMode="clip" className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                              Auto{"\u00A0"}Play
                            </Text>
                          </View>

                          <TouchableOpacity
                            activeOpacity={0.85}
                            onPress={() => handleAutoplayToggle(!autoplayEnabled)}
                            accessibilityRole="switch"
                            accessibilityState={{ checked: autoplayEnabled }}
                            className="h-8 w-14 flex-row items-center rounded-full border p-1"
                            style={{
                              borderColor: autoplayEnabled ? theme.accentGreen : theme.borderStrong,
                              backgroundColor: autoplayEnabled ? theme.accentGreenSoft : theme.surfaceMuted,
                            }}
                          >
                            <View
                              className="h-6 w-6 items-center justify-center rounded-full"
                              style={{ backgroundColor: autoplayEnabled ? theme.accentGreen : theme.surfaceStrong }}
                              style={{ transform: [{ translateX: autoplayEnabled ? 22 : 0 }] }}
                            >
                              <Ionicons name="play-circle-sharp" size={16} color={autoplayEnabled ? theme.primaryContrast : theme.iconMuted} />
                            </View>
                          </TouchableOpacity>
                        </View>

                        {autoplayToastVisible && (
                          <Animated.View
                            pointerEvents="none"
                            style={{
                              position: "absolute",
                              right: 8,
                              bottom: -30,
                              opacity: autoplayToastOpacity,
                              transform: [{ translateY: autoplayToastTranslateY }],
                            }}
                            className="rounded-full border px-3 py-1"
                            style={{
                              borderColor: autoplayToastOn ? theme.accentGreen : theme.borderStrong,
                              backgroundColor: autoplayToastOn ? theme.accentGreenSoft : theme.surfaceElevated,
                            }}
                          >
                            <Text className="font-sans text-[11px] font-semibold" style={{ color: autoplayToastOn ? theme.accentGreen : theme.text }}>
                              {autoplayToastOn ? "Auto Play On" : "Auto Play Off"}
                            </Text>
                          </Animated.View>
                        )}
                      </View>

                      {/* Recommended / Comments segmented pills — premium
                          violet language matching the Books / Videos / Profile
                          pill bars. Active pill carries the violet shadow lift,
                          inactive sits in surfaceMuted with a 1px border so it
                          reads as a tap target without competing visually. */}
                      <View className="mt-4 flex-row items-center" style={{ gap: 8 }}>
                        {(() => {
                          const isActive = displayComp === "RECOMMENDED";
                          return (
                            <TouchableOpacity
                              onPress={() => setDisplayComp("RECOMMENDED")}
                              activeOpacity={0.85}
                              accessibilityLabel="Show recommended videos"
                              className="flex-row items-center rounded-full"
                              style={{
                                paddingHorizontal: 14,
                                paddingVertical: 8,
                                backgroundColor: isActive ? theme.primary : theme.surfaceMuted,
                                borderWidth: isActive ? 0 : 1,
                                borderColor: isActive ? "transparent" : theme.border,
                                shadowColor: theme.primary,
                                shadowOffset: { width: 0, height: 4 },
                                shadowOpacity: isActive ? 0.28 : 0,
                                shadowRadius: 10,
                                elevation: isActive ? 4 : 0,
                              }}
                            >
                              <Ionicons
                                name="play-circle"
                                size={14}
                                color={isActive ? theme.primaryContrast : theme.iconMuted}
                                style={{ marginRight: 6 }}
                              />
                              <Text
                                className="font-sans"
                                style={{
                                  fontSize: 13,
                                  fontWeight: isActive ? "700" : "600",
                                  letterSpacing: 0.2,
                                  color: isActive ? theme.primaryContrast : theme.textMuted,
                                }}
                              >
                                Recommended
                              </Text>
                            </TouchableOpacity>
                          );
                        })()}
                        {(() => {
                          const isActive = displayComp === "COMMENTS";
                          return (
                            <TouchableOpacity
                              onPress={() => setDisplayComp("COMMENTS")}
                              activeOpacity={0.85}
                              accessibilityLabel="Show comments"
                              className="flex-row items-center rounded-full"
                              style={{
                                paddingHorizontal: 14,
                                paddingVertical: 8,
                                backgroundColor: isActive ? theme.primary : theme.surfaceMuted,
                                borderWidth: isActive ? 0 : 1,
                                borderColor: isActive ? "transparent" : theme.border,
                                shadowColor: theme.primary,
                                shadowOffset: { width: 0, height: 4 },
                                shadowOpacity: isActive ? 0.28 : 0,
                                shadowRadius: 10,
                                elevation: isActive ? 4 : 0,
                              }}
                            >
                              <Ionicons
                                name="chatbubble-ellipses"
                                size={13}
                                color={isActive ? theme.primaryContrast : theme.iconMuted}
                                style={{ marginRight: 6 }}
                              />
                              <Text
                                className="font-sans"
                                style={{
                                  fontSize: 13,
                                  fontWeight: isActive ? "700" : "600",
                                  letterSpacing: 0.2,
                                  color: isActive ? theme.primaryContrast : theme.textMuted,
                                }}
                              >
                                {`Comments (${FormatNumber(commentTabCount)})`}
                              </Text>
                            </TouchableOpacity>
                          );
                        })()}
                      </View>
                    </View>

                    <RecommendedVideos isHidden={false} videos={allVideos} />
                  </ScrollView>
                )}
              </View>
              {mentionOverlay.visible && !mentionOverlaySuppressed ? (
                <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                  <UserMention
                    variant="suggestions"
                    suggestions={mentionOverlay.suggestions}
                    selectedUserIds={mentionOverlay.selectedUserIds}
                    ready={mentionOverlay.ready}
                    onSelect={mentionOverlay.onSelect}
                    containerStyle={{
                      position: "absolute",
                      left: Math.max(8, mentionOverlay.left - screenOverlayOrigin.x),
                      top: Math.max(8, mentionOverlay.top - screenOverlayOrigin.y),
                      width: Math.max(220, mentionOverlay.width),
                      maxHeight: mentionOverlay.maxHeight,
                      zIndex: 10000,
                      elevation: 10000,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: theme.borderStrong,
                      backgroundColor: theme.surfaceElevated,
                    }}
                    contentContainerStyle={{ paddingBottom: 4 }}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="always"
                  />
                </View>
              ) : null}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
      {/* Download confirmation — bottom sheet shown after the user taps the
          download icon inside the player. Two states:
            • Unlocked: show a violet primary chip + "Download for offline
              viewing?" body and a violet primary "Download" CTA with shadow
              lift. Mirrors the rest of the offline-download flow (Quality
              picker + Downloads tab).
            • Locked: show an amber lock chip + a per-video unlock cost row
              and the "Unlock & Download" amber CTA so users can clearly tell
              the action will deduct Coin/Star. */}
      <Modal
        isVisible={downloadConfirmationVisible && !showCoinOverlay}
        onBackdropPress={() => closeDownloadConfirmation(false)}
        onBackButtonPress={() => closeDownloadConfirmation(false)}
        swipeDirection="down"
        onSwipeComplete={() => closeDownloadConfirmation(false)}
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

          <View className="mb-4 flex-row items-center">
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: downloadConfirmationLocked ? theme.accentAmberSoft : theme.primarySoft,
                borderWidth: 1,
                borderColor: downloadConfirmationLocked ? theme.accentAmber : theme.primary,
                marginRight: 12,
                shadowColor: downloadConfirmationLocked ? theme.accentAmber : theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.35,
                shadowRadius: 8,
                elevation: 3,
              }}
            >
              {downloadConfirmationLocked ? (
                <MaterialIcons name="lock-outline" size={20} color={theme.accentAmber} />
              ) : (
                <MaterialCommunityIcons name="cloud-download-outline" size={20} color={theme.primary} />
              )}
            </View>
            <View className="flex-1">
              <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.4, textTransform: "uppercase" }}>
                {downloadConfirmationLocked ? "Locked video" : "Save offline"}
              </Text>
              <Text className="mt-0.5" style={{ color: theme.textSoft, fontSize: 12, lineHeight: 16 }}>
                {downloadConfirmationLocked
                  ? `Downloading will unlock it and deduct ${downloadUnlockCost} Coin/Star${downloadUnlockCost === 1 ? "" : "s"}.`
                  : "Download this video for offline viewing?"}
              </Text>
            </View>
          </View>

          {downloadConfirmationLocked && (
            <View
              className="mb-4 flex-row items-center justify-between rounded-2xl px-4 py-3"
              style={{
                borderWidth: 1,
                borderColor: theme.accentAmber,
                backgroundColor: theme.accentAmberSoft,
              }}
            >
              <View className="flex-row items-center" style={{ gap: 10 }}>
                <View
                  className="items-center justify-center rounded-2xl"
                  style={{
                    height: 36,
                    width: 36,
                    backgroundColor: theme.accentAmberSoft,
                    borderWidth: 1,
                    borderColor: theme.accentAmber,
                  }}
                >
                  <StarIcon size={18} color={theme.coin} />
                </View>
                <View>
                  <Text style={{ color: theme.textSoft, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", fontWeight: "700" }}>
                    Unlock cost
                  </Text>
                  <Text className="font-psemibold mt-0.5" style={{ color: theme.text, fontSize: 14 }}>
                    {downloadUnlockCost} Coin/Star{downloadUnlockCost === 1 ? "" : "s"}
                  </Text>
                </View>
              </View>
              <Text style={{ color: theme.accentAmber, fontSize: 11, fontWeight: "700", letterSpacing: 0.3, textTransform: "uppercase" }}>
                Unlock & save
              </Text>
            </View>
          )}

          <View className="flex-row items-center" style={{ gap: 10 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => closeDownloadConfirmation(false)}
              className="flex-1 items-center justify-center rounded-2xl px-4 py-3"
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
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => closeDownloadConfirmation(true)}
              className="flex-1 flex-row items-center justify-center rounded-2xl px-4 py-3"
              style={{
                backgroundColor: downloadConfirmationLocked ? theme.accentAmber : theme.primary,
                borderWidth: 1,
                borderColor: downloadConfirmationLocked ? theme.accentAmber : theme.primary,
                shadowColor: downloadConfirmationLocked ? theme.accentAmber : theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.4,
                shadowRadius: 10,
                elevation: 4,
              }}
            >
              <MaterialCommunityIcons
                name={downloadConfirmationLocked ? "lock-open-variant-outline" : "cloud-download-outline"}
                size={16}
                color="#FFFFFF"
                style={{ marginRight: 6 }}
              />
              <Text className="font-psemibold" style={{ color: "#FFFFFF", fontSize: 13, letterSpacing: 0.4, textTransform: "uppercase" }}>
                {downloadConfirmationLocked ? "Unlock & Download" : "Download"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <VideosDownloadQualityModal
        showCoinOverlay={showCoinOverlay}
        downloadQualityPickerVisible={downloadQualityPickerVisible}
        downloadQualityPickerOptions={downloadQualityPickerOptions}
        closeDownloadQualityPicker={closeDownloadQualityPicker}
      />
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} iconName="download" iconColor={theme.primary} />
    </StyledSafeAreaView>
  );
};

export default VideoPlayer;

const styles = StyleSheet.create({
  coinPill: {
    marginLeft: 10,
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
