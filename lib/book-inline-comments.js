import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";
import { fnv1aHash, getInlineCommentThreadDocumentId, shortenInlineCommentText } from "./book-inline-comment-anchors";
import { stripMentionMarkup } from "./user-mentions";

const THREADS_PAGE_LIMIT = 100;
const COMMENTS_PAGE_LIMIT = 20;
const RELATED_RECORDS_PAGE_LIMIT = 100;
export const INLINE_COMMENT_NOTIFICATION_TYPE = "book-inline-comment";
export const INLINE_COMMENT_FEATURE_FLAGS = Object.freeze({
  likesEnabled: false,
  repliesEnabled: false,
});

const emptyDocumentList = { total: 0, documents: [] };

const missingConfig = (key) => {
  console.warn(`[book-inline-comments] Missing Appwrite config for ${key}. Create the inline comment collections before using this feature.`);
  return null;
};

const isNotFoundError = (error) => Number(error?.code) === 404 || /not found/i.test(error?.message || "");
const isConflictError = (error) => Number(error?.code) === 409 || /already exists|conflict/i.test(error?.message || "");
const shouldRetryDeleteAfterCleanup = (error) => {
  const message = String(error?.message || "");
  return /relation|reference|constraint|linked|dependent|still referenced/i.test(message);
};

const ensureConfigured = () => {
  if (!appwriteConfig.booksChapterInlineCommentThreadsCollectionId) {
    return missingConfig("booksChapterInlineCommentThreadsCollectionId");
  }

  if (!appwriteConfig.booksChapterInlineCommentsCollectionId) {
    return missingConfig("booksChapterInlineCommentsCollectionId");
  }

  return true;
};

const getThreadCollectionId = () => appwriteConfig.booksChapterInlineCommentThreadsCollectionId;
const getCommentCollectionId = () => appwriteConfig.booksChapterInlineCommentsCollectionId;
const getCommentLikesCollectionId = () => appwriteConfig.booksChapterInlineCommentLikesCollectionId;
const getCommentRepliesCollectionId = () => appwriteConfig.booksChapterInlineCommentRepliesCollectionId;
const getUsersCollectionId = () => appwriteConfig.userCollectionId;
const getInlineCommentFeatureFlags = (overrides = {}) => ({
  ...INLINE_COMMENT_FEATURE_FLAGS,
  likesEnabled: Boolean(getCommentLikesCollectionId()),
  repliesEnabled: Boolean(getCommentRepliesCollectionId()),
  ...(overrides || {}),
});

const buildThreadSeed = ({ bookChapterId, anchor, includeLastCommentAt = true }) => {
  const seed = {
    booksChapter: bookChapterId,
    anchorKey: anchor.anchorKey,
    anchorHash: fnv1aHash(anchor.anchorKey),
    anchorVersion: anchor.anchorVersion || "v1",
    anchorTag: anchor.tagName || "p",
    anchorOrdinal: Number(anchor.ordinal) || 0,
    anchorPath: anchor.path || "",
    anchorText: shortenInlineCommentText(anchor.preview || anchor.text || "", 280),
    normalizedTextHash: anchor.textHash || "",
    commentsCount: 0,
    latestCommentPreview: "",
  };

  if (includeLastCommentAt) {
    seed.lastCommentAt = new Date().toISOString();
  }

  return seed;
};

const shouldRetryWithoutLastCommentAt = (error) => {
  const message = error?.message || "";
  return /lastcommentat|unknown attribute|invalid document structure/i.test(message);
};

const findThreadByAnchorQuery = async ({ bookChapterId, anchorKey }) => {
  const response = await databases.listDocuments(appwriteConfig.databaseId, getThreadCollectionId(), [
    Query.equal("booksChapter", bookChapterId),
    Query.equal("anchorKey", anchorKey),
    Query.limit(1),
  ]);

  return response.documents?.[0] || null;
};

const getCommentOwnerId = (comment) => {
  const owner = comment?.commentOwner;
  if (!owner) return "";
  if (typeof owner === "string") return owner;
  return owner?.$id || "";
};
const getInlineThreadId = (comment) => {
  const thread = comment?.thread;
  if (!thread) return "";
  if (typeof thread === "string") return thread;
  return thread?.$id || "";
};
const getLikeOwnerId = (like) => {
  const owner = like?.likeOwner;
  if (!owner) return "";
  if (typeof owner === "string") return owner;
  return owner?.$id || "";
};
const getReplyOwnerId = (reply) => {
  const owner = reply?.commentOwner;
  if (!owner) return "";
  if (typeof owner === "string") return owner;
  return owner?.$id || "";
};
const getParentInlineCommentId = (document) => {
  const parent = document?.bookChapterInlineComment;
  if (!parent) return "";
  if (typeof parent === "string") return parent;
  return parent?.$id || "";
};

const hasExpandedCommentOwner = (owner) => Boolean(owner && typeof owner === "object" && owner.$id && owner.username);
const hasExpandedLikeOwner = (owner) => Boolean(owner && typeof owner === "object" && owner.$id && owner.username);
const getInlineCommentLikes = (comment) =>
  Array.isArray(comment?.booksChapterInlineCommentLikes)
    ? comment.booksChapterInlineCommentLikes
    : comment?.booksChapterInlineCommentLikes?.documents || [];
const getInlineCommentReplies = (comment) =>
  Array.isArray(comment?.booksChapterInlineCommentReplies)
    ? comment.booksChapterInlineCommentReplies
    : comment?.booksChapterInlineCommentReplies?.documents || [];

const fetchUsersMapByIds = async (userIds = []) => {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  try {
    const response = await databases.listDocuments(appwriteConfig.databaseId, getUsersCollectionId(), [
      Query.equal("$id", uniqueIds),
      Query.limit(uniqueIds.length),
    ]);

    return response.documents.reduce((accumulator, userDocument) => {
      accumulator[userDocument.$id] = userDocument;
      return accumulator;
    }, {});
  } catch (error) {
    console.warn("fetchUsersMapByIds error:", error?.message || error);
    return {};
  }
};

const listAllDocumentsByField = async ({ collectionId, field, values = [], orderField = "$createdAt" }) => {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (!collectionId || !field || uniqueValues.length === 0) return [];

  const documents = [];
  let lastId = null;
  let shouldContinue = true;

  while (shouldContinue) {
    const queries = [Query.equal(field, uniqueValues), Query.orderAsc(orderField), Query.limit(RELATED_RECORDS_PAGE_LIMIT)];
    if (lastId) queries.push(Query.cursorAfter(lastId));

    const response = await databases.listDocuments(appwriteConfig.databaseId, collectionId, queries);
    const pageDocuments = response.documents || [];
    documents.push(...pageDocuments);

    lastId = pageDocuments.at(-1)?.$id || null;
    shouldContinue = pageDocuments.length === RELATED_RECORDS_PAGE_LIMIT;
  }

  return documents;
};

const deleteDocumentsByFieldValue = async ({ collectionId, field, value }) => {
  if (!collectionId || !field || !value) return [];

  const documents = await listAllDocumentsByField({
    collectionId,
    field,
    values: [value],
  }).catch((error) => {
    console.warn("deleteDocumentsByFieldValue list error:", error?.message || error);
    return [];
  });

  await Promise.allSettled(
    documents
      .filter((document) => document?.$id)
      .map((document) => databases.deleteDocument(appwriteConfig.databaseId, collectionId, String(document.$id))),
  );

  return documents;
};

const groupDocumentsByParentCommentId = (documents = []) =>
  documents.reduce((accumulator, document) => {
    const parentCommentId = getParentInlineCommentId(document);
    if (!parentCommentId) return accumulator;

    if (!accumulator[parentCommentId]) accumulator[parentCommentId] = [];
    accumulator[parentCommentId].push(document);
    return accumulator;
  }, {});

const normalizeInlineLike = (like, usersById = {}, fallbackUsersById = {}) => {
  const ownerId = getLikeOwnerId(like);
  const normalizedOwner = hasExpandedLikeOwner(like?.likeOwner)
    ? like.likeOwner
    : usersById[ownerId] || fallbackUsersById[ownerId] || (ownerId ? { $id: ownerId } : null);

  return {
    ...like,
    likeOwner: normalizedOwner,
  };
};

const normalizeInlineReply = (reply, usersById = {}, fallbackUsersById = {}) => {
  const ownerId = getReplyOwnerId(reply);
  const normalizedOwner = hasExpandedCommentOwner(reply?.commentOwner)
    ? reply.commentOwner
    : usersById[ownerId] || fallbackUsersById[ownerId] || (ownerId ? { $id: ownerId } : null);

  return {
    ...reply,
    commentOwner: normalizedOwner,
  };
};

const normalizeInlineComment = (comment, usersById = {}, fallbackUsersById = {}) => {
  const ownerId = getCommentOwnerId(comment);
  const likes = getInlineCommentLikes(comment).map((like) => normalizeInlineLike(like, usersById, fallbackUsersById));
  const replies = getInlineCommentReplies(comment).map((reply) => normalizeInlineReply(reply, usersById, fallbackUsersById));
  const normalizedOwner = hasExpandedCommentOwner(comment?.commentOwner)
    ? comment.commentOwner
    : usersById[ownerId] || fallbackUsersById[ownerId] || (ownerId ? { $id: ownerId } : null);

  return {
    ...comment,
    commentOwner: normalizedOwner,
    booksChapterInlineCommentLikes: likes,
    booksChapterInlineCommentReplies: replies,
    likeCount: Number.isFinite(comment?.likeCount) ? comment.likeCount : likes.length,
    replyCount: Number.isFinite(comment?.replyCount) ? comment.replyCount : replies.length,
    __features: getInlineCommentFeatureFlags(comment?.__features),
  };
};

const normalizeInlineComments = async (comments = [], fallbackUsersById = {}) => {
  const ownerIds = comments
    .filter((comment) => !hasExpandedCommentOwner(comment?.commentOwner))
    .map((comment) => getCommentOwnerId(comment))
    .filter(Boolean);
  const usersById = await fetchUsersMapByIds(ownerIds);

  return comments.map((comment) => normalizeInlineComment(comment, usersById, fallbackUsersById));
};

export const buildInlineCommentNotificationResourceId = ({ chapterId, anchorKey, commentId, replyId }) => {
  const safeChapterId = String(chapterId || "").trim();
  const safeAnchorKey = String(anchorKey || "").trim();
  if (!safeChapterId || !safeAnchorKey) return "";

  const segments = [safeChapterId, encodeURIComponent(safeAnchorKey)];
  const safeCommentId = String(commentId || "").trim();
  const safeReplyId = String(replyId || "").trim();

  if (safeCommentId) segments.push(safeCommentId);
  if (safeReplyId) segments.push(safeReplyId);

  return segments.join("::");
};

export const parseInlineCommentNotificationResourceId = (resourceId) => {
  const rawValue = String(resourceId || "").trim();
  if (!rawValue) return { chapterId: "", anchorKey: "", commentId: "", replyId: "" };

  const separatorIndex = rawValue.indexOf("::");
  if (separatorIndex === -1) {
    return { chapterId: rawValue, anchorKey: "", commentId: "", replyId: "" };
  }

  const [rawChapterId = "", rawEncodedAnchorKey = "", rawCommentId = "", rawReplyId = ""] = rawValue.split("::");
  const chapterId = rawChapterId.trim();
  const encodedAnchorKey = rawEncodedAnchorKey.trim();
  const commentId = rawCommentId.trim();
  const replyId = rawReplyId.trim();

  if (!encodedAnchorKey) {
    return { chapterId, anchorKey: "", commentId, replyId };
  }

  try {
    return {
      chapterId,
      anchorKey: decodeURIComponent(encodedAnchorKey),
      commentId,
      replyId,
    };
  } catch (error) {
    console.warn("parseInlineCommentNotificationResourceId decode error:", error?.message || error);
    return {
      chapterId,
      anchorKey: encodedAnchorKey,
      commentId,
      replyId,
    };
  }
};

export const BookInlineCommentsService = {
  isConfigured() {
    return Boolean(appwriteConfig.booksChapterInlineCommentThreadsCollectionId && appwriteConfig.booksChapterInlineCommentsCollectionId);
  },

  likesEnabled() {
    return Boolean(getCommentLikesCollectionId());
  },

  repliesEnabled() {
    return Boolean(getCommentRepliesCollectionId());
  },

  getFeatureFlags(overrides = {}) {
    return getInlineCommentFeatureFlags(overrides);
  },

  async fetchAllChapterThreads({ bookChapterId }) {
    if (!bookChapterId || !ensureConfigured()) return [];

    const documents = [];
    let lastId = null;
    let shouldContinue = true;

    try {
      while (shouldContinue) {
        const queries = [Query.equal("booksChapter", bookChapterId), Query.orderAsc("$id"), Query.limit(THREADS_PAGE_LIMIT)];
        if (lastId) queries.push(Query.cursorAfter(lastId));

        const response = await databases.listDocuments(appwriteConfig.databaseId, getThreadCollectionId(), queries);
        documents.push(...(response.documents || []));

        lastId = response.documents?.at(-1)?.$id || null;
        shouldContinue = (response.documents || []).length === THREADS_PAGE_LIMIT;
      }

      if (documents.length === 0) return documents;

      const threadIds = documents.map((document) => document?.$id).filter(Boolean);
      const commentDocuments = await listAllDocumentsByField({
        collectionId: getCommentCollectionId(),
        field: "thread",
        values: threadIds,
      }).catch((error) => {
        console.warn("fetchAllChapterThreads inline comments error:", error?.message || error);
        return [];
      });
      const commentIds = commentDocuments.map((document) => document?.$id).filter(Boolean);
      const replyDocuments =
        getCommentRepliesCollectionId() && commentIds.length > 0
          ? await listAllDocumentsByField({
              collectionId: getCommentRepliesCollectionId(),
              field: "bookChapterInlineComment",
              values: commentIds,
            }).catch((error) => {
              console.warn("fetchAllChapterThreads inline replies error:", error?.message || error);
              return [];
            })
          : [];

      const replyDocumentsByCommentId = groupDocumentsByParentCommentId(replyDocuments);
      const topLevelCountsByThreadId = commentDocuments.reduce((accumulator, commentDocument) => {
        const threadId = getInlineThreadId(commentDocument);
        if (!threadId) return accumulator;

        accumulator[threadId] = (accumulator[threadId] || 0) + 1;
        return accumulator;
      }, {});
      const replyCountsByThreadId = commentDocuments.reduce((accumulator, commentDocument) => {
        const threadId = getInlineThreadId(commentDocument);
        if (!threadId) return accumulator;

        accumulator[threadId] = (accumulator[threadId] || 0) + (replyDocumentsByCommentId[commentDocument.$id]?.length || 0);
        return accumulator;
      }, {});

      return documents.map((threadDocument) => {
        const topLevelCount = Number.isFinite(topLevelCountsByThreadId[threadDocument.$id])
          ? topLevelCountsByThreadId[threadDocument.$id]
          : Math.max(threadDocument?.commentsCount ?? 0, 0);
        const repliesCount = Math.max(replyCountsByThreadId[threadDocument.$id] || 0, 0);

        return {
          ...threadDocument,
          commentsCount: topLevelCount,
          repliesCount,
          totalCommentCount: topLevelCount + repliesCount,
        };
      });
    } catch (error) {
      console.warn("fetchAllChapterThreads error:", error?.message || error);
      return [];
    }
  },

  async getThreadByAnchor({ bookChapterId, anchorKey }) {
    if (!bookChapterId || !anchorKey || !ensureConfigured()) return null;

    const threadId = getInlineCommentThreadDocumentId(bookChapterId, anchorKey);

    try {
      return await databases.getDocument(appwriteConfig.databaseId, getThreadCollectionId(), threadId);
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.warn("getThreadByAnchor by id error:", error?.message || error);
      }

      try {
        return await findThreadByAnchorQuery({ bookChapterId, anchorKey });
      } catch (queryError) {
        console.warn("getThreadByAnchor query error:", queryError?.message || queryError);
        return null;
      }
    }
  },

  async ensureThread({ bookChapterId, anchor }) {
    if (!bookChapterId || !anchor?.anchorKey || !ensureConfigured()) return null;

    const threadId = getInlineCommentThreadDocumentId(bookChapterId, anchor.anchorKey);

    try {
      return await databases.createDocument(appwriteConfig.databaseId, getThreadCollectionId(), threadId, buildThreadSeed({ bookChapterId, anchor }));
    } catch (error) {
      if (isConflictError(error)) {
        return this.getThreadByAnchor({ bookChapterId, anchorKey: anchor.anchorKey });
      }

      if (shouldRetryWithoutLastCommentAt(error)) {
        try {
          return await databases.createDocument(
            appwriteConfig.databaseId,
            getThreadCollectionId(),
            threadId,
            buildThreadSeed({ bookChapterId, anchor, includeLastCommentAt: false }),
          );
        } catch (retryError) {
          if (isConflictError(retryError)) {
            return this.getThreadByAnchor({ bookChapterId, anchorKey: anchor.anchorKey });
          }
          console.warn("ensureThread retry error:", retryError?.message || retryError);
          throw retryError;
        }
      }

      console.warn("ensureThread error:", error?.message || error);
      throw error;
    }
  },

  async fetchThreadComments({ threadId, lastId, limit = COMMENTS_PAGE_LIMIT }) {
    if (!threadId || !ensureConfigured()) return emptyDocumentList;

    try {
      const queries = [Query.equal("thread", threadId), Query.orderDesc("$createdAt"), Query.limit(limit)];
      if (lastId) queries.push(Query.cursorAfter(lastId));
      const response = await databases.listDocuments(appwriteConfig.databaseId, getCommentCollectionId(), queries);
      const commentDocuments = response.documents || [];
      const commentIds = commentDocuments.map((commentDocument) => commentDocument?.$id).filter(Boolean);
      const shouldFetchLikes = Boolean(getCommentLikesCollectionId());
      const shouldFetchReplies = Boolean(getCommentRepliesCollectionId());
      const [likeDocuments, replyDocuments] = await Promise.all([
        shouldFetchLikes
          ? listAllDocumentsByField({
              collectionId: getCommentLikesCollectionId(),
              field: "bookChapterInlineComment",
              values: commentIds,
            }).catch((error) => {
              console.warn("fetchThreadComments inline likes error:", error?.message || error);
              return [];
            })
          : Promise.resolve([]),
        shouldFetchReplies
          ? listAllDocumentsByField({
              collectionId: getCommentRepliesCollectionId(),
              field: "bookChapterInlineComment",
              values: commentIds,
            }).catch((error) => {
              console.warn("fetchThreadComments inline replies error:", error?.message || error);
              return [];
            })
          : Promise.resolve([]),
      ]);
      const likesByCommentId = groupDocumentsByParentCommentId(likeDocuments);
      const repliesByCommentId = groupDocumentsByParentCommentId(replyDocuments);
      const userIds = [
        ...commentDocuments.map((commentDocument) => getCommentOwnerId(commentDocument)),
        ...replyDocuments.map((replyDocument) => getReplyOwnerId(replyDocument)),
        ...likeDocuments.map((likeDocument) => getLikeOwnerId(likeDocument)),
      ].filter(Boolean);
      const usersById = await fetchUsersMapByIds(userIds);
      const normalizedDocuments = commentDocuments.map((commentDocument) =>
        normalizeInlineComment(
          {
            ...commentDocument,
            booksChapterInlineCommentLikes: likesByCommentId[commentDocument.$id] || [],
            booksChapterInlineCommentReplies: repliesByCommentId[commentDocument.$id] || [],
          },
          usersById,
        ),
      );

      return {
        ...response,
        documents: normalizedDocuments,
      };
    } catch (error) {
      console.warn("fetchThreadComments error:", error?.message || error);
      return emptyDocumentList;
    }
  },

  async syncThreadStats({ threadId, latestCommentPreview = "" }) {
    if (!threadId || !ensureConfigured()) return null;

    try {
      const snapshot = await databases.listDocuments(appwriteConfig.databaseId, getCommentCollectionId(), [
        Query.equal("thread", threadId),
        Query.orderDesc("$createdAt"),
        Query.limit(1),
      ]);

      const latestComment = snapshot.documents?.[0];
      const nextData = {
        commentsCount: snapshot.total || 0,
        latestCommentPreview: shortenInlineCommentText(stripMentionMarkup(latestComment?.comment || latestCommentPreview || ""), 180),
      };

      if (latestComment?.$createdAt) {
        nextData.lastCommentAt = latestComment.$createdAt;
      }

      return await databases.updateDocument(appwriteConfig.databaseId, getThreadCollectionId(), threadId, nextData);
    } catch (error) {
      console.warn("syncThreadStats error:", error?.message || error);
      return null;
    }
  },

  async createInlineComment({ bookChapterId, anchor, comment, commentOwner, commentOwnerDocument }) {
    if (!bookChapterId || !anchor?.anchorKey || !comment?.trim() || !commentOwner || !ensureConfigured()) return null;

    const thread = await this.ensureThread({ bookChapterId, anchor });
    if (!thread?.$id) {
      throw new Error("Unable to create or find the inline comment thread.");
    }

    try {
      const createdComment = await databases.createDocument(appwriteConfig.databaseId, getCommentCollectionId(), ID.unique(), {
        thread: thread.$id,
        booksChapter: bookChapterId,
        anchorKey: anchor.anchorKey,
        comment: comment.trim(),
        commentOwner,
      });

      const syncedThread = await this.syncThreadStats({ threadId: thread.$id, latestCommentPreview: comment.trim() });
      const fallbackUsersById = commentOwnerDocument?.$id ? { [commentOwnerDocument.$id]: commentOwnerDocument } : {};
      const normalizedComment = normalizeInlineComment(createdComment, {}, fallbackUsersById);

      return {
        comment: normalizedComment,
        thread: syncedThread || {
          ...thread,
          commentsCount: Math.max((thread.commentsCount || 0) + 1, 1),
          latestCommentPreview: shortenInlineCommentText(stripMentionMarkup(comment.trim()), 180),
          lastCommentAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      console.warn("createInlineComment error:", error?.message || error);
      throw error;
    }
  },

  async likeComment({ userId, commentId, likeOwnerDocument }) {
    if (!userId || !commentId) return null;
    if (!getCommentLikesCollectionId()) return missingConfig("booksChapterInlineCommentLikesCollectionId");

    try {
      const existingLike = await databases.listDocuments(appwriteConfig.databaseId, getCommentLikesCollectionId(), [
        Query.equal("bookChapterInlineComment", [commentId]),
        Query.equal("likeOwner", [userId]),
        Query.limit(1),
      ]);

      if (existingLike.total > 0) {
        return normalizeInlineLike(existingLike.documents[0], {}, likeOwnerDocument?.$id ? { [likeOwnerDocument.$id]: likeOwnerDocument } : {});
      }

      const createdLike = await databases.createDocument(appwriteConfig.databaseId, getCommentLikesCollectionId(), ID.unique(), {
        bookChapterInlineComment: commentId,
        likeOwner: userId,
      });

      return normalizeInlineLike(createdLike, {}, likeOwnerDocument?.$id ? { [likeOwnerDocument.$id]: likeOwnerDocument } : {});
    } catch (error) {
      console.warn("likeComment error:", error?.message || error);
      throw error;
    }
  },

  async removeLikeComment({ userId, commentId }) {
    if (!userId || !commentId) return null;
    if (!getCommentLikesCollectionId()) return missingConfig("booksChapterInlineCommentLikesCollectionId");

    try {
      const existingLike = await databases.listDocuments(appwriteConfig.databaseId, getCommentLikesCollectionId(), [
        Query.equal("bookChapterInlineComment", [commentId]),
        Query.equal("likeOwner", [userId]),
        Query.limit(1),
      ]);

      if (existingLike.total === 0) return null;
      return await databases.deleteDocument(appwriteConfig.databaseId, getCommentLikesCollectionId(), existingLike.documents[0].$id);
    } catch (error) {
      console.warn("removeLikeComment error:", error?.message || error);
      throw error;
    }
  },

  async createReplyComment({ comment, commentOwner, bookChapterInlineComment, commentOwnerDocument }) {
    if (!comment?.trim() || !commentOwner || !bookChapterInlineComment) return null;
    if (!getCommentRepliesCollectionId()) return missingConfig("booksChapterInlineCommentRepliesCollectionId");

    try {
      const createdReply = await databases.createDocument(appwriteConfig.databaseId, getCommentRepliesCollectionId(), ID.unique(), {
        bookChapterInlineComment,
        comment: comment.trim(),
        commentOwner,
      });

      return normalizeInlineReply(createdReply, {}, commentOwnerDocument?.$id ? { [commentOwnerDocument.$id]: commentOwnerDocument } : {});
    } catch (error) {
      console.warn("createReplyComment error:", error?.message || error);
      throw error;
    }
  },

  async deleteReplyComment({ replyId }) {
    if (!replyId) return null;
    if (!getCommentRepliesCollectionId()) return missingConfig("booksChapterInlineCommentRepliesCollectionId");

    try {
      await databases.deleteDocument(appwriteConfig.databaseId, getCommentRepliesCollectionId(), replyId);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return true;
      console.warn("deleteReplyComment error:", error?.message || error);
      throw error;
    }
  },

  async deleteInlineComment({ commentId, threadId }) {
    if (!commentId || !ensureConfigured()) return null;

    const normalizedThreadId = String(threadId || "").trim();

    try {
      await databases.deleteDocument(appwriteConfig.databaseId, getCommentCollectionId(), commentId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          thread: normalizedThreadId ? await this.syncThreadStats({ threadId: normalizedThreadId }) : null,
        };
      }

      if (!shouldRetryDeleteAfterCleanup(error)) {
        console.warn("deleteInlineComment error:", error?.message || error);
        throw error;
      }

      await Promise.allSettled([
        getCommentRepliesCollectionId()
          ? deleteDocumentsByFieldValue({
              collectionId: getCommentRepliesCollectionId(),
              field: "bookChapterInlineComment",
              value: commentId,
            })
          : Promise.resolve([]),
        getCommentLikesCollectionId()
          ? deleteDocumentsByFieldValue({
              collectionId: getCommentLikesCollectionId(),
              field: "bookChapterInlineComment",
              value: commentId,
            })
          : Promise.resolve([]),
      ]);

      try {
        await databases.deleteDocument(appwriteConfig.databaseId, getCommentCollectionId(), commentId);
      } catch (retryError) {
        if (isNotFoundError(retryError)) {
          return {
            thread: normalizedThreadId ? await this.syncThreadStats({ threadId: normalizedThreadId }) : null,
          };
        }
        console.warn("deleteInlineComment retry error:", retryError?.message || retryError);
        throw retryError;
      }
    }

    return {
      thread: normalizedThreadId ? await this.syncThreadStats({ threadId: normalizedThreadId }) : null,
    };
  },
};
