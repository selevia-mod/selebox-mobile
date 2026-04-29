import axios from "axios";
import * as FileSystem from "expo-file-system";
import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { appwriteConfig, databases } from "./appwrite";

export const initialVideoForm = {
  thumbnail: "",
  videoUrl: "",
  title: "",
  description: "",
  tags: [],
  uri: "",
  uploader: "",
};

export class VideosService {
  async fetchVideos({ userId, lastId, category, limit = 20, status, offset }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
    if (typeof offset === "number" && offset > 0) {
      queries.push(Query.offset(offset));
    }
    if (lastId) queries.push(Query.cursorAfter(lastId));
    if (Array.isArray(userId) ? userId.length > 0 : userId) queries.push(Query.equal("uploader", userId));
    if (category) queries.push(Query.contains("tags", category));
    if (status) {
      queries.push(Query.equal("status", status));
    } else {
      // Hide soft-deleted videos by default
      queries.push(Query.notEqual("status", "deleted"));
    }

    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, queries);
  }

  async getVideo({ id }) {
    return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id);
  }

  async searchVideo({ uri }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, [Query.equal("uri", uri)]);
  }

  async uploadVideoToBunnyStream(videoID, file, { onProgress, signal } = {}) {
    try {
      if (!file?.uri) {
        console.error("uploadVideoToBunnyStream missing file uri");
        return { status: false };
      }

      // 1. CREATE VIDEO ENTRY
      const createRes = await fetch(`https://video.bunnycdn.com/library/${secrets.BUNNY_STREAM_VIDEOS_LIBRARY_ID}/videos`, {
        method: "POST",
        headers: {
          AccessKey: secrets.BUNNY_STREAM_VIDEOS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: videoID,
          guid: videoID,
        }),
      });

      const createJson = await createRes.json();

      if (!createRes.ok || !createJson.guid) {
        console.error("Error creating video:", createJson);
        return { status: false };
      }

      const videoId = createJson.guid;

      // 2. UPLOAD VIDEO FILE WITH PROGRESS & CANCEL SUPPORT
      const uploadUrl = `https://video.bunnycdn.com/library/${secrets.BUNNY_STREAM_VIDEOS_LIBRARY_ID}/videos/${videoId}`;

      const uploadTask = FileSystem.createUploadTask(
        uploadUrl,
        file.uri,
        {
          httpMethod: "PUT",
          headers: {
            AccessKey: secrets.BUNNY_STREAM_VIDEOS_API_KEY,
            "Content-Type": "application/octet-stream",
          },
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        },
        (data) => {
          if (!data?.totalBytesExpectedToSend) return;
          const pct = Math.min(100, Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100));
          onProgress?.(pct);
        },
      );

      const abortHandler = () => uploadTask.cancelAsync();
      if (signal) signal.addEventListener("abort", abortHandler);

      let uploadResult;
      try {
        uploadResult = await uploadTask.uploadAsync();
      } catch (err) {
        if (signal?.aborted) {
          console.warn("Upload cancelled by user");
          return { status: false, cancelled: true, videoId };
        }
        console.error("Upload error:", err);
        return { status: false, videoId };
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
      }

      if (!uploadResult || uploadResult.status >= 400) {
        console.log("Upload failed:", uploadResult?.body || uploadResult?.status);
        return { status: false, videoId };
      }

      return {
        videoId,
        status: true,
      };
    } catch (error) {
      console.error("Upload error:", error);
      return { status: false };
    }
  }

  async deleteVideoFromBunnyStream(videoId) {
    try {
      const response = await fetch(`https://video.bunnycdn.com/library/${secrets.BUNNY_STREAM_VIDEOS_LIBRARY_ID}/videos/${videoId}`, {
        method: "DELETE",
        headers: {
          AccessKey: secrets.BUNNY_STREAM_VIDEOS_API_KEY,
        },
      });

      return response.ok;
    } catch (error) {
      console.error("Delete error:", error);
      return false;
    }
  }

  async deleteThumbnailFromBunnyStorage(fileId) {
    try {
      const response = await fetch(
        `https://sg.storage.bunnycdn.com/selebox-videos-storage/${secrets.BUNNY_VIDEOS_STORAGE_CDN_HOSTNAME}/videos/${fileId}`,
        {
          method: "DELETE",
          headers: {
            AccessKey: secrets.BUNNY_VIDEOS_STORAGE_ACCESS_KEY,
          },
        },
      );

      return response.ok;
    } catch (error) {
      console.error("Delete error:", error);
      return false;
    }
  }

  async viewVideo({ videoId, userId }) {
    try {
      if (!userId || !videoId) {
        console.warn("❌ viewVideo missing required IDs:", {
          userId,
          videoId,
        });
        return;
      }

      const existing = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosViewsCollectionId, [
        Query.equal("user", userId),
        Query.equal("video", videoId),
      ]);

      if (existing.total === 0) {
        await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosViewsCollectionId, ID.unique(), {
          user: userId,
          video: videoId,
          viewCount: 1,
        });
      } else {
        const doc = existing.documents[0];

        await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.videosViewsCollectionId, doc.$id, {
          viewCount: (doc.viewCount || 0) + 1,
        });
      }
    } catch (err) {
      console.error("videoView error:", err?.message || err);
    }
  }

  async checkVideoStatus({ videoId }) {
    try {
      const response = await axios.get(`https://video.bunnycdn.com/library/${secrets.BUNNY_STREAM_VIDEOS_LIBRARY_ID}/videos/${videoId}`, {
        headers: {
          AccessKey: secrets.BUNNY_STREAM_VIDEOS_API_KEY,
          "Content-Type": "application/json",
        },
      });
      const data = response.data;

      return data;
    } catch (err) {
      console.error("checkVideoProcessingStatus failed:", err.message);
      throw err;
    }
  }

  async uploadVideo({ payload, jwt }) {
    try {
      const response = await fetch("https://692887e3003e06aac8ce.fra.appwrite.run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-appwrite-jwt": jwt,
          "x-appwrite-project": appwriteConfig.projectId,
        },
        body: JSON.stringify(payload),
      });
      return response;
    } catch (err) {
      console.error("uploadVideo failed:", err);
    }
  }
}

export const createNewVideo = async ({ ID, title, description, thumbnail, uri, videoUrl, uploader, status = "uploading", ...props }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, ID, {
    title: title,
    description: description,
    thumbnail: thumbnail,
    uri: uri,
    videoUrl: videoUrl,
    uploader: uploader,
    status,
    ...props,
  });
};

export const updateVideoDocument = async ({ id, data }) => {
  try {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id, data);
  } catch (err) {
    console.error("updateVideoDocument error:", err);
    throw err;
  }
};

export const deleteVideoDocument = async ({ id }) => {
  try {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id);
  } catch (err) {
    console.error("deleteVideoDocument error:", err);
    throw err;
  }
};

export const createVideoMetric = async ({ videoID }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, ID.unique(), {
    videoID: videoID,
    totalViews: 0,
    dailyViews: JSON.stringify({}),
  });
};

export const createVideoLikes = async ({ videoID }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videoUserLikesCollectionId, ID.unique(), {
    videoID: videoID,
    videoLikes: 0,
  });
};

export const getVideoLikeByOwner = async ({ videoId, likeOwner }) => {
  const queries = [Query.and([Query.equal("video", videoId), Query.equal("likeOwner", likeOwner)])];
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, queries);
};

export const createVideoLike = async ({ videoId, likeOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, ID.unique(), {
    video: videoId,
    likeOwner,
  });
};

export const deleteVideoLike = async ({ videoLikeId }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, videoLikeId);
};

export const updateVideo = async ({ id, data }) => {
  try {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, id, data);
  } catch (err) {
    console.error("updateVideo error:", err);
    throw err;
  }
};

//  INCREMENT / DECREMENT VIDEO LIKES
export const incrementVideoLikes = async ({ id, incrementBy = 1 }) => {
  try {
    // Fetch current video data
    const video = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, id);

    const currentLikes = video.videoLikes ?? 0;
    const updatedLikes = Math.max(0, currentLikes + incrementBy);

    return updateVideo({
      id,
      data: { videoLikes: updatedLikes },
    });
  } catch (err) {
    console.error("incrementVideoLikes error:", err);
  }
};

export const createVideoComment = async ({ videoId, comment, commentOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosCommentsCollectionId, ID.unique(), {
    video: videoId,
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

const VIDEO_COMMENT_PARENT_KEYS = ["videoComment", "videoComments", "parentComment", "parentCommentId", "replyToComment"];
const VIDEO_COMMENT_LIKE_KEYS = ["videoComment", "videosComment", "videoComments"];
const getVideoCommentLikesCollectionId = () => appwriteConfig.videosCommentLikesCollectionId || appwriteConfig.videoCommentLikesCollectionId || null;

export const resolveVideoCommentParentId = (comment = {}) => {
  return (
    resolveNestedRelationId(comment?.videoComment) ||
    resolveNestedRelationId(comment?.videoComments) ||
    resolveNestedRelationId(comment?.parentComment) ||
    resolveNestedRelationId(comment?.parentCommentId) ||
    resolveNestedRelationId(comment?.replyToComment) ||
    null
  );
};

export const mapVideoRepliesByParentId = (replies = []) => {
  const repliesByParent = {};

  (replies || []).forEach((reply) => {
    const parentId = resolveVideoCommentParentId(reply);
    if (!parentId) return;
    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(reply);
  });

  return repliesByParent;
};

export const resolveVideoCommentLikeId = (like = {}) => {
  return (
    resolveNestedRelationId(like?.videoComment) ||
    resolveNestedRelationId(like?.videosComment) ||
    resolveNestedRelationId(like?.videoComments) ||
    null
  );
};

export const mapVideoCommentLikesByCommentId = (likes = []) => {
  const likesByCommentId = {};

  (likes || []).forEach((like) => {
    const commentId = resolveVideoCommentLikeId(like);
    if (!commentId) return;
    if (!likesByCommentId[commentId]) likesByCommentId[commentId] = [];
    likesByCommentId[commentId].push(like);
  });

  return likesByCommentId;
};

export const fetchVideoCommentLikesByCommentIds = async ({ commentIds = [], limit = 1000 }) => {
  if (!Array.isArray(commentIds) || commentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  const likesCollectionId = getVideoCommentLikesCollectionId();
  if (!likesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of VIDEO_COMMENT_LIKE_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, likesCollectionId, [
        Query.equal(relationKey, commentIds),
        Query.limit(limit),
      ]);
      const documents = response?.documents || [];
      return {
        relationKey,
        documents,
        byCommentId: mapVideoCommentLikesByCommentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchVideoCommentLikesByCommentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byCommentId: {},
  };
};

export const getVideoCommentLikeByOwner = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  const likesCollectionId = getVideoCommentLikesCollectionId();
  if (!likesCollectionId) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  let lastError = null;
  for (const relationKey of VIDEO_COMMENT_LIKE_KEYS) {
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

  console.log("getVideoCommentLikeByOwner: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    total: 0,
    documents: [],
  };
};

export const createVideoCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("createVideoCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = getVideoCommentLikesCollectionId();
    if (!likesCollectionId) return null;

    const existing = await getVideoCommentLikeByOwner({ commentId, likeOwner });
    if ((existing?.total || 0) > 0) {
      return existing.documents?.[0] || null;
    }

    let lastError = null;
    for (const relationKey of VIDEO_COMMENT_LIKE_KEYS) {
      try {
        return await databases.createDocument(appwriteConfig.databaseId, likesCollectionId, ID.unique(), {
          [relationKey]: commentId,
          likeOwner,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("createVideoCommentLike failed");
  } catch (error) {
    console.error("createVideoCommentLike error:", error?.message || error);
    return null;
  }
};

export const removeVideoCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("removeVideoCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = getVideoCommentLikesCollectionId();
    if (!likesCollectionId) return null;

    const existing = await getVideoCommentLikeByOwner({ commentId, likeOwner });
    const existingLikeId = existing?.documents?.[0]?.$id;
    if (!existingLikeId) return null;

    return databases.deleteDocument(appwriteConfig.databaseId, likesCollectionId, existingLikeId);
  } catch (error) {
    console.error("removeVideoCommentLike error:", error?.message || error);
    return null;
  }
};

export const fetchVideoCommentRepliesByParentIds = async ({ parentCommentIds = [], limit = 400 }) => {
  if (!Array.isArray(parentCommentIds) || parentCommentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  const repliesCollectionId = appwriteConfig.videosCommentRepliesCollectionId;
  if (!repliesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of VIDEO_COMMENT_PARENT_KEYS) {
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
        byParentId: mapVideoRepliesByParentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchVideoCommentRepliesByParentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byParentId: {},
  };
};

export const threadVideoComments = (rawComments = [], externalRepliesByParent = null) => {
  if (!Array.isArray(rawComments) || rawComments.length === 0) return [];

  if (externalRepliesByParent && typeof externalRepliesByParent === "object") {
    return rawComments.map((comment) => ({
      ...comment,
      videoComments: externalRepliesByParent[comment?.$id] || [],
    }));
  }

  const topLevel = [];
  const repliesByParent = {};
  const orphanReplies = [];

  rawComments.forEach((comment) => {
    const parentId = resolveVideoCommentParentId(comment);
    if (!parentId) {
      topLevel.push(comment);
      return;
    }

    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(comment);
  });

  const threaded = topLevel.map((comment) => ({
    ...comment,
    videoComments: repliesByParent[comment?.$id] || [],
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
        videoComments: [],
      });
    });
  }

  return threaded;
};

export const createVideoReplyComment = async ({ videoId, comment, commentOwner, parentCommentId }) => {
  if (!videoId || !commentOwner || !parentCommentId || !comment?.trim()) {
    throw new Error("createVideoReplyComment: missing required params");
  }

  const trimmedComment = comment.trim();
  const basePayload = {
    video: videoId,
    comment: trimmedComment,
    commentOwner,
  };
  const fallbackPayload = {
    comment: trimmedComment,
    commentOwner,
  };
  const repliesCollectionId = appwriteConfig.videosCommentRepliesCollectionId || appwriteConfig.videosCommentsCollectionId;
  let lastError = null;

  for (const relationKey of VIDEO_COMMENT_PARENT_KEYS) {
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

  throw lastError || new Error("createVideoReplyComment failed");
};

const toVideoCount = (value) => {
  if (Array.isArray(value)) return value.length;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
};

const isUnauthorizedError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("not authorized") || message.includes("unauthorized");
};

export const resolveVideoCommentCount = (video) => {
  const candidates = [
    video?.commentsCount,
    video?.commentCount,
    video?.comments,
    video?.totalComments,
    video?.videoComments,
    video?.videoStats?.commentsCount,
    video?.videoStats?.commentCount,
    video?.videoStats?.comments,
    video?.videoStats?.totalComments,
    video?.videoStats?.videoComments,
  ];

  for (const candidate of candidates) {
    const count = toVideoCount(candidate);
    if (count !== null) return count;
  }

  return null;
};

// Fetch comments
export const fetchVideoComments = async ({ videoId, lastId, limit = 10 }) => {
  const queries = [Query.equal("video", videoId), Query.orderDesc("$createdAt"), Query.limit(limit)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCommentsCollectionId, queries);
};

export const getVideoCommentCount = async ({ videoId }) => {
  if (!videoId) return null;

  try {
    const video = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, videoId);
    const resolvedCount = resolveVideoCommentCount(video);
    if (resolvedCount !== null) return resolvedCount;
  } catch (err) {
    if (!isUnauthorizedError(err)) {
      console.warn("getVideoCommentCount video lookup error:", err);
    }
  }

  try {
    const res = await fetchVideoComments({ videoId, limit: 1 });
    return res?.total ?? 0;
  } catch (err) {
    if (!isUnauthorizedError(err)) {
      console.warn("getVideoCommentCount error:", err);
    }
    return null;
  }
};

export const getVideoLikeCount = async ({ videoId }) => {
  try {
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, [
      Query.equal("video", videoId),
      Query.limit(1),
    ]);
    return res?.total ?? 0;
  } catch (err) {
    console.error("getVideoLikeCount error:", err);
    return 0;
  }
};

// ========== COMMENT COUNT INCREMENT ==========
export const incrementVideoComments = async ({ id, incrementBy = 1 }) => {
  try {
    const video = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, id);
    const currentComments = video.videoComments ?? 0;
    const updatedComments = Math.max(0, currentComments + incrementBy);

    return updateVideo({ id, data: { videoComments: updatedComments } });
  } catch (err) {
    console.error("incrementVideoComments error:", err);
    throw err;
  }
};
