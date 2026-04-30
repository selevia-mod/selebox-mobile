import { AntDesign, Feather } from "@expo/vector-icons";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/utils/format-number";
import logger from "../lib/utils/logger";
import { createPostLike, deletePostLike, getPostLike, updatePost } from "../lib/posts";
import { DEFAULT_REACTION_KEY, getReactionByKey } from "../lib/reactions";
import ReactionPicker from "./ReactionPicker";

// Premium action bar — mirrors web's post-actions layout (Like alone-left, then
// Comment / Repost / Share grouped right) with a violet-tinted reaction picker
// surfaced on long-press of the Like button. Backend wiring stays binary
// like/unlike (Appwrite's existing model); reaction selection is local UI
// state that maps to a "liked" record. Real per-emoji storage will land with
// Phase 5 of the Supabase migration (web's `reactions` table).
const PostInformation = ({ item, handleLikesPress, handleCommentPress, handleSharePress, onLikeChange, onDarkSurface = false }) => {
  const postID = item?.$id;
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(item?.postLikes ?? 0);
  const [userReactionKey, setUserReactionKey] = useState(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState(null);

  const likedRef = useRef(false);
  const likeCountRef = useRef(0);
  const debounceRef = useRef(null);
  const likeButtonRef = useRef(null);

  // Web tokens ported: reacted state uses pink/magenta (#f472b6 dark, #db2777
  // light) and the "premium violet" tint for hover/active states.
  const reactedColor = theme.isDark ? "#f472b6" : "#db2777";
  const reactedSoft = theme.isDark ? "rgba(244, 114, 182, 0.10)" : "rgba(219, 39, 119, 0.08)";

  likedRef.current = liked;
  likeCountRef.current = likeCount;

  useEffect(() => {
    setLikeCount(item?.postLikes ?? 0);
  }, [item?.postLikes]);

  useEffect(() => {
    let isCancelled = false;

    if (typeof item?.isLikedByCurrentUser === "boolean") {
      setLiked(item.isLikedByCurrentUser);
      setUserReactionKey(item.isLikedByCurrentUser ? DEFAULT_REACTION_KEY : null);
      return () => {
        isCancelled = true;
      };
    }

    if (!postID || !user?.$id) {
      setLiked(false);
      setUserReactionKey(null);
      return () => {
        isCancelled = true;
      };
    }

    const handleGetLike = async () => {
      try {
        const response = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (!isCancelled) {
          const isLiked = response?.documents?.length > 0;
          setLiked(isLiked);
          setUserReactionKey(isLiked ? DEFAULT_REACTION_KEY : null);
        }
      } catch (error) {
        logger.error("PostInformation", "getPostLike failed", error);
        if (!isCancelled) {
          setLiked(false);
          setUserReactionKey(null);
        }
      }
    };

    handleGetLike();

    return () => {
      isCancelled = true;
    };
  }, [item?.isLikedByCurrentUser, postID, user?.$id]);

  const syncLike = async () => {
    try {
      if (likedRef.current) {
        const existing = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (!existing?.documents?.length) await createPostLike({ postId: postID, likeOwner: user?.$id });
      } else {
        const existing = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (existing?.documents?.[0]) await deletePostLike({ postLikeId: existing.documents[0].$id });
      }
      await updatePost({ ID: postID, postLikes: likeCountRef.current });
    } catch (error) {
      logger.error("PostInformation", "syncLike failed", error);
    }
  };

  const applyLikeChange = (newLiked) => {
    const currentCount = Number.isFinite(likeCount) ? likeCount : 0;
    let nextCount = currentCount;
    if (newLiked && !liked) nextCount = currentCount + 1;
    if (!newLiked && liked) nextCount = Math.max(0, currentCount - 1);

    setLiked(newLiked);
    setLikeCount(nextCount);
    onLikeChange?.(postID, nextCount, newLiked);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(syncLike, 500);
  };

  const handleLikeTap = () => {
    if (!postID || !user?.$id) return;
    if (userReactionKey) {
      setUserReactionKey(null);
      applyLikeChange(false);
    } else {
      setUserReactionKey(DEFAULT_REACTION_KEY);
      applyLikeChange(true);
    }
  };

  const handleLikeLongPress = () => {
    if (!postID || !user?.$id) return;
    likeButtonRef.current?.measureInWindow?.((x, y, width, height) => {
      setPickerAnchor({ x, y, width, height });
      setPickerVisible(true);
    });
  };

  const handlePickReaction = (key) => {
    setUserReactionKey(key);
    if (!liked) applyLikeChange(true);
  };

  const handleComment = () => handleCommentPress?.(item);
  const handleShowLikes = () => handleLikesPress?.(item);
  const handleShare = async () => handleSharePress?.(item);
  const handleRepost = () =>
    Alert.alert(
      "Repost — coming soon",
      "Reposts ship with Phase 5 of the Supabase migration. The button is here so you can preview the new home feed layout.",
    );

  const activeReaction = userReactionKey ? getReactionByKey(userReactionKey) : null;
  const likeLabel = activeReaction?.label ?? "Like";
  const summaryEmoji = activeReaction?.emoji ?? "❤️";
  const showLikeAccent = !!activeReaction;

  const commentCount = Number(item?.postComments) || 0;
  const safeLikeCount = Number.isFinite(likeCount) ? likeCount : 0;
  const showStatsRow = safeLikeCount > 0 || commentCount > 0;

  // When rendered over a dark image-viewer overlay, force high-contrast white-ish
  // colors instead of the theme's regular muted tones (which can vanish on black
  // backgrounds in light mode).
  const labelColor = onDarkSurface ? "rgba(255,255,255,0.92)" : theme.textMuted ?? theme.text;
  const iconColor = onDarkSurface ? "rgba(255,255,255,0.92)" : theme.icon;
  const subtleTextColor = onDarkSurface ? "rgba(255,255,255,0.7)" : theme.textSoft ?? labelColor;
  const dividerColor = onDarkSurface ? "rgba(255,255,255,0.18)" : theme.border;

  return (
    <View style={{ paddingHorizontal: 16 }}>
      {/* Stats row — emoji + count on left, comment count on right (matches web) */}
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
            <TouchableOpacity onPress={handleShowLikes} activeOpacity={0.7} style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={{ fontSize: 14, marginRight: 6 }}>{summaryEmoji}</Text>
              <Text style={{ fontSize: 12, fontWeight: "500", color: subtleTextColor }}>
                {FormatNumber(safeLikeCount)}
              </Text>
            </TouchableOpacity>
          ) : (
            <View />
          )}
          {commentCount > 0 ? (
            <TouchableOpacity onPress={handleComment} activeOpacity={0.7}>
              <Text style={{ fontSize: 12, fontWeight: "500", color: subtleTextColor }}>
                {FormatNumber(commentCount)} {commentCount === 1 ? "comment" : "comments"}
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
          borderTopColor: dividerColor,
        }}
      >
        <TouchableOpacity
          ref={likeButtonRef}
          onPress={handleLikeTap}
          onLongPress={handleLikeLongPress}
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
          {activeReaction ? (
            <Text style={{ fontSize: 18, marginRight: 8 }}>{activeReaction.emoji}</Text>
          ) : (
            <AntDesign name="hearto" size={18} color={iconColor} style={{ marginRight: 8 }} />
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

        <TouchableOpacity onPress={handleComment} activeOpacity={0.85} style={secondaryActionStyle}>
          <Feather name="message-circle" size={17} color={iconColor} style={{ marginRight: 6 }} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Comment</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleRepost} activeOpacity={0.85} style={secondaryActionStyle}>
          <Feather name="repeat" size={17} color={iconColor} style={{ marginRight: 6 }} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Repost</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleShare} activeOpacity={0.85} style={secondaryActionStyle}>
          <Feather name="share-2" size={17} color={iconColor} style={{ marginRight: 6 }} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: labelColor }}>Share</Text>
        </TouchableOpacity>
      </View>

      <ReactionPicker
        visible={pickerVisible}
        anchor={pickerAnchor}
        activeKey={userReactionKey}
        onSelect={handlePickReaction}
        onClose={() => setPickerVisible(false)}
      />
    </View>
  );
};

const secondaryActionStyle = {
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: 9,
  paddingHorizontal: 8,
  borderRadius: 12,
  marginLeft: 2,
};

export default memo(PostInformation);
