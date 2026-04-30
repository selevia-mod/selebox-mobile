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
import TimeAgo from "../lib/utils/time-ago";
import { stripMentionMarkup } from "../lib/user-mentions";
import UserAvatar from "./UserAvatar";

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

const NotificationCard = ({ item, onViewed }) => {
  const { theme } = useAppTheme();
  const notificationType = typeof item?.type === "string" ? item.type.toLowerCase() : "";
  const focusResourceType = item?.focusResourceType || null;
  let avatarUri = item?.sender?.avatar;
  if (notificationType === "video-upload") {
    avatarUri = item?.recipient?.avatar;
  }
  const thumbnailUri = item?.resourceData?.thumbnail;
  const isUnread = item?.isViewed === false;
  const senderName = item?.sender?.username || "Someone";
  const baseMessage = normalizeText(item?.message);
  const videoTitle = normalizeText(item?.resourceData?.title);
  const postTitle = normalizeText(item?.resourceData?.post || item?.resourceData?.title);
  const bookTitle = normalizeText(item?.resourceData?.title);
  const chapterTitle = normalizeText(item?.resourceData?.title);
  const focusCommentText = normalizeText(item?.focusCommentText);
  const messageText = (() => {
    if (notificationType === "video-reply" || notificationType === "post-reply") {
      return appendSnippet(baseMessage || "replied to your comment", focusCommentText, 80);
    }

    if (notificationType === "book-reply" || notificationType === "book-chapter-reply") {
      return appendSnippet(baseMessage || "replied to your comment", focusCommentText, 80);
    }

    if (notificationType === "video-comment") {
      return appendSnippet(baseMessage || "commented on your video", videoTitle, 90);
    }

    if (notificationType === "post-comment") {
      return appendSnippet(baseMessage || "commented on your post", postTitle, 90);
    }

    if (notificationType === "book-comment") {
      return appendSnippet(baseMessage || "commented on your book", bookTitle, 90);
    }

    if (notificationType === "book-chapter-comment") {
      return appendSnippet(baseMessage || "commented on your chapter", chapterTitle, 90);
    }

    if (notificationType === INLINE_COMMENT_NOTIFICATION_TYPE) {
      return appendSnippet(baseMessage || "commented on a passage", focusCommentText, 90);
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
    if (isUnread && item?.$id) {
      onViewed?.(item.$id);
      void notificationService.markAsViewed({ notificationId: item.$id });
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
      router.push({
        pathname: "creator-profile",
        params: {
          userId: item.resourceId,
        },
      });
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
        <UserAvatar name={senderName} avatarUri={avatarUri} size={44} borderRadius={22} />
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
        <Text style={{ fontSize: 14, lineHeight: 19, color: isUnread ? theme.text : theme.textMuted }} numberOfLines={3}>
          <Text style={{ fontWeight: "700", color: theme.text }}>{senderName}</Text>
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
