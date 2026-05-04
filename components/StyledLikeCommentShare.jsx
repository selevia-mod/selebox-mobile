import { AntDesign, Feather, FontAwesome, MaterialIcons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import { useVideosStats } from "../context/video-stats-provider";
import useAppTheme from "../hooks/useAppTheme";
import useCommentReactionState from "../hooks/useCommentReactionState";
import FormatNumber from "../lib/utils/format-number";
import { resolveVideoCommentCount } from "../lib/video";
import secrets from "../private/secrets";
import ReactionPicker from "./ReactionPicker";
import RepostModal from "./RepostModal";
import StyledDivider from "./StyledDivider";

export default function StyledLikeCommentShare({
  item,
  following,
  downloaded,
  downloading = false,
  downloadDisabled = false,
  downloadLabel,
  variant = "default",
  onCommentPress,
  onSharePress,
  onDownloadPress,
  onFollowPress,
  showCommentButton = false,
  showDownloadButton = false,
  showFollowButton = false,
  ...props
}) {
  const videoID = item?.$id;
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const { getVideoStats, loadVideoStats, toggleLike, updateVideoStats } = useVideosStats();
  const initialCommentCount = resolveVideoCommentCount(item);

  useEffect(() => {
    if (!videoID) return;

    const existing = getVideoStats(videoID);

    if (
      initialCommentCount !== null &&
      existing.commentsCount !== initialCommentCount &&
      (existing.commentsCount === undefined || (existing.commentsCount === 0 && initialCommentCount > 0))
    ) {
      updateVideoStats(videoID, { commentsCount: initialCommentCount });
    }

    if (user?.$id) {
      if (existing.videoLikes !== undefined) return;
      loadVideoStats(videoID, user.$id);
    }
  }, [getVideoStats, initialCommentCount, loadVideoStats, updateVideoStats, user?.$id, videoID]);

  const stats = getVideoStats(videoID);
  const liked = stats.liked ?? false;
  const likeCount = stats.videoLikes ?? 0;
  const commentsCount = stats.commentsCount ?? initialCommentCount ?? 0;

  const likeColor = theme.like;
  const commentColor = theme.comment;

  // Reaction overlay (visual layer over the existing toggleLike binary).
  const reactions = useCommentReactionState({ initialLiked: liked });

  const handleReactionTap = useCallback(() => {
    const wasReacted = !!reactions.userReactionKey;
    reactions.toggleTopLevelDefault();
    // Sync server-side like to match reaction presence.
    const targetLiked = !wasReacted;
    if (targetLiked !== liked) {
      toggleLike(item, user);
    }
  }, [item, liked, reactions, toggleLike, user]);

  const handlePickReactionWithSync = useCallback(
    (key) => {
      reactions.handlePickReaction(key);
      if (!liked) toggleLike(item, user);
    },
    [item, liked, reactions, toggleLike, user],
  );

  // Phase C — Repost. Tapping the button opens the RepostModal which
  // writes a new post to Supabase with `reposted_from` set to the current
  // post's id. Mirrors PostInformation.jsx's wiring.
  const [repostModalVisible, setRepostModalVisible] = useState(false);
  const handleRepost = () => setRepostModalVisible(true);
  const handleRepostClose = (repost) => {
    setRepostModalVisible(false);
    if (repost) {
      Alert.alert("Reposted!", "Your repost is live and visible to everyone on Selebox.");
    }
  };

  const handleShare = async () => {
    try {
      if (onSharePress) return onSharePress(item);
      // Default fallback branch — only ever invoked for VIDEOS in
      // practice (the message text is video-specific; books and posts
      // pass an onSharePress that short-circuits above). Books wire
      // their own goal tick at their share handler. Posts intentionally
      // do NOT count toward the share goal per product spec.
      const result = await Share.open({
        message: `Check out this video!`,
        url: `${secrets.WEBSITE}${item.uri}`,
        title: item.title,
        type: "url",
      });
      // ABUSE DEFENSE (two layers):
      //  1. We only tick when Share.open resolves with success === true.
      //     react-native-share's contract is inconsistent across platforms:
      //     iOS throws "User did not share" on dismiss (caught below), but
      //     Android sometimes RESOLVES with { success: false, ... } when
      //     the user backs out of the chooser without picking an app.
      //     Treating a resolved promise as "shared" was the bug — users
      //     could open and dismiss to farm the goal. Now we require
      //     `result?.success === true` (the field set by RN-Share when
      //     the activity actually completed).
      //  2. Per-video dedup so re-sharing the same video doesn't farm.
      //     Cross-day shares of the same video legitimately re-tick.
      if (result?.success === true && item?.$id) {
        const { tickGoalUnique } = await import("../lib/goals-store");
        tickGoalUnique("share", `share:video:${item.$id}`);
      }
    } catch (e) {
      // User dismissed the share sheet (iOS path throws here) — no tick.
    }
  };

  // === Feed Variant === (mirrors PostInformation visual style)
  if (variant === "feed") {
    const safeLikeCount = Number.isFinite(likeCount) ? likeCount : 0;
    const safeCommentCount = Number.isFinite(commentsCount) ? commentsCount : 0;
    const showStatsRow = safeLikeCount > 0 || safeCommentCount > 0;
    const summaryEmoji = reactions.activeReaction?.emoji ?? "❤️";
    const showLikeAccent = !!reactions.activeReaction;
    const labelColor = theme.textMuted ?? theme.text;
    const reactedColor = theme.isDark ? "#f472b6" : "#db2777";
    const reactedSoft = theme.isDark ? "rgba(244, 114, 182, 0.10)" : "rgba(219, 39, 119, 0.08)";
    const likeLabel = reactions.activeReaction?.label ?? (liked ? "Liked" : "Like");

    return (
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        {/* Stats row — emoji + count on left, comment count on right */}
        {showStatsRow && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 10,
              paddingBottom: 6,
            }}
          >
            {safeLikeCount > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={{ fontSize: 14, marginRight: 6 }}>{summaryEmoji}</Text>
                <Text style={{ fontSize: 12, fontWeight: "500", color: theme.textSoft ?? labelColor }}>{FormatNumber(safeLikeCount)}</Text>
              </View>
            ) : (
              <View />
            )}
            {safeCommentCount > 0 ? (
              <TouchableOpacity onPress={() => onCommentPress?.(item)} activeOpacity={0.7}>
                <Text style={{ fontSize: 12, fontWeight: "500", color: theme.textSoft ?? labelColor }}>
                  {FormatNumber(safeCommentCount)} {safeCommentCount === 1 ? "comment" : "comments"}
                </Text>
              </TouchableOpacity>
            ) : (
              <View />
            )}
          </View>
        )}

        {/* Action bar */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingTop: 8,
            paddingBottom: 8,
            borderTopWidth: 1,
            borderTopColor: theme.border,
          }}
        >
          <TouchableOpacity
            ref={reactions.likeButtonRef}
            onPress={handleReactionTap}
            onLongPress={reactions.openTopLevelPicker}
            delayLongPress={220}
            activeOpacity={0.85}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 9,
              paddingHorizontal: 14,
              borderRadius: 12,
              backgroundColor: showLikeAccent ? reactedSoft : "transparent",
            }}
          >
            {reactions.activeReaction ? (
              <Text style={{ fontSize: 18, marginRight: 8 }}>{reactions.activeReaction.emoji}</Text>
            ) : (
              <AntDesign name="hearto" size={18} color={theme.icon} style={{ marginRight: 8 }} />
            )}
            <Text
              style={{
                fontSize: 13,
                fontWeight: showLikeAccent ? "600" : "500",
                color: showLikeAccent ? reactedColor : labelColor,
              }}
            >
              {likeLabel}
            </Text>
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          {showCommentButton && (
            <TouchableOpacity onPress={onCommentPress} activeOpacity={0.85} style={secondaryFeedActionStyle}>
              <Feather name="message-circle" size={17} color={theme.icon} style={{ marginRight: 6 }} />
              <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Comment</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={handleRepost} activeOpacity={0.85} style={secondaryFeedActionStyle}>
            <Feather name="repeat" size={17} color={theme.icon} style={{ marginRight: 6 }} />
            <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Repost</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleShare} activeOpacity={0.85} style={secondaryFeedActionStyle}>
            <Feather name="share-2" size={17} color={theme.icon} style={{ marginRight: 6 }} />
            <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Share</Text>
          </TouchableOpacity>
        </View>

        <ReactionPicker
          visible={reactions.pickerVisible}
          anchor={reactions.pickerAnchor}
          activeKey={reactions.pickerActiveKey}
          onSelect={handlePickReactionWithSync}
          onClose={reactions.closePicker}
        />

        <RepostModal visible={repostModalVisible} onClose={handleRepostClose} originalPost={item} currentUser={user} />
      </View>
    );
  }

  // === Default Variant (Player Overlay Style) ===
  return (
    <View className="flex flex-row items-center space-x-2" {...props}>
      {showFollowButton && (
        <TouchableOpacity
          onPress={onFollowPress}
          activeOpacity={1.0}
          className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <MaterialIcons name={following ? "person-remove" : "person-add"} size={12} color={following ? theme.accentPurple : theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: following ? theme.accentPurple : theme.text }}>
            {following ? "Following" : "Follow"}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        ref={reactions.likeButtonRef}
        onPress={handleReactionTap}
        onLongPress={reactions.openTopLevelPicker}
        delayLongPress={220}
        activeOpacity={0.85}
        className="flex flex-row items-center space-x-1 rounded-full px-3 py-2"
        style={{ backgroundColor: theme.surfaceStrong, opacity: 0.85 }}
      >
        {reactions.activeReaction ? (
          // lineHeight intentionally larger than fontSize — emoji glyphs have rounded
          // descenders (the bottom of a heart, the chin of a 😢, etc.) that get clipped
          // when lineHeight ≈ fontSize. 1.3× is the safe ratio across iOS and Android.
          <Text style={{ fontSize: 13, lineHeight: 17 }}>{reactions.activeReaction.emoji}</Text>
        ) : liked ? (
          <AntDesign name="heart" size={12} color={theme.accentPurple} />
        ) : (
          <AntDesign name="like1" size={12} color={theme.icon} />
        )}
        <Text
          className="font-sans text-sm font-medium"
          style={{ color: reactions.activeReaction ? theme.accentPurple : liked ? theme.accentPurple : theme.text }}
        >
          {reactions.activeReaction?.label ?? (liked ? "Liked" : "Like")}
        </Text>
      </TouchableOpacity>

      {showCommentButton && (
        <TouchableOpacity
          onPress={onCommentPress}
          activeOpacity={0.85}
          className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <Feather name="message-circle" size={12} color={theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
            Comment
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={handleRepost}
        activeOpacity={0.85}
        className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
        style={{ backgroundColor: theme.surfaceStrong }}
      >
        <Feather name="repeat" size={12} color={theme.icon} />
        <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
          Repost
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={handleShare}
        activeOpacity={0.85}
        className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
        style={{ backgroundColor: theme.surfaceStrong }}
      >
        <Feather name="share-2" size={12} color={theme.icon} />
        <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
          Share
        </Text>
      </TouchableOpacity>

      {showDownloadButton && (
        <TouchableOpacity
          onPress={onDownloadPress}
          disabled={downloadDisabled}
          activeOpacity={1.0}
          className={`flex flex-row items-center space-x-1 rounded-full px-3 py-2 ${downloadDisabled ? "opacity-40" : "opacity-70"}`}
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <FontAwesome name="download" size={12} color={downloaded || downloading ? theme.accentPurple : theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: downloaded || downloading ? theme.accentPurple : theme.text }}>
            {downloadLabel || (downloading ? "Downloading..." : downloaded ? "Downloaded" : "Download")}
          </Text>
        </TouchableOpacity>
      )}

      <ReactionPicker
        visible={reactions.pickerVisible}
        anchor={reactions.pickerAnchor}
        activeKey={reactions.pickerActiveKey}
        onSelect={handlePickReactionWithSync}
        onClose={reactions.closePicker}
      />

      <RepostModal visible={repostModalVisible} onClose={handleRepostClose} originalPost={item} currentUser={user} />
    </View>
  );
}

const secondaryFeedActionStyle = {
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: 9,
  paddingHorizontal: 8,
  borderRadius: 12,
  marginLeft: 2,
};
