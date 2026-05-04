import { get, ref } from "firebase/database";
import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";
import { INLINE_COMMENT_NOTIFICATION_TYPE, parseInlineCommentNotificationResourceId } from "./book-inline-comments";
import { BookService } from "./books";
// getClip removed — clips feature retired May 2026.
import { database } from "./firebase";
import { FollowService } from "./follows";
import { getPost } from "./posts";
import logger from "./utils/logger";
import { VideosService } from "./video";

const VIDEO_NOTIFICATION_TYPES = new Set(["video", "video-comment", "video-reply", "video-upload"]);
const POST_NOTIFICATION_TYPES = new Set(["post", "post-comment", "post-reply"]);
const BOOK_NOTIFICATION_TYPES = new Set(["book", "book-comment", "book-reply"]);
const BOOK_CHAPTER_NOTIFICATION_TYPES = new Set(["book-chapter", "book-chapter-comment", "book-chapter-reply"]);

// Maps a (legacy mobile type, resourceId) pair to the Supabase
// target_type / target_id values the bell-card hydrator expects.
//
// Why this matters: the dedup partial unique index on notifications is
// `(recipient_id, actor_id, type, target_id) WHERE target_id IS NOT NULL`.
// If the app dual-write writes target_id=NULL, the index doesn't apply
// and the row coexists with a trigger-fired row that has target_id set.
// Result: duplicate bell entries, one with hydration data, one without.
//
// resourceId formats (from how mobile builds them today):
//   • Bare hex                                — like, follow, plain post/video/book/chapter event
//   • "video:<hex>:comment:<hex>"             — video comment
//   • "video:<hex>:comment:<hex>:reply:<hex>" — video comment reply
//   • "post:<hex>:comment:<hex>"              — post comment
//   • "post:<hex>:comment:<hex>:reply:<hex>"  — post comment reply
//   • "book:<hex>:comment:<hex>"              — book comment
//   • Inline-book uses parseInlineCommentNotificationResourceId
//
// We always set target_type/target_id to point at the *root* resource
// (post / video / book / chapter / profile). Reply/comment IDs flow
// through `metadata.resourceId` so the hydrator can deep-link.
const _extractRootHex = (resourceId) => {
  if (typeof resourceId !== "string" || !resourceId) return null;
  // "post:<hex>:..." → hex; bare "<hex>" → hex
  const colonMatch = resourceId.match(/^(?:post|video|book|book-chapter|chapter):([^:]+)/);
  if (colonMatch) return colonMatch[1];
  return resourceId;
};

export const deriveNotificationTarget = (type, resourceId) => {
  if (typeof type !== "string") return { targetType: null, targetId: null };
  // Follows + plain profile-mention notifications have no resource.
  if (type === "follow" || type === "profile") return { targetType: null, targetId: null };
  if (VIDEO_NOTIFICATION_TYPES.has(type)) {
    return { targetType: "video", targetId: _extractRootHex(resourceId) };
  }
  if (POST_NOTIFICATION_TYPES.has(type)) {
    return { targetType: "post", targetId: _extractRootHex(resourceId) };
  }
  if (BOOK_NOTIFICATION_TYPES.has(type)) {
    return { targetType: "book", targetId: _extractRootHex(resourceId) };
  }
  if (BOOK_CHAPTER_NOTIFICATION_TYPES.has(type)) {
    return { targetType: "chapter", targetId: _extractRootHex(resourceId) };
  }
  if (type === INLINE_COMMENT_NOTIFICATION_TYPE) {
    const parsed = parseInlineCommentNotificationResourceId(resourceId);
    return { targetType: "chapter", targetId: parsed?.chapterId || null };
  }
  // Unknown type — let it through with null target so submit_notification
  // doesn't reject it. Bell hydrator will fall back to the generic card.
  return { targetType: null, targetId: null };
};

export const parseVideoNotificationResourceId = (resourceId) => {
  if (typeof resourceId !== "string" || !resourceId.startsWith("video:")) {
    return {
      videoId: resourceId,
      commentId: null,
      replyId: null,
      targetType: null,
    };
  }

  const replyMatch = resourceId.match(/^video:([^:]+):comment:([^:]+):reply:([^:]+)$/);
  if (replyMatch) {
    return {
      videoId: replyMatch[1],
      commentId: replyMatch[2],
      replyId: replyMatch[3],
      targetType: "reply",
    };
  }

  const commentMatch = resourceId.match(/^video:([^:]+):comment:([^:]+)$/);
  if (commentMatch) {
    return {
      videoId: commentMatch[1],
      commentId: commentMatch[2],
      replyId: null,
      targetType: "comment",
    };
  }

  return {
    videoId: resourceId,
    commentId: null,
    replyId: null,
    targetType: null,
  };
};

export const parsePostNotificationResourceId = (resourceId) => {
  if (typeof resourceId !== "string" || !resourceId.startsWith("post:")) {
    return {
      postId: resourceId,
      commentId: null,
      replyId: null,
      targetType: null,
    };
  }

  const replyMatch = resourceId.match(/^post:([^:]+):comment:([^:]+):reply:([^:]+)$/);
  if (replyMatch) {
    return {
      postId: replyMatch[1],
      commentId: replyMatch[2],
      replyId: replyMatch[3],
      targetType: "reply",
    };
  }

  const commentMatch = resourceId.match(/^post:([^:]+):comment:([^:]+)$/);
  if (commentMatch) {
    return {
      postId: commentMatch[1],
      commentId: commentMatch[2],
      replyId: null,
      targetType: "comment",
    };
  }

  return {
    postId: resourceId,
    commentId: null,
    replyId: null,
    targetType: null,
  };
};

export const parseBookNotificationResourceId = (resourceId) => {
  if (typeof resourceId !== "string" || !resourceId.startsWith("book:")) {
    return {
      bookId: resourceId,
      commentId: null,
      replyId: null,
      targetType: null,
    };
  }

  const replyMatch = resourceId.match(/^book:([^:]+):comment:([^:]+):reply:([^:]+)$/);
  if (replyMatch) {
    return {
      bookId: replyMatch[1],
      commentId: replyMatch[2],
      replyId: replyMatch[3],
      targetType: "reply",
    };
  }

  const commentMatch = resourceId.match(/^book:([^:]+):comment:([^:]+)$/);
  if (commentMatch) {
    return {
      bookId: commentMatch[1],
      commentId: commentMatch[2],
      replyId: null,
      targetType: "comment",
    };
  }

  return {
    bookId: resourceId,
    commentId: null,
    replyId: null,
    targetType: null,
  };
};

export const parseBookChapterNotificationResourceId = (resourceId) => {
  if (typeof resourceId !== "string" || !resourceId.startsWith("book-chapter:")) {
    return {
      chapterId: resourceId,
      commentId: null,
      replyId: null,
      targetType: null,
    };
  }

  const replyMatch = resourceId.match(/^book-chapter:([^:]+):comment:([^:]+):reply:([^:]+)$/);
  if (replyMatch) {
    return {
      chapterId: replyMatch[1],
      commentId: replyMatch[2],
      replyId: replyMatch[3],
      targetType: "reply",
    };
  }

  const commentMatch = resourceId.match(/^book-chapter:([^:]+):comment:([^:]+)$/);
  if (commentMatch) {
    return {
      chapterId: commentMatch[1],
      commentId: commentMatch[2],
      replyId: null,
      targetType: "comment",
    };
  }

  return {
    chapterId: resourceId,
    commentId: null,
    replyId: null,
    targetType: null,
  };
};

export const buildVideoNotificationNavigationParams = ({ type, resourceId, videoId, docId, focusCommentId, focusReplyId } = {}) => {
  const resolvedType = typeof type === "string" ? type.toLowerCase() : "";
  const parsed = parseVideoNotificationResourceId(resourceId);
  const resolvedVideoId = parsed.videoId || videoId || docId || resourceId;
  const resolvedFocusCommentId = focusCommentId || parsed.commentId || null;
  const resolvedFocusReplyId = focusReplyId || parsed.replyId || null;
  const shouldHandleAsVideo =
    VIDEO_NOTIFICATION_TYPES.has(resolvedType) || (typeof resourceId === "string" && resourceId.startsWith("video:")) || Boolean(videoId || docId);
  const shouldOpenComments = Boolean(
    resolvedType === "video-comment" ||
      resolvedType === "video-reply" ||
      resolvedFocusCommentId ||
      resolvedFocusReplyId ||
      parsed.targetType === "comment" ||
      parsed.targetType === "reply",
  );

  if (!shouldHandleAsVideo || !resolvedVideoId) return null;

  return {
    pathname: "video-player",
    params: {
      id: resolvedVideoId,
      docId: resolvedVideoId,
      view: shouldOpenComments ? "COMMENTS" : "RECOMMENDED",
      ...(resolvedFocusCommentId ? { focusCommentId: resolvedFocusCommentId } : {}),
      ...(resolvedFocusReplyId ? { focusReplyId: resolvedFocusReplyId } : {}),
    },
  };
};

export const buildVideoNotificationResourceId = ({ videoId, commentId, replyId } = {}) => {
  if (!videoId) return videoId;
  if (commentId && replyId) return `video:${videoId}:comment:${commentId}:reply:${replyId}`;
  if (commentId) return `video:${videoId}:comment:${commentId}`;
  return videoId;
};

export const buildPostNotificationNavigationParams = ({ type, resourceId, postId, focusCommentId, focusReplyId } = {}) => {
  const resolvedType = typeof type === "string" ? type.toLowerCase() : "";
  const parsed = parsePostNotificationResourceId(resourceId);
  const resolvedPostId = parsed.postId || postId || resourceId;
  const resolvedFocusCommentId = focusCommentId || parsed.commentId || null;
  const resolvedFocusReplyId = focusReplyId || parsed.replyId || null;
  const shouldHandleAsPost =
    POST_NOTIFICATION_TYPES.has(resolvedType) || (typeof resourceId === "string" && resourceId.startsWith("post:")) || Boolean(postId);
  const shouldOpenComments = Boolean(
    resolvedType === "post-comment" ||
      resolvedType === "post-reply" ||
      resolvedFocusCommentId ||
      resolvedFocusReplyId ||
      parsed.targetType === "comment" ||
      parsed.targetType === "reply",
  );

  if (!shouldHandleAsPost || !resolvedPostId) return null;

  return {
    pathname: "/post-item",
    params: {
      postId: resolvedPostId,
      focusPostId: resolvedPostId,
      ...(shouldOpenComments ? { openComments: "1" } : {}),
      ...(resolvedFocusCommentId ? { focusCommentId: resolvedFocusCommentId } : {}),
      ...(resolvedFocusReplyId ? { focusReplyId: resolvedFocusReplyId } : {}),
    },
  };
};

export const buildPostNotificationResourceId = ({ postId, commentId, replyId } = {}) => {
  if (!postId) return postId;
  if (commentId && replyId) return `post:${postId}:comment:${commentId}:reply:${replyId}`;
  if (commentId) return `post:${postId}:comment:${commentId}`;
  return postId;
};

export const buildBookNotificationNavigationParams = ({ type, resourceId, bookId, focusCommentId, focusReplyId } = {}) => {
  const resolvedType = typeof type === "string" ? type.toLowerCase() : "";
  const parsed = parseBookNotificationResourceId(resourceId);
  const resolvedBookId = parsed.bookId || bookId || resourceId;
  const resolvedFocusCommentId = focusCommentId || parsed.commentId || null;
  const resolvedFocusReplyId = focusReplyId || parsed.replyId || null;
  const shouldHandleAsBook =
    BOOK_NOTIFICATION_TYPES.has(resolvedType) || (typeof resourceId === "string" && resourceId.startsWith("book:")) || Boolean(bookId);
  const shouldOpenComments = Boolean(
    resolvedType === "book-comment" ||
      resolvedType === "book-reply" ||
      resolvedFocusCommentId ||
      resolvedFocusReplyId ||
      parsed.targetType === "comment" ||
      parsed.targetType === "reply",
  );

  if (!shouldHandleAsBook || !resolvedBookId) return null;

  return {
    pathname: "book-info",
    params: {
      bookId: resolvedBookId,
      ...(shouldOpenComments ? { openComments: "1" } : {}),
      ...(resolvedFocusCommentId ? { focusCommentId: resolvedFocusCommentId } : {}),
      ...(resolvedFocusReplyId ? { focusReplyId: resolvedFocusReplyId } : {}),
    },
  };
};

export const buildBookNotificationResourceId = ({ bookId, commentId, replyId } = {}) => {
  if (!bookId) return bookId;
  if (commentId && replyId) return `book:${bookId}:comment:${commentId}:reply:${replyId}`;
  if (commentId) return `book:${bookId}:comment:${commentId}`;
  return bookId;
};

export const buildBookChapterNotificationNavigationParams = ({ type, resourceId, chapterId, focusCommentId, focusReplyId } = {}) => {
  const resolvedType = typeof type === "string" ? type.toLowerCase() : "";
  const parsed = parseBookChapterNotificationResourceId(resourceId);
  const resolvedChapterId = parsed.chapterId || chapterId || resourceId;
  const resolvedFocusCommentId = focusCommentId || parsed.commentId || null;
  const resolvedFocusReplyId = focusReplyId || parsed.replyId || null;
  const shouldHandleAsBookChapter =
    BOOK_CHAPTER_NOTIFICATION_TYPES.has(resolvedType) ||
    (typeof resourceId === "string" && resourceId.startsWith("book-chapter:")) ||
    Boolean(chapterId);
  const shouldOpenComments = Boolean(
    resolvedType === "book-chapter-comment" ||
      resolvedType === "book-chapter-reply" ||
      resolvedFocusCommentId ||
      resolvedFocusReplyId ||
      parsed.targetType === "comment" ||
      parsed.targetType === "reply",
  );

  if (!shouldHandleAsBookChapter || !resolvedChapterId) return null;

  return {
    pathname: "/book-reading",
    params: {
      chapterId: resolvedChapterId,
      ...(shouldOpenComments ? { openComments: "1" } : {}),
      ...(resolvedFocusCommentId ? { focusCommentId: resolvedFocusCommentId } : {}),
      ...(resolvedFocusReplyId ? { focusReplyId: resolvedFocusReplyId } : {}),
    },
  };
};

export const buildBookChapterNotificationResourceId = ({ chapterId, commentId, replyId } = {}) => {
  if (!chapterId) return chapterId;
  if (commentId && replyId) return `book-chapter:${chapterId}:comment:${commentId}:reply:${replyId}`;
  if (commentId) return `book-chapter:${chapterId}:comment:${commentId}`;
  return chapterId;
};

const buildNotificationPushData = ({ type, resourceId, senderId }) => {
  const videoFocusMeta = parseVideoNotificationResourceId(resourceId);
  const postFocusMeta = parsePostNotificationResourceId(resourceId);
  const bookFocusMeta = parseBookNotificationResourceId(resourceId);
  const bookChapterFocusMeta = parseBookChapterNotificationResourceId(resourceId);

  return {
    type,
    resourceId,
    senderId,
    ...(videoFocusMeta.commentId || videoFocusMeta.replyId
      ? {
          notificationVideoFocus: {
            targetType: videoFocusMeta.targetType,
            commentId: videoFocusMeta.commentId,
            replyId: videoFocusMeta.replyId,
          },
        }
      : {}),
    ...(postFocusMeta.commentId || postFocusMeta.replyId
      ? {
          notificationPostFocus: {
            targetType: postFocusMeta.targetType,
            postId: postFocusMeta.postId,
            commentId: postFocusMeta.commentId,
            replyId: postFocusMeta.replyId,
          },
        }
      : {}),
    ...(bookFocusMeta.commentId || bookFocusMeta.replyId
      ? {
          notificationBookFocus: {
            targetType: bookFocusMeta.targetType,
            bookId: bookFocusMeta.bookId,
            commentId: bookFocusMeta.commentId,
            replyId: bookFocusMeta.replyId,
          },
        }
      : {}),
    ...(bookChapterFocusMeta.commentId || bookChapterFocusMeta.replyId
      ? {
          notificationBookChapterFocus: {
            targetType: bookChapterFocusMeta.targetType,
            chapterId: bookChapterFocusMeta.chapterId,
            commentId: bookChapterFocusMeta.commentId,
            replyId: bookChapterFocusMeta.replyId,
          },
        }
      : {}),
  };
};

export class NotificationService {
  async getFollowers({ userId }) {
    const followers = await FollowService.getFollowers({ userId });
    return followers;
  }

  async notifyFollowers({ sender, type, resourceId, message }) {
    try {
      const senderId = sender?.$id;
      if (!senderId) return;
      const followers = await this.getFollowers({ userId: senderId });
      const displayName = sender?.username || "Someone";
      const pushData = buildNotificationPushData({ type, resourceId, senderId });

      // Lazy-import the Supabase RPC once for the whole batch — every
      // follower below dual-writes through it. Same pattern as notifyUser
      // above. A failure to import (older bundle without the file) just
      // skips the Supabase half — the Appwrite write still goes through.
      let submitNotificationRpc = null;
      try {
        const mod = await import("./notifications-supabase");
        submitNotificationRpc = mod.submitNotificationRpc;
      } catch (_) {
        /* skip Supabase dual-write */
      }

      const tasks = followers.map(async (follower) => {
        const created = await databases.createDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, ID.unique(), {
          recipient: follower.followerId?.$id,
          sender: sender.$id,
          type,
          resourceId,
          message,
          isRead: false,
          isViewed: false,
        });

        // Dual-write into Supabase. Best-effort — never blocks the
        // Appwrite write or the push send below. Same target derivation
        // as notifyUser so dedup partial-index works.
        if (submitNotificationRpc) {
          try {
            const { targetType, targetId } = deriveNotificationTarget(type, resourceId);
            await submitNotificationRpc({
              recipientId: follower.followerId?.$id,
              actorId: sender.$id,
              type: typeof type === "string" ? type.replace(/-/g, "_") : type,
              targetType,
              targetId,
              message,
              preview: message,
              metadata: {
                resourceId,
                senderUsername: sender?.username,
                originalType: type,
                appwriteNotifId: created?.$id,
              },
            });
          } catch (sbErr) {
            console.log("[notifyFollowers] Supabase dual-write skipped:", sbErr?.message);
          }
        }

        const recipient = follower.followerId;
        const expoPushToken = recipient?.expoPushToken;

        if (expoPushToken) {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip, deflate",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: expoPushToken,
              sound: "default",
              title: displayName,
              body: message.trim(),
              data: pushData,
              android: {
                channelId: "default",
                priority: "max",
              },
              ios: {
                _displayInForeground: true,
              },
            }),
          });
        }
      });

      await Promise.all(tasks);
    } catch (error) {
      console.error("notifyFollowers: error", error);
    }
  }

  // 🧾 Fetch notifications for a user
  async fetchNotifications({ userId, lastId, limit = 20 }) {
    try {
      const bookService = new BookService();
      const videosService = new VideosService();
      const fetchCommentText = async ({ resourceType, commentId }) => {
        if (!resourceType || !commentId) return null;

        const collectionId =
          resourceType === "video"
            ? secrets.appwriteConfig.videosCommentsCollectionId
            : resourceType === "book"
              ? secrets.appwriteConfig.booksCommentsCollectionId
              : resourceType === "book-chapter"
                ? secrets.appwriteConfig.booksChaptersCommentsCollectionId
                : secrets.appwriteConfig.postsCommentCollectionId;

        try {
          const commentDocument = await databases.getDocument(secrets.appwriteConfig.databaseId, collectionId, commentId);
          return typeof commentDocument?.comment === "string" ? commentDocument.comment : null;
        } catch (_error) {
          return null;
        }
      };
      const fetchInlineCommentText = async ({ commentId, replyId }) => {
        const targetId = String(replyId || commentId || "").trim();
        const collectionId = replyId
          ? secrets.appwriteConfig.booksChapterInlineCommentRepliesCollectionId
          : secrets.appwriteConfig.booksChapterInlineCommentsCollectionId;

        if (!targetId || !collectionId) return null;

        try {
          const commentDocument = await databases.getDocument(secrets.appwriteConfig.databaseId, collectionId, targetId);
          return typeof commentDocument?.comment === "string" ? commentDocument.comment : null;
        } catch (_error) {
          return null;
        }
      };
      const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
      if (lastId) queries.push(Query.cursorAfter(lastId));
      if (userId) queries.push(Query.equal("recipient", userId));
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, queries);

      // 🔄 Map resource data based on type
      const mapped = await Promise.all(
        res.documents.map(async (notif) => {
          let resourceData = null;
          const resolvedType = typeof notif?.type === "string" ? notif.type.toLowerCase() : "";
          const isVideoNotification = VIDEO_NOTIFICATION_TYPES.has(resolvedType);
          const isPostNotification = POST_NOTIFICATION_TYPES.has(resolvedType);
          const isBookNotification = BOOK_NOTIFICATION_TYPES.has(resolvedType);
          const isBookChapterNotification = BOOK_CHAPTER_NOTIFICATION_TYPES.has(resolvedType);
          const isInlineCommentNotification = resolvedType === INLINE_COMMENT_NOTIFICATION_TYPE;
          const parsedVideoResource = isVideoNotification ? parseVideoNotificationResourceId(notif.resourceId) : null;
          const parsedPostResource = isPostNotification ? parsePostNotificationResourceId(notif.resourceId) : null;
          const parsedBookResource = isBookNotification ? parseBookNotificationResourceId(notif.resourceId) : null;
          const parsedBookChapterResource = isBookChapterNotification ? parseBookChapterNotificationResourceId(notif.resourceId) : null;
          const parsedInlineCommentResource = isInlineCommentNotification ? parseInlineCommentNotificationResourceId(notif.resourceId) : null;
          const focusCommentId =
            parsedVideoResource?.commentId ||
            parsedPostResource?.commentId ||
            parsedBookResource?.commentId ||
            parsedBookChapterResource?.commentId ||
            parsedInlineCommentResource?.commentId ||
            null;
          const focusReplyId =
            parsedVideoResource?.replyId ||
            parsedPostResource?.replyId ||
            parsedBookResource?.replyId ||
            parsedBookChapterResource?.replyId ||
            parsedInlineCommentResource?.replyId ||
            null;
          const focusResourceType = isVideoNotification
            ? "video"
            : isPostNotification
              ? "post"
              : isBookNotification
                ? "book"
                : isBookChapterNotification
                  ? "book-chapter"
                  : isInlineCommentNotification
                    ? "book-inline-comment"
                    : null;
          const focusCommentText = isInlineCommentNotification
            ? await fetchInlineCommentText({
                commentId: parsedInlineCommentResource?.commentId,
                replyId: parsedInlineCommentResource?.replyId,
              })
            : resolvedType === "video-reply" ||
                resolvedType === "post-reply" ||
                resolvedType === "book-reply" ||
                resolvedType === "book-chapter-reply"
              ? await fetchCommentText({
                  resourceType: focusResourceType,
                  commentId: focusCommentId,
                })
              : null;

          try {
            switch (resolvedType) {
              case "video":
              case "video-comment":
              case "video-reply":
              case "video-upload":
                resourceData = await videosService.getVideo({
                  id: parsedVideoResource?.videoId || notif.resourceId,
                });
                break;
              // "clip" notification type retired May 2026. Existing
              // clip notifications still in the inbox will fall through
              // to the default branch, leaving resourceData null — the
              // bell renders the generic fallback card.
              case "clip":
                break;
              case "post":
              case "post-comment":
              case "post-reply":
                resourceData = await getPost({ ID: parsedPostResource?.postId || notif.resourceId });
                break;
              case "book":
              case "book-comment":
              case "book-reply":
                resourceData = await bookService.fetchBook({ bookId: parsedBookResource?.bookId || notif.resourceId });
                break;
              case "book-chapter":
              case "book-chapter-comment":
              case "book-chapter-reply":
                resourceData = await bookService.fetchBookChapter({ chapterId: parsedBookChapterResource?.chapterId || notif.resourceId });
                break;
              case INLINE_COMMENT_NOTIFICATION_TYPE:
                resourceData = await bookService.fetchBookChapter({ chapterId: parsedInlineCommentResource?.chapterId || notif.resourceId });
                break;
              default:
                resourceData = null;
            }
          } catch (err) {
            // Don't promote to recordError — orphaned resources are expected
            // when content is deleted faster than notifications are pruned.
            // The card renders with `resourceData: null` and the UI handles it.
            logger.warn("NotificationService", `resource fetch failed for ${resolvedType}/${notif.resourceId}`, err);
          }

          return {
            ...notif,
            resourceData,
            focusCommentId,
            focusReplyId,
            focusCommentText,
            focusTargetType:
              parsedVideoResource?.targetType ||
              parsedPostResource?.targetType ||
              parsedBookResource?.targetType ||
              parsedBookChapterResource?.targetType ||
              (resolvedType === "video-reply" || resolvedType === "post-reply"
                ? "reply"
                : resolvedType === "video-comment" || resolvedType === "post-comment"
                  ? "comment"
                  : resolvedType === "book-reply"
                    ? "reply"
                    : resolvedType === "book-comment"
                      ? "comment"
                      : resolvedType === "book-chapter-reply"
                        ? "reply"
                        : resolvedType === "book-chapter-comment"
                          ? "comment"
                          : parsedInlineCommentResource?.replyId
                            ? "reply"
                            : parsedInlineCommentResource?.commentId
                              ? "comment"
                              : null),
            focusVideoId: parsedVideoResource?.videoId || null,
            focusPostId: parsedPostResource?.postId || null,
            focusBookId: parsedBookResource?.bookId || null,
            focusChapterId: parsedBookChapterResource?.chapterId || parsedInlineCommentResource?.chapterId || null,
            focusResourceType,
          };
        }),
      );

      return { documents: mapped, total: res.total };
    } catch (error) {
      logger.error("NotificationService", "fetchNotifications failed", error);
      // Match success shape so the notifications screen's `.documents.map(...)`
      // doesn't throw on the error path.
      return { documents: [], total: 0 };
    }
  }

  // 🔴 Unread badge count
  async getUnreadCount({ userId }) {
    // Bail before hitting Appwrite — `Query.equal("recipient", undefined)` throws
    // "Invalid query: Equal queries require at least one value." This guards against
    // the call landing during sign-out, pre-bootstrap hydration, or mid-session
    // expiry when user.$id can be null/undefined.
    if (!userId) return 0;

    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, [
        Query.equal("recipient", userId),
        Query.equal("isRead", false),
      ]);

      return res.total;
    } catch (err) {
      console.error("getUnreadCount error:", err);
      return 0;
    }
  }

  // ✅ Mark all as read
  async markAllAsRead({ userId }) {
    if (!userId) return false; // same guard pattern as markAllAsViewed below
    try {
      const { documents } = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, [
        Query.equal("recipient", userId),
        Query.equal("isRead", false),
      ]);

      await Promise.all(
        documents.map((notif) =>
          databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, notif.$id, { isRead: true }),
        ),
      );

      return true;
    } catch (err) {
      console.error("markAllAsRead error:", err);
      return false;
    }
  }

  // Mark as read passed NotificationIds
  async markAsRead({ notificationIds }) {
    try {
      if (!notificationIds || notificationIds.length === 0) return true;

      await Promise.all(
        notificationIds.map((id) =>
          databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, id, { isRead: true }),
        ),
      );

      return true;
    } catch (err) {
      console.error("markAsRead error:", err);
      return false;
    }
  }

  // ✅ Mark as viewed
  async markAsViewed({ notificationId }) {
    try {
      await databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, notificationId, {
        isViewed: true,
      });
      return true;
    } catch (err) {
      console.error("markAsViewed error:", err);
      return false;
    }
  }

  // ✅ Mark all as viewed
  async markAllAsViewed({ userId }) {
    try {
      if (!userId) return false;

      const limit = 100;
      let cursorAfter = null;

      while (true) {
        const queries = [Query.equal("recipient", userId), Query.equal("isViewed", false), Query.orderAsc("$id"), Query.limit(limit)];

        if (cursorAfter) {
          queries.push(Query.cursorAfter(cursorAfter));
        }

        const { documents } = await databases.listDocuments(
          secrets.appwriteConfig.databaseId,
          secrets.appwriteConfig.notificationCollectionId,
          queries,
        );

        if (!documents?.length) break;

        await Promise.all(
          documents.map((notif) =>
            databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, notif.$id, {
              isViewed: true,
            }),
          ),
        );

        if (documents.length < limit) break;

        cursorAfter = documents[documents.length - 1].$id;
      }

      return true;
    } catch (err) {
      console.error("markAllAsViewed error:", err);
      return false;
    }
  }

  // 🔄 Fetch from firebase
  async fetchFromFirebase(path) {
    try {
      const snapshot = await get(ref(database, path));
      return snapshot.exists() ? snapshot.val() : null;
    } catch (error) {
      console.log("fetchFromFirebase: error", error);
    }
  }

  // Check if a follow notification already exists today
  async checkFollowNotificationExists({ senderId, recipientId }) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.notificationCollectionId, [
        Query.equal("sender", senderId),
        Query.equal("recipient", recipientId),
        Query.equal("type", "follow"),
        Query.orderDesc("$createdAt"),
        Query.limit(1),
      ]);

      if (res.total === 0) return false;

      const lastNotif = res.documents[0];
      const notifDate = new Date(lastNotif.$createdAt);
      notifDate.setHours(0, 0, 0, 0);

      //  If the notification date is the same as today, skip sending again
      return notifDate.getTime() === today.getTime();
    } catch (err) {
      console.error("checkFollowNotificationExists error:", err);
      return false;
    }
  }

  // Notify a single user
  async notifyUser({
    sender,
    recipient, // full user object
    type,
    resourceId,
    message,
    skipDuplicateCheck = false,
  }) {
    try {
      if (!recipient || !recipient.$id) throw new Error("Recipient not provided");

      const senderId = sender?.$id;
      const recipientId = recipient?.$id;
      const displayName = sender?.username || "Someone";
      const pushData = buildNotificationPushData({ type, resourceId, senderId });

      // Optional duplicate prevention for follow type
      if (!skipDuplicateCheck && type === "follow") {
        const already = await this.checkFollowNotificationExists({ senderId, recipientId });
        if (already) return null; // skip notifying again today
      }

      // create notification record
      const created = await databases.createDocument(
        secrets.appwriteConfig.databaseId,
        secrets.appwriteConfig.notificationCollectionId,
        ID.unique(),
        {
          recipient: recipientId,
          sender: senderId,
          type,
          resourceId,
          message,
          isRead: false,
          isViewed: false,
        },
      );

      // ─── Dual-write to Supabase ────────────────────────────────────
      // Mobile is the only writer of non-DM notifications today; web
      // can't see them because mobile writes only Appwrite. Mirror the
      // dual-write pattern from reportContent / blockUser / hideContent.
      //
      // Best-effort: a failure here doesn't propagate. The Appwrite row
      // is the legacy source of truth; the Supabase row is bonus
      // cross-platform delivery. submit_notification RPC handles dedup
      // (per-row + 30-day follow dedup) so re-runs don't double-write.
      //
      // Type translation: mobile uses "post-comment" hyphenated;
      // Supabase types use underscores ("post_comment"). The RPC's
      // `type` column is plain text (no enum), so any string works,
      // but the web bell card renderer recognizes the underscored
      // forms — translating dashes to underscores keeps web rendering
      // proper cards instead of falling back to a generic one.
      //
      // resourceId carries the original Appwrite id format
      // ("post:<hex>:comment:<hex>"), which is preserved in metadata
      // for the bell renderer to use for routing / deep-linking.
      try {
        const { submitNotificationRpc } = await import("./notifications-supabase");
        // Derive target_type / target_id from the legacy type + resourceId.
        // Without these, the Supabase bell-card hydration skips the row
        // entirely (no thumbnail / title), and the dedup partial index on
        // (recipient, actor, type, target_id) WHERE target_id IS NOT NULL
        // doesn't catch this row — letting the trigger-fired row + app-
        // fired row coexist as duplicates.
        const { targetType, targetId } = deriveNotificationTarget(type, resourceId);
        await submitNotificationRpc({
          recipientId,
          actorId: senderId,
          type: typeof type === "string" ? type.replace(/-/g, "_") : type,
          targetType,
          targetId,
          message,
          preview: message,
          metadata: {
            resourceId,
            senderUsername: sender?.username,
            originalType: type,
            // Preserve the Appwrite document id so a future reconciler
            // can correlate the two writes if we ever need to.
            appwriteNotifId: created?.$id,
          },
        });
      } catch (sbErr) {
        // Never block the Appwrite write. Log only.
        console.log("[notifyUser] Supabase dual-write skipped:", sbErr?.message);
      }

      // send Expo push if token exists
      if (recipient?.expoPushToken) {
        await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: recipient.expoPushToken,
            sound: "default",
            title: displayName,
            body: message.trim(),
            data: pushData,
            android: {
              channelId: "default",
              priority: "max",
            },
            ios: {
              _displayInForeground: true,
            },
          }),
        });
      }

      return created;
    } catch (err) {
      console.error("notifyUser error:", err);
      return null;
    }
  }
}
