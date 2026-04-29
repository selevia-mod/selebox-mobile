import { router } from "expo-router";
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
import TimeAgo from "../lib/time-ago";
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

const NotificationCard = ({ item, onViewed }) => {
  const { theme } = useAppTheme();
  const notificationService = new NotificationService();
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
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Notification from ${senderName}`}
      className="mb-3 flex-row items-center rounded-2xl p-3"
      style={{
        borderWidth: 1,
        borderColor: isUnread ? theme.primary : theme.border,
        backgroundColor: isUnread ? theme.primarySoft : theme.card,
      }}
    >
      <View className="relative">
        <UserAvatar
          name={senderName}
          avatarUri={avatarUri}
          size={48}
          borderRadius={12}
          borderColor={isUnread ? theme.primary : theme.border}
        />
        {isUnread && (
          <View
            className="absolute -right-1 -top-1 h-3 w-3 rounded-full border"
            style={{ borderColor: theme.background, backgroundColor: theme.primary }}
          />
        )}
      </View>

      <View className={`ml-3 flex-1 ${hasThumbnail ? "mr-2" : ""}`}>
        <View className="flex-row items-center justify-between">
          <Text className="flex-1 text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
            {senderName}
          </Text>
          {createdAtLabel ? (
            <Text className="ml-2 text-[11px]" style={{ color: theme.textSubtle }}>
              {createdAtLabel}
            </Text>
          ) : null}
        </View>
        <Text className={`mt-1 text-[13px] ${isUnread ? "font-medium" : ""}`} style={{ color: isUnread ? theme.text : theme.textMuted }} numberOfLines={3}>
          {messageText}
        </Text>
      </View>

      {hasThumbnail && (
        <View className="h-[54px] w-[76px] overflow-hidden rounded-xl" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}>
          <FastImage
            source={{ uri: thumbnailUri, priority: FastImage.priority.high }}
            className="h-full w-full"
            resizeMode={notificationType === "clip" ? FastImage.resizeMode.contain : FastImage.resizeMode.cover}
            accessibilityLabel="Message Thumbnail"
          />
        </View>
      )}
    </TouchableOpacity>
  );
};

export default NotificationCard;
