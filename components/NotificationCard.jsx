import { router } from "expo-router";
import { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { INLINE_COMMENT_NOTIFICATION_TYPE, parseInlineCommentNotificationResourceId } from "../lib/book-inline-comments";
import {
  NotificationService,
  buildBookChapterNotificationNavigationParams,
  buildBookNotificationNavigationParams,
  buildPostNotificationNavigationParams,
  buildVideoNotificationNavigationParams,
} from "../lib/notifications";
import { deleteNotification, markChatNotificationsRead } from "../lib/notifications-supabase";
import { isUnlocked as secretIsUnlocked } from "../lib/secret-lock";
import TimeAgo from "../lib/utils/time-ago";
import { stripMentionMarkup } from "../lib/user-mentions";
import UserAvatar from "./UserAvatar";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const normalizeText = (value) => (typeof value === "string" ? stripMentionMarkup(value).replace(/\s+/g, " ").trim() : "");

const truncateText = (value, maxLength = 90) => {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const appendSnippet = (baseText, snippet, maxLength) => {
  const snippetText = truncateText(snippet, maxLength);
  if (!snippetText) return baseText;
  return `${baseText}: "${snippetText}"`;
};

// Module-level singleton — was being instantiated per render before.
const notificationService = new NotificationService();

const NotificationCard = ({ item, onViewed, onDeleted }) => {
  const { theme } = useAppTheme();
  const notificationType = typeof item?.type === "string" ? item.type.toLowerCase() : "";
  const focusResourceType = item?.focusResourceType || null;

  // Chat-flavored notifications — broad match used only for downstream
  // routing (the dm_message handler navigates to the conversation/inbox).
  // Privacy treatment is gated SEPARATELY on `isPrivateDm` below so
  // regular DMs don't get shielded.
  const isChatMessage =
    notificationType.includes("message") ||
    notificationType === "dm-message" ||
    notificationType === "dm_message" ||
    item?.targetType === "message" ||
    item?.targetType === "conversation";

  // Privacy treatment ("Someone sent you a private message", lock-icon
  // avatar, no preview, no thumbnail) fires ONLY for Secret-chat DMs.
  // The is_secret flag arrives from the Supabase adapter
  // (lib/notifications-supabase.js) which reads it off
  // notifications.metadata.is_secret — written by the chat-bell trigger
  // (migration_notifications_dm_secret_flag.sql) and backfilled for
  // historical rows. Regular DMs render with the real sender name,
  // real avatar, and the existing "sent you a message: '<preview>'" line.
  const isPrivateDm = isChatMessage && Boolean(item?.isSecret);

  let avatarUri = item?.sender?.avatar;
  if (notificationType === "video-upload") {
    avatarUri = item?.recipient?.avatar;
  }
  if (isPrivateDm) {
    // Hide the sender's avatar in the bell row — replaced with a generic
    // lock icon further down so an over-the-shoulder reader can't tell
    // who's messaging you.
    avatarUri = null;
  }
  const thumbnailUri = isPrivateDm ? null : item?.resourceData?.thumbnail;
  const isUnread = item?.isViewed === false;
  const senderName = isPrivateDm ? "Someone" : (item?.sender?.username || "Someone");
  // Grouped-row display name (Facebook-style aggregation). When the
  // adapter collapsed N notifications about the same target into one
  // row, render the actors as "Alice and Bob" / "Alice, Bob and 3
  // others" instead of just the head sender. Falls through to plain
  // senderName for ungrouped rows.
  const groupedActorsForDisplay = Array.isArray(item?.groupedActors) ? item.groupedActors : null;
  const groupedCountForDisplay = Number(item?.groupedCount) || 0;
  const displayName = (() => {
    if (isPrivateDm || !groupedActorsForDisplay || groupedCountForDisplay <= 1) return senderName;
    const names = groupedActorsForDisplay.map((a) => a?.username).filter(Boolean);
    if (names.length === 0) return senderName;
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    const remaining = groupedCountForDisplay - 2;
    if (remaining <= 0) return `${names[0]} and ${names[1]}`;
    return `${names[0]}, ${names[1]} and ${remaining} ${remaining === 1 ? "other" : "others"}`;
  })();
  const baseMessage = isPrivateDm ? "" : normalizeText(item?.message);
  const videoTitle = normalizeText(item?.resourceData?.title);
  const postTitle = normalizeText(item?.resourceData?.post || item?.resourceData?.title);
  const bookTitle = normalizeText(item?.resourceData?.title);
  const chapterTitle = normalizeText(item?.resourceData?.title);
  const focusCommentText = normalizeText(item?.focusCommentText);
  const messageText = (() => {
    // Comment / reply cards. Note: under the Supabase notifications path,
    // `message` carries the comment body itself (the trigger writes
    // new.body into submit_notification's p_message). So baseMessage is
    // the snippet, not the prefix — flip the appendSnippet args. Under
    // legacy Appwrite, message was empty so we fall through to the
    // hard-coded prefix and the comment body just isn't shown. That's a
    // fine degradation for old rows.
    if (notificationType === "video-reply" || notificationType === "post-reply") {
      return appendSnippet("replied to your comment", baseMessage || focusCommentText, 80);
    }

    if (notificationType === "book-reply" || notificationType === "book-chapter-reply") {
      return appendSnippet("replied to your comment", baseMessage || focusCommentText, 80);
    }

    if (notificationType === "video-comment") {
      return appendSnippet("commented on your video", baseMessage || videoTitle, 90);
    }

    if (notificationType === "post-comment") {
      return appendSnippet("commented on your post", baseMessage || postTitle, 90);
    }

    if (notificationType === "book-comment") {
      return appendSnippet("commented on your book", baseMessage || bookTitle, 90);
    }

    if (notificationType === "book-chapter-comment") {
      return appendSnippet("commented on your chapter", baseMessage || chapterTitle, 90);
    }

    if (notificationType === INLINE_COMMENT_NOTIFICATION_TYPE) {
      return appendSnippet("commented on a passage", baseMessage || focusCommentText, 90);
    }

    // ── Reaction cards (Supabase: post-like, video-like, book-like,
    //    post-comment-like — all kebab-form after SUPABASE_TYPE_TO_KEBAB).
    //    Appwrite legacy types live alongside the new ones for back-compat.
    if (notificationType === "post-like") return "reacted to your post";
    if (notificationType === "video-like") return "reacted to your video";
    if (notificationType === "book-like") return "reacted to your book";
    if (notificationType === "post-comment-like" || notificationType === "video-comment-like") {
      return "reacted to your comment";
    }

    // ── Repost cards
    if (notificationType === "post-repost") return "reposted your post";

    // ── Follow cards
    if (notificationType === "follow") return "started following you";
    if (notificationType === "follow-new-post") return "shared a new post";
    if (notificationType === "follow-new-video") return "uploaded a new video";
    if (notificationType === "follow-new-book") return "published a new book";
    if (notificationType === "follow-repost") return "reposted a post";

    // ── Mention cards
    if (notificationType === "mention-comment" || notificationType === "mention-chapter-comment") {
      return appendSnippet("mentioned you in a comment", baseMessage || focusCommentText, 90);
    }

    // ── DM / private message — privacy-shielded text. The avatar is
    //   already overridden to a lock icon at the top of the component,
    //   and senderName is overridden to "Someone". The bell row reads
    //   "Someone sent you a private message" with no actor name and no
    //   message preview, regardless of what was actually sent. Tap the
    //   row to open the inbox if you want to read the actual content.
    //   Gated on isPrivateDm (Secret only) — regular DMs fall through
    //   to baseMessage which is the adapter-built "sent you a message:
    //   '<preview>'" string.
    if (isPrivateDm) {
      return "sent you a private message";
    }

    return baseMessage || "No message";
  })();
  const createdAtLabel = item?.$createdAt ? TimeAgo(item?.$createdAt) : "";
  const focusCommentId = item?.focusCommentId || null;
  const focusReplyId = item?.focusReplyId || null;
  const focusVideoId = item?.focusVideoId || item?.resourceData?.$id || null;
  const focusPostId = item?.focusPostId || item?.resourceData?.$id || item?.resourceId || null;
  const focusBookId = item?.focusBookId || item?.resourceData?.$id || item?.resourceId || null;
  const focusChapterId = item?.focusChapterId || item?.resourceData?.$id || item?.resourceId || null;
  const resolvedVideoNotificationId = focusVideoId || item?.resourceData?.$id || item?.resourceId || null;
  const isVideoNotification = focusResourceType === "video" || notificationType.startsWith("video");
  const isPostNotification = focusResourceType === "post" || notificationType.startsWith("post");
  const isBookNotification =
    focusResourceType === "book" || notificationType === "book" || notificationType === "book-comment" || notificationType === "book-reply";
  const isBookChapterNotification =
    focusResourceType === "book-chapter" ||
    notificationType === "book-chapter" ||
    notificationType === "book-chapter-comment" ||
    notificationType === "book-chapter-reply";
  const isInlineCommentNotification = notificationType === INLINE_COMMENT_NOTIFICATION_TYPE;
  const shouldOpenPostCommentSection =
    isPostNotification &&
    Boolean(focusPostId && (focusCommentId || focusReplyId || notificationType === "post-comment" || notificationType === "post-reply"));
  const shouldOpenBookChapterCommentSection =
    isBookChapterNotification &&
    Boolean(
      focusChapterId && (focusCommentId || focusReplyId || notificationType === "book-chapter-comment" || notificationType === "book-chapter-reply"),
    );
  const hasThumbnail = Boolean(thumbnailUri);
  const inlineCommentRoute = parseInlineCommentNotificationResourceId(item?.resourceId);

  const handleNotificationPress = async () => {
    // ── Private (Secret) DM — privacy-first handling ──────────────────
    // The user explicitly asked for two behaviors here:
    //   1. Tapping a private-message bell row should require auth (PIN
    //      / biometric) BEFORE the conversation thread renders.
    //   2. Once tapped, the bell row should disappear from the list
    //      entirely — no "read but still showing" trace, since the
    //      whole point of Secret DMs is leaving no surface for
    //      over-the-shoulder readers.
    //
    // (1) is implemented as: if the secret-lock module isn't already
    // unlocked for this session, route the user to the conversation
    // list with a pending-open hint and let SecretLockGate (which
    // already lives there) handle PIN entry. After unlock, the list
    // auto-navigates to the conversation. If the user IS already
    // unlocked, route straight to the channel.
    //
    // Biometric: not wired in this OTA — the project doesn't have
    // expo-local-authentication installed yet (secret-lock.js notes
    // the integration point). Next rebuild can flip on Face/Touch ID
    // as the primary unlock with PIN fallback; this notification
    // path benefits automatically since secretIsUnlocked() is the
    // single source of truth.
    //
    // (2) is implemented as: optimistic local removal via onDeleted
    // (drops it from the React list) + best-effort row delete on the
    // server via deleteNotification. Failures swallow because the
    // bell list would resync the deletion on next fetch anyway.
    if (isPrivateDm) {
      const conversationId = item?.conversationId || item?.resourceId;
      // Optimistic delete first — the row should disappear before
      // the auth prompt slides in, otherwise privacy is breached the
      // moment the user fails-then-cancels the unlock.
      if (item?.$id) {
        onDeleted?.(item.$id);
        void deleteNotification(item.$id);
      }
      if (!conversationId) return;
      if (secretIsUnlocked()) {
        router.push({ pathname: "/(message)/channel", params: { conversationId } });
      } else {
        // Land on channel-list which already hosts SecretLockGate;
        // pass the conversation ID so it can auto-open after unlock.
        router.push({
          pathname: "/(message)/channel-list",
          params: { openSecretConversationId: conversationId },
        });
      }
      return;
    }

    if (isUnread && item?.$id) {
      onViewed?.(item.$id);
      // Mark-read uses the right backend for the row's origin.
      //   - Chat (dm_message) on Supabase → markChatNotificationsRead
      //     clears every sibling unread for the same conversation in
      //     one round-trip (the RPC keys off conversation_id).
      //   - Grouped non-chat Supabase row → markAsRead with the full
      //     groupedSourceIds list, so all underlying rows that the
      //     adapter collapsed into this bell card flip viewed=true at
      //     the same time. Without this the bell badge would still
      //     count the underlying rows as unread.
      //   - Single non-chat Supabase row → markAsViewed (single id).
      //   - Appwrite legacy → markAsViewed (single id).
      const isChatRow = notificationType === "dm_message";
      const sourceIds = Array.isArray(item?.groupedSourceIds) ? item.groupedSourceIds : null;
      if (item?._backend === "supabase") {
        if (isChatRow) {
          void markChatNotificationsRead(item?.conversationId || item?.resourceId);
        } else if (sourceIds && sourceIds.length > 1) {
          void notificationService.markAsRead({ notificationIds: sourceIds });
        } else {
          void notificationService.markAsViewed({ notificationId: item.$id });
        }
      } else {
        void notificationService.markAsViewed({ notificationId: item.$id });
      }
    }
    // Chat (dm_message) — navigate to the conversation thread.
    if (notificationType === "dm_message") {
      const conversationId = item?.conversationId || item?.resourceId;
      if (conversationId) {
        router.push({ pathname: "/(message)/channel", params: { conversationId } });
      }
      return;
    }
    if (notificationType === "video-upload") {
      router.push("/creator-section");
    } else if (isVideoNotification) {
      const notificationRoute = buildVideoNotificationNavigationParams({
        type: item?.type,
        resourceId: item?.resourceId,
        videoId: resolvedVideoNotificationId,
        docId: resolvedVideoNotificationId,
        focusCommentId,
        focusReplyId,
      });

      if (notificationRoute) {
        router.push(notificationRoute);
      }
    } else if (isPostNotification || shouldOpenPostCommentSection) {
      const notificationRoute = buildPostNotificationNavigationParams({
        type: item?.type,
        resourceId: item?.resourceId,
        postId: focusPostId || item?.resourceId,
        focusCommentId,
        focusReplyId,
      });

      if (notificationRoute) {
        router.push(notificationRoute);
      } else {
        router.push("/home");
      }
    } else if (isBookNotification) {
      const notificationRoute = buildBookNotificationNavigationParams({
        type: item?.type,
        resourceId: item?.resourceId,
        bookId: focusBookId || item?.resourceId,
        focusCommentId,
        focusReplyId,
      });

      if (notificationRoute) {
        router.push(notificationRoute);
      } else {
        router.push("/home");
      }
    } else if (isInlineCommentNotification) {
      const targetChapterId = inlineCommentRoute.chapterId || focusChapterId || null;
      if (!targetChapterId) {
        router.push("/home");
        return;
      }

      router.push({
        pathname: "/book-reading",
        params: {
          chapterId: targetChapterId,
          ...(inlineCommentRoute.anchorKey
            ? {
                inlineCommentAnchorKey: inlineCommentRoute.anchorKey,
                inlineCommentOpen: String(Date.now()),
              }
            : {}),
        },
      });
    } else if (isBookChapterNotification || shouldOpenBookChapterCommentSection) {
      const notificationRoute = buildBookChapterNotificationNavigationParams({
        type: item?.type,
        resourceId: item?.resourceId,
        chapterId: focusChapterId || item?.resourceId,
        focusCommentId,
        focusReplyId,
      });

      if (notificationRoute) {
        router.push(notificationRoute);
      } else {
        router.push("/home");
      }
    } else if (notificationType === "clip") {
      router.push({
        pathname: "clips",
        params: {
          showClip: JSON.stringify(item.resourceData),
          showClipTrigger: Date.now(),
        },
      });
    } else if (notificationType === "follow") {
      // Fallback chain: resourceId (post-OTA adapter writes actor_id here
      // for follow notifications) → sender.$id (actor info hydrated by
      // adaptRow) → resourceData.$id. Pre-OTA cached rows had
      // resourceId=null because the notify_on_follow trigger writes
      // target_type=NULL + target_id=NULL for follows; without this
      // fallback the screen navigates with userId=null and never loads.
      const followProfileId = item?.resourceId || item?.sender?.$id || item?.resourceData?.$id || null;
      if (followProfileId) {
        router.push({
          pathname: "creator-profile",
          params: { userId: followProfileId },
        });
      }
    }
  };

  return (
    <TouchableOpacity
      onPress={handleNotificationPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Notification from ${senderName}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: isUnread ? (theme.isDark ? "rgba(139, 92, 246, 0.10)" : "rgba(139, 92, 246, 0.06)") : "transparent",
      }}
    >
      <View style={{ position: "relative" }}>
        {isPrivateDm ? (
          // Generic lock badge replaces the sender's avatar entirely so
          // privacy is maintained at a glance. White padlock on the
          // brand-purple disc, sized to match UserAvatar's 44px footprint.
          // Secret DMs only — regular DMs render the actual sender avatar.
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 22, color: theme.primaryContrast || "#fff" }}>🔒</Text>
          </View>
        ) : (
          <UserAvatar name={senderName} avatarUri={avatarUri} size={44} borderRadius={22} />
        )}
        {isUnread && (
          <View
            style={{
              position: "absolute",
              right: -2,
              top: -2,
              height: 10,
              width: 10,
              borderRadius: 5,
              borderWidth: 2,
              borderColor: theme.background,
              backgroundColor: theme.primary,
            }}
          />
        )}
      </View>

      <View style={{ flex: 1, marginLeft: 12, marginRight: hasThumbnail ? 8 : 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ fontSize: 14, lineHeight: 19, color: isUnread ? theme.text : theme.textMuted }}>
            <Text style={{ fontWeight: "700", color: theme.text }}>{displayName}</Text>
          </Text>
          {!isPrivateDm && <UserRoleBadgeIcons user={item?.sender} size={12} />}
        </View>
        <Text style={{ fontSize: 14, lineHeight: 19, color: isUnread ? theme.text : theme.textMuted }} numberOfLines={3}>
          <Text> </Text>
          <Text style={{ fontWeight: isUnread ? "500" : "400" }}>{messageText}</Text>
        </Text>
        {createdAtLabel ? <Text style={{ marginTop: 2, fontSize: 11, color: theme.textSubtle }}>{createdAtLabel}</Text> : null}
      </View>

      {hasThumbnail && (
        <View
          style={{
            height: 48,
            width: 48,
            overflow: "hidden",
            borderRadius: 8,
            backgroundColor: theme.surfaceMuted,
          }}
        >
          <FastImage
            source={{ uri: thumbnailUri, priority: FastImage.priority.normal }}
            style={{ height: "100%", width: "100%" }}
            resizeMode={notificationType === "clip" ? FastImage.resizeMode.contain : FastImage.resizeMode.cover}
            accessibilityLabel="Message Thumbnail"
          />
        </View>
      )}
    </TouchableOpacity>
  );
};

export default memo(NotificationCard);
