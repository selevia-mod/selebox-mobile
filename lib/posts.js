import { ID, Query } from "react-native-appwrite";
import { storage as localStorage } from "../store/storage";
import { appwriteConfig, databases, storage } from "./appwrite";
import { getClip } from "./clips";
import { searchUsers } from "./users";
import { VideosService } from "./video";

const feedGeneratorApi = "https://692eea2e002e16d51edd.fra.appwrite.run";
const LOCAL_POST_VIEWS_KEY_PREFIX = "post-views:";
const MAX_CACHED_POST_VIEWS = 220;

const safeParse = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.log("posts: parse error", error);
    return null;
  }
};

const normalizeSeenPostIds = (postIds = []) => {
  const normalized = [];

  (Array.isArray(postIds) ? postIds : []).forEach((postId) => {
    const normalizedId = typeof postId === "string" ? postId : postId?.toString?.();
    if (!normalizedId || normalized.includes(normalizedId)) return;
    normalized.push(normalizedId);
  });

  return normalized;
};

const mergeSeenPostIds = (...collections) => {
  const merged = [];

  collections.forEach((postIds) => {
    normalizeSeenPostIds(postIds).forEach((postId) => {
      const existingIndex = merged.indexOf(postId);
      if (existingIndex >= 0) merged.splice(existingIndex, 1);
      merged.push(postId);
    });
  });

  if (merged.length > MAX_CACHED_POST_VIEWS) {
    return merged.slice(merged.length - MAX_CACHED_POST_VIEWS);
  }

  return merged;
};

const getLocalPostViewsKey = (userId) => `${LOCAL_POST_VIEWS_KEY_PREFIX}${userId}`;

export const getCachedViewedPostIds = (userId) => {
  if (!userId) return [];
  const cached = safeParse(localStorage.getString(getLocalPostViewsKey(userId)));
  return normalizeSeenPostIds(cached?.postIds);
};

const setCachedViewedPostIds = (userId, postIds = []) => {
  if (!userId) return [];

  const boundedPostIds = mergeSeenPostIds(postIds);
  localStorage.set(
    getLocalPostViewsKey(userId),
    JSON.stringify({
      version: 1,
      postIds: boundedPostIds,
      updatedAt: Date.now(),
    }),
  );

  return boundedPostIds;
};

export const initialPostForm = {
  post: "",
  postUrls: [],
  postOwner: "",
};

export const createNewPost = async ({ post, postUrls, postOwner, ...props }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID.unique(), {
    post,
    postUrls,
    postOwner,
    ...props,
  });
};

export const updatePost = async ({ ID, ...props }) => {
  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID, {
    ...props,
  });
};

export const deletePost = async ({ ID }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID);
};

export const searchPosts = async ({ searchQuery = "", limit = 10, cursorId = null }) => {
  try {
    const userIds = await searchUsers(searchQuery);
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];

    if (userIds.length > 0) {
      queries.push(Query.or([Query.search("post", searchQuery), [Query.equal("postOwner", userIds)]]));
    } else {
      queries.push(Query.search("post", searchQuery));
    }

    if (cursorId) {
      queries.push(Query.cursorAfter(cursorId));
    }

    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
    const lastId = res.documents[res.documents.length - 1]?.$id || null;
    const documents = await hydrateSearchResults(res.documents);
    return {
      documents,
      hasMore: res.documents.length === limit,
      lastId,
    };
  } catch (err) {
    console.error("searchPosts error:", err);
    return { documents: [], hasMore: false };
  }
};

const isValidVideo = (video) => Boolean(video?.videoUrl) && video?.status !== "deleted";
const isValidClip = (clip) => Boolean(clip?.clipUrl) && clip?.status !== "deleted";

const hydrateSearchResults = async (documents = []) => {
  if (!documents.length) return [];

  const videoService = new VideosService();

  const fetchVideo = async (id) => {
    if (!id) return null;
    try {
      return await videoService.getVideo({ id });
    } catch (_) {
      return null;
    }
  };

  const fetchClip = async (id) => {
    if (!id) return null;
    try {
      return await getClip({ ID: id });
    } catch (_) {
      return null;
    }
  };

  const hydrated = await Promise.all(
    documents.map(async (doc) => {
      if (!doc?.postResourceId) return doc;

      const resourceId = doc.postResourceId;
      const resourceType = doc.postResourceType;

      if (resourceType === "video") {
        const video = isValidVideo(doc.video) ? doc.video : await fetchVideo(resourceId);
        if (!isValidVideo(video)) return null;
        return { ...doc, video, postResourceType: "video" };
      }

      if (resourceType === "clip") {
        const clip = isValidClip(doc.clip) ? doc.clip : await fetchClip(resourceId);
        if (!isValidClip(clip)) return null;
        return { ...doc, clip, postResourceType: "clip" };
      }

      if (isValidVideo(doc.video)) {
        return { ...doc, video: doc.video, postResourceType: "video" };
      }

      if (isValidClip(doc.clip)) {
        return { ...doc, clip: doc.clip, postResourceType: "clip" };
      }

      const video = await fetchVideo(resourceId);
      if (isValidVideo(video)) {
        return { ...doc, video, postResourceType: "video" };
      }

      const clip = await fetchClip(resourceId);
      if (isValidClip(clip)) {
        return { ...doc, clip, postResourceType: "clip" };
      }

      return null;
    }),
  );

  return hydrated.filter(Boolean);
};

export const fetchPosts = async ({ limit, lastId, userId }) => {
  const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  if (userId) queries.push(Query.equal("postOwner", userId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
};

export const fetchGeneratedPosts = async ({
  limit,
  lastId,
  userId,
  blockedUserIds = [],
  hiddenContentIds = [],
  seenPostIds = [],
  seenPostEngagementByPostId = {},
  refresh = false,
}) => {
  const mergedSeenPostIds = userId ? mergeSeenPostIds(getCachedViewedPostIds(userId), seenPostIds) : mergeSeenPostIds(seenPostIds);
  const allowedSeenPostIds = new Set(mergedSeenPostIds);
  const normalizedSeenPostEngagementByPostId = Object.entries(seenPostEngagementByPostId || {}).reduce((acc, [postId, engagementRate]) => {
    const normalizedPostId = typeof postId === "string" ? postId : postId?.toString?.();
    const normalizedRate = Number(engagementRate);

    if (!normalizedPostId || !allowedSeenPostIds.has(normalizedPostId)) return acc;
    if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) return acc;

    acc[normalizedPostId] = Number(normalizedRate.toFixed(4));
    return acc;
  }, {});

  const payload = {
    limit,
    ...(lastId ? { cursor: lastId } : {}),
    ...(userId ? { userId } : {}),
    ...(blockedUserIds.length > 0 ? { blockedUsers: blockedUserIds } : {}),
    ...(hiddenContentIds.length > 0 ? { hiddenContent: hiddenContentIds } : {}),
    ...(mergedSeenPostIds.length > 0 ? { seenPostIds: mergedSeenPostIds } : {}),
    ...(Object.keys(normalizedSeenPostEngagementByPostId).length > 0 ? { seenPostEngagementByPostId: normalizedSeenPostEngagementByPostId } : {}),
    ...(refresh ? { refresh: true, requestTs: Date.now() } : {}),
  };

  const url = `${feedGeneratorApi}/feed`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
    body: JSON.stringify(payload),
  });
  return res.json();
};

export const recordPostView = async ({ postId, viewOwner }) => {
  if (!postId || !viewOwner) return null;

  const cachedPostIds = getCachedViewedPostIds(viewOwner);
  const nextPostIds = mergeSeenPostIds(cachedPostIds, [postId]);
  setCachedViewedPostIds(viewOwner, nextPostIds);

  return {
    postId,
    viewOwner,
    cached: true,
    updatedAt: new Date().toISOString(),
  };
};

export const getPostLike = async ({ postId, likeOwner }) => {
  const queries = [Query.and([Query.equal("postId", postId), Query.equal("likeOwner", likeOwner)])];
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, queries);
};

export const getPost = async ({ ID }) => {
  return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID);
};

export const createPostLike = async ({ postId, likeOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, ID.unique(), {
    postId,
    likeOwner,
  });
};

export const deletePostLike = async ({ postLikeId }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, postLikeId);
};

export const fetchPostLikes = async ({ postId, lastId, limit }) => {
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, queries);
};

export const fetchPostComments = async ({ postId, lastId, limit }) => {
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, queries);
};

export const createPostComment = async ({ postId, comment, commentOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, ID.unique(), {
    postId,
    comment,
    commentOwner,
  });
};

const resolveNestedRelationId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return resolveNestedRelationId(value[0]);
  return value?.$id || value?.id || null;
};

const POST_COMMENT_PARENT_KEYS = ["postComment", "postComments", "parentComment", "parentCommentId", "replyToComment"];
const POST_COMMENT_LIKE_KEYS = ["postComment", "postsComment"];

export const resolvePostCommentParentId = (comment = {}) => {
  return (
    resolveNestedRelationId(comment?.postComment) ||
    resolveNestedRelationId(comment?.postComments) ||
    resolveNestedRelationId(comment?.parentComment) ||
    resolveNestedRelationId(comment?.parentCommentId) ||
    resolveNestedRelationId(comment?.replyToComment) ||
    null
  );
};

export const mapPostRepliesByParentId = (replies = []) => {
  const repliesByParent = {};

  (replies || []).forEach((reply) => {
    const parentId = resolvePostCommentParentId(reply);
    if (!parentId) return;
    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(reply);
  });

  return repliesByParent;
};

export const resolvePostCommentLikeId = (like = {}) => {
  return resolveNestedRelationId(like?.postComment) || resolveNestedRelationId(like?.postsComment) || null;
};

export const mapPostCommentLikesByCommentId = (likes = []) => {
  const likesByCommentId = {};

  (likes || []).forEach((like) => {
    const commentId = resolvePostCommentLikeId(like);
    if (!commentId) return;
    if (!likesByCommentId[commentId]) likesByCommentId[commentId] = [];
    likesByCommentId[commentId].push(like);
  });

  return likesByCommentId;
};

export const fetchPostCommentLikesByCommentIds = async ({ commentIds = [], limit = 1000 }) => {
  if (!Array.isArray(commentIds) || commentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
  if (!likesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_LIKE_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, likesCollectionId, [
        Query.equal(relationKey, commentIds),
        Query.limit(limit),
      ]);
      const documents = response?.documents || [];
      return {
        relationKey,
        documents,
        byCommentId: mapPostCommentLikesByCommentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchPostCommentLikesByCommentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byCommentId: {},
  };
};

export const getPostCommentLikeByOwner = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
  if (!likesCollectionId) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_LIKE_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, likesCollectionId, [
        Query.equal(relationKey, [commentId]),
        Query.equal("likeOwner", [likeOwner]),
        Query.limit(1),
      ]);
      return {
        relationKey,
        total: Number(response?.total || 0),
        documents: response?.documents || [],
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("getPostCommentLikeByOwner: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    total: 0,
    documents: [],
  };
};

export const createPostCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("createPostCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
    if (!likesCollectionId) return null;

    const existing = await getPostCommentLikeByOwner({ commentId, likeOwner });
    if ((existing?.total || 0) > 0) {
      return existing.documents?.[0] || null;
    }

    let lastError = null;
    for (const relationKey of POST_COMMENT_LIKE_KEYS) {
      try {
        return await databases.createDocument(appwriteConfig.databaseId, likesCollectionId, ID.unique(), {
          [relationKey]: commentId,
          likeOwner,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("createPostCommentLike failed");
  } catch (error) {
    console.error("createPostCommentLike error:", error?.message || error);
    return null;
  }
};

export const removePostCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("removePostCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
    if (!likesCollectionId) return null;

    const existing = await getPostCommentLikeByOwner({ commentId, likeOwner });
    const existingLikeId = existing?.documents?.[0]?.$id;
    if (!existingLikeId) return null;

    return databases.deleteDocument(appwriteConfig.databaseId, likesCollectionId, existingLikeId);
  } catch (error) {
    console.error("removePostCommentLike error:", error?.message || error);
    return null;
  }
};

export const fetchPostCommentRepliesByParentIds = async ({ parentCommentIds = [], limit = 400 }) => {
  if (!Array.isArray(parentCommentIds) || parentCommentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  const repliesCollectionId = appwriteConfig.postsCommentRepliesCollectionId;
  if (!repliesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_PARENT_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, repliesCollectionId, [
        Query.equal(relationKey, parentCommentIds),
        Query.orderAsc("$createdAt"),
        Query.limit(limit),
      ]);
      const documents = response?.documents || [];
      return {
        relationKey,
        documents,
        byParentId: mapPostRepliesByParentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchPostCommentRepliesByParentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byParentId: {},
  };
};

export const threadPostComments = (rawComments = [], externalRepliesByParent = null) => {
  if (!Array.isArray(rawComments) || rawComments.length === 0) return [];

  if (externalRepliesByParent && typeof externalRepliesByParent === "object") {
    return rawComments.map((comment) => ({
      ...comment,
      postCommentReplies: externalRepliesByParent[comment?.$id] || [],
    }));
  }

  const topLevel = [];
  const repliesByParent = {};
  const orphanReplies = [];

  rawComments.forEach((comment) => {
    const parentId = resolvePostCommentParentId(comment);
    if (!parentId) {
      topLevel.push(comment);
      return;
    }

    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(comment);
  });

  const threaded = topLevel.map((comment) => ({
    ...comment,
    postCommentReplies: repliesByParent[comment?.$id] || [],
  }));

  Object.keys(repliesByParent).forEach((parentId) => {
    const parentExists = topLevel.some((comment) => String(comment?.$id || "") === String(parentId));
    if (!parentExists) {
      orphanReplies.push(...repliesByParent[parentId]);
    }
  });

  if (orphanReplies.length > 0) {
    orphanReplies.forEach((reply) => {
      threaded.push({
        ...reply,
        postCommentReplies: [],
      });
    });
  }

  return threaded;
};

export const createPostReplyComment = async ({ postId, comment, commentOwner, parentCommentId }) => {
  if (!postId || !commentOwner || !parentCommentId || !comment?.trim()) {
    throw new Error("createPostReplyComment: missing required params");
  }

  const trimmedComment = comment.trim();
  const basePayload = {
    postId,
    comment: trimmedComment,
    commentOwner,
  };
  const fallbackPayload = {
    comment: trimmedComment,
    commentOwner,
  };
  const repliesCollectionId = appwriteConfig.postsCommentRepliesCollectionId || appwriteConfig.postsCommentCollectionId;
  let lastError = null;

  for (const relationKey of POST_COMMENT_PARENT_KEYS) {
    for (const payload of [basePayload, fallbackPayload]) {
      try {
        return await databases.createDocument(appwriteConfig.databaseId, repliesCollectionId, ID.unique(), {
          ...payload,
          [relationKey]: parentCommentId,
        });
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("createPostReplyComment failed");
};

export async function uploadImageToStorage(file) {
  const { convertToWebP, cleanupTempFile } = require("./image-utils");
  const webp = await convertToWebP(file.uri, { maxWidth: 1000 });
  try {
    const asset = {
      name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
      size: webp.fileSize,
      type: "image/webp",
      uri: webp.uri,
    };
    const uploadedFile = await storage.createFile(appwriteConfig.postsStorageId, ID.unique(), asset);
    const fileUrl = storage.getFilePreview(appwriteConfig.postsStorageId, uploadedFile.$id);
    if (typeof fileUrl === "string") return fileUrl;
    if (fileUrl?.href) return fileUrl.href;
    if (typeof fileUrl?.toString === "function") return fileUrl.toString();
    return `${fileUrl}`;
  } catch (error) {
    throw error;
  } finally {
    cleanupTempFile(webp.uri, file.uri);
  }
}

export async function deleteImageFromStorage(fileId) {
  try {
    await storage.deleteFile(appwriteConfig.postsStorageId, fileId);
  } catch (error) {
    throw error;
  }
}

export const findPostByVideoId = async (videoId) => {
  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, [Query.equal("postResourceId", videoId)]);
  return res.documents?.[0] || null;
};
