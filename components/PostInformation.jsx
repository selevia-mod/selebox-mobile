import { AntDesign, Feather } from "@expo/vector-icons";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/utils/format-number";
import logger from "../lib/utils/logger";
import { createPostLike, deletePostLike, getPostLike, updatePost } from "../lib/posts";
import { DEFAULT_REACTION_KEY, getReactionByKey } from "../lib/reactions";
import { getMyReaction, removeMyReaction, setReaction } from "../lib/reactions-supabase";
import ReactionPicker from "./ReactionPicker";
import RepostModal from "./RepostModal";

// Premium action bar — mirrors web's post-actions layout (Like alone-left, then
// Comment / Repost / Share grouped right) with a violet-tinted reaction picker
// surfaced on long-press of the Like button. On Supabase posts (detected via
// `_supabase`) the picked emoji writes through to the polymorphic `reactions`
// table; on legacy Appwrite posts it stays a local-only UI flourish over the
// backend's binary like/unlike model.
const PostInformation = ({ item, handleLikesPress, handleCommentPress, handleSharePress, onLikeChange, onDarkSurface = false }) => {
  const postID = item?.$id;
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();

  // Phase C.6 — detect whether this post came from Supabase. Posts shaped by
  // `adaptSupabasePostToAppwriteShape` carry their raw row under `_supabase`,
  // which is our signal to read/write reactions through `lib/reactions-supabase`
  // instead of the legacy Appwrite postsLike collection. Posts authored on
  // Appwrite (Following + For-You tabs while USE_SUPABASE_POSTS is half-rolled)
  // continue down the original path.
  const isSupabasePost = Boolean(item?._supabase);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(item?.postLikes ?? 0);
  const [userReactionKey, setUserReactionKey] = useState(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState(null);
  // Phase C — repost modal visibility. Tapping the Repost button opens
  // the RepostModal, which writes to Supabase via createRepost.
  const [repostModalVisible, setRepostModalVisible] = useState(false);

  const likedRef = useRef(false);
  const likeCountRef = useRef(0);
  const userReactionKeyRef = useRef(null);
  const debounceRef = useRef(null);
  const likeButtonRef = useRef(null);

  // Web tokens ported: reacted state uses pink/magenta (#f472b6 dark, #db2777
  // light) and the "premium violet" tint for hover/active states.
  const reactedColor = theme.isDark ? "#f472b6" : "#db2777";
  const reactedSoft = theme.isDark ? "rgba(244, 114, 182, 0.10)" : "rgba(219, 39, 119, 0.08)";

  likedRef.current = liked;
  likeCountRef.current = likeCount;
  userReactionKeyRef.current = userReactionKey;

  useEffect(() => {
    setLikeCount(item?.postLikes ?? 0);
  }, [item?.postLikes]);

  useEffect(() => {
    let isCancelled = false;

    // Phase C.6 — Supabase posts ALWAYS read their like state from the
    // reactions table. Order matters: this branch runs before the
    // `isLikedByCurrentUser` shortcut because the home feed's batched
    // Appwrite enricher may stamp `isLikedByCurrentUser=false` on
    // adapted Supabase posts (UUIDs don't exist in postsLike), and
    // honoring it would silently mark reacted posts as unliked. The
    // returned emoji string IS our reaction key (web's REACTIONS match:
    // heart/laugh/sad/cry/angry).
    if (isSupabasePost && postID && user?.$id) {
      const handleGetSupabaseReaction = async () => {
        try {
          const emoji = await getMyReaction({ targetType: "post", targetId: postID });
          if (!isCancelled) {
            setUserReactionKey(emoji || null);
            setLiked(Boolean(emoji));
          }
        } catch (error) {
          logger.error("PostInformation", "getMyReaction (supabase) failed", error);
          if (!isCancelled) {
            setLiked(false);
            setUserReactionKey(null);
          }
        }
      };
      handleGetSupabaseReaction();
      return () => {
        isCancelled = true;
      };
    }

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
  }, [item?.isLikedByCurrentUser, postID, user?.$id, isSupabasePost]);

  const syncLike = async () => {
    try {
      // Phase C.6 — Supabase write path. The reactions table is the source of
      // truth for like state on Supabase posts; counts are derived via
      // fetchPostStats so we don't denormalize a post_likes column. We just
      // mirror userReactionKeyRef into the table:
      //   - has key  → setReaction (idempotent — handles new + change cases)
      //   - cleared  → removeMyReaction (idempotent — no-op if nothing there)
      if (isSupabasePost) {
        const currentKey = userReactionKeyRef.current;
        if (currentKey) {
          await setReaction({ targetType: "post", targetId: postID, emoji: currentKey });
        } else {
          await removeMyReaction({ targetType: "post", targetId: postID });
        }
        return;
      }

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
    const wasLiked = liked;
    const previousKey = userReactionKey;
    setUserReactionKey(key);

    if (!wasLiked) {
      // Transitioning from unliked → liked. applyLikeChange bumps the count
      // and schedules syncLike, which on Supabase will write the picked emoji
      // (because userReactionKeyRef updates synchronously each render).
      applyLikeChange(true);
      return;
    }

    // Already liked — only the emoji is changing. For Supabase posts we still
    // need to push the change to the reactions table; for Appwrite posts the
    // emoji is purely client-side UI so no roundtrip needed.
    if (isSupabasePost && previousKey !== key) {
      onLikeChange?.(postID, likeCountRef.current, true);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(syncLike, 500);
    }
  };

  const handleComment = () => handleCommentPress?.(item);
  const handleShowLikes = () => handleLikesPress?.(item);
  const handleShare = async () => handleSharePress?.(item);
  const handleRepost = () => setRepostModalVisible(true);

  // Closes the repost modal. If `repost` is passed, the user successfully
  // submitted — surface a friendly Alert so they know it landed. The home
  // feed picks up the new repost on next focus / pull-to-refresh.
  const handleRepostClose = (repost) => {
    setRepostModalVisible(false);
    if (repost) {
      Alert.alert("Reposted!", "Your repost is live and visible to everyone on Selebox.");
    }
  };

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
  const labelColor = onDarkSurface ? "rgba(255,255,255,0.92)" : (theme.textMuted ?? theme.text);
  const iconColor = onDarkSurface ? "rgba(255,255,255,0.92)" : theme.icon;
  const subtleTextColor = onDarkSurface ? "rgba(255,255,255,0.7)" : (theme.textSoft ?? labelColor);
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
              <Text style={{ fontSize: 12, fontWeight: "500", color: subtleTextColor }}>{FormatNumber(safeLikeCount)}</Text>
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

      <RepostModal visible={repostModalVisible} onClose={handleRepostClose} originalPost={item} currentUser={user} />
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
