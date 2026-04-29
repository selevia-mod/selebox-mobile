// story-service.js
import FileSystem from "expo-file-system";
import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "../lib/appwrite";
import { BunnyService } from "./bunny-service";
import { FollowService } from "./follows";
import { listBlockedUsers } from "./safety";

// Your deployed Appwrite FFmpeg overlay function
const APPWRITE_FUNCTION_URL = "https://6908d4f3002dadd6f43f.fra.appwrite.run";
const READY_STATUSES = new Set(["ready"]);

const mapDocToStory = (doc) => {
  const inferredStatus = doc.type === "video" ? "processing" : "ready";
  return {
    id: doc.$id,
    type: doc.type,
    mediaUrl: doc.mediaUrl,
    thumbnail: doc.thumbnail,
    user: {
      id: doc.uploader?.$id,
      name: doc.uploader?.username,
      avatar: doc.uploader?.avatar,
    },
    storiesStats: doc.storiesStats,
    createdAt: doc.$createdAt,
    duration: doc.duration || null,
    expiresAt: doc.expiresAt || null,
    musicId: doc.musicId ?? null,
    status: doc.status || inferredStatus,
  };
};

const shouldHideStoryForViewer = (story, viewerId) => {
  const isOwner = story.user?.id === viewerId;
  const status = story.status || (story.type === "video" ? "processing" : "ready");

  if (isOwner) return false;

  if (story.type !== "video") return false;

  return !READY_STATUSES.has(status);
};

export const StoryService = {
  lastGrouped: {},

  /**
   * Get stories only from users the current user follows.
   * Supports pagination.
   */
  async fetchStoriesFromFollowing({ userId, limit = 20, offset = 0 }) {
    if (!userId) throw new Error("User ID is required");

    const blockedIds = await listBlockedUsers({ blockerId: userId }).catch(() => []);

    // Fetch all following users
    const followingRes = await FollowService.getFollowing({
      userId,
      limit: undefined, // fetch all
    });

    const followingDocs = Array.isArray(followingRes.documents) ? followingRes.documents : followingRes;
    const followingIds = followingDocs.map((f) => f.followingId.$id).filter((id) => !blockedIds.includes(id));
    // If no following → no stories
    if (followingIds.length === 0) {
      return { latestPerUser: [], grouped: {} };
    }
    // Fetch stories only from followed users
    const queries = [
      Query.orderDesc("$createdAt"),
      Query.limit(limit),
      Query.offset(offset),
      Query.equal("uploader", followingIds), // filter to followed users
    ];

    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, queries);
    const docs = response.documents || [];

    const mapped = docs.map(mapDocToStory);

    const visibleStories = mapped.filter((story) => {
      if (story.type === "video") return READY_STATUSES.has(story.status);
      return true;
    });

    // Group by user id
    const grouped = visibleStories.reduce((acc, s) => {
      const uid = s.user.id;
      if (!uid) return acc;
      if (!acc[uid]) acc[uid] = [];
      acc[uid].push(s);
      return acc;
    }, {});

    // Sort each user's stories
    for (const uid of Object.keys(grouped)) {
      grouped[uid].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Latest story per user → for StoryBar
    const latestPerUser = Object.values(grouped).map((arr) => arr[0]);
    return latestPerUser;
  },

  /** Legacy fetch – still usable if needed */
  async fetchStories({ limit = 200, offset = 0 } = {}) {
    const res = await this.fetchStoriesGrouped({ limit, offset });
    return res.latestPerUser;
  },

  /** Fetch all grouped stories (not filtered) */
  async fetchStoriesGrouped({ limit = 200, offset = 0 } = {}) {
    try {
      const queries = [Query.limit(limit), Query.offset(offset), Query.orderDesc("$createdAt")];

      const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, queries);

      const docs = response.documents || [];

      const mapped = docs.map(mapDocToStory);

      const visibleStories = mapped.filter((story) => {
        if (story.type === "video") return READY_STATUSES.has(story.status);
        return true;
      });

      const grouped = visibleStories.reduce((acc, s) => {
        const uid = s.user.id;
        if (!uid) return acc;
        if (!acc[uid]) acc[uid] = [];
        acc[uid].push(s);
        return acc;
      }, {});

      for (const uid of Object.keys(grouped)) {
        grouped[uid].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      const latestPerUser = Object.values(grouped)
        .map((arr) => arr[0])
        .filter(Boolean);

      this.lastGrouped = grouped;

      return { latestPerUser, grouped };
    } catch (error) {
      console.error("StoryService.fetchStoriesGrouped error:", error);
      return { latestPerUser: [], grouped: {} };
    }
  },

  /** Fetch all stories of a specific user */
  async fetchUserStories(uploaderId) {
    if (!uploaderId) throw new Error("User ID is required");
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, [
        Query.equal("uploader", uploaderId),
        Query.orderDesc("$createdAt"),
      ]);

      const docs = response.documents || [];

      const mapped = docs.map(mapDocToStory);

      this.lastGrouped = { ...this.lastGrouped, [uploaderId]: mapped };

      return mapped;
    } catch (err) {
      console.error("fetchUserStories error:", err);
      return [];
    }
  },

  /**
   * Fetch stories only for the viewer:
   * - viewer's own stories
   * - stories from users the viewer follows
   * grouped by userId
   */
  async fetchViewerStories({ viewerId, limit = 200, offset = 0 }) {
    if (!viewerId) throw new Error("viewerId is required");

    try {
      const followingRes = await FollowService.getFollowing({
        userId: viewerId,
        limit: undefined, // fetch all
      });

      const followingDocs = Array.isArray(followingRes.documents) ? followingRes.documents : followingRes;

      const followingIds = followingDocs.map((f) => f.followingId.$id);

      const uploaderIds = [viewerId, ...followingIds];

      const queries = [Query.limit(limit), Query.offset(offset), Query.orderDesc("$createdAt"), Query.equal("uploader", uploaderIds)];

      const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, queries);

      const docs = response.documents || [];

      const mapped = docs.map(mapDocToStory);

      const visibleStories = mapped.filter((story) => {
        if (story.type === "video") return READY_STATUSES.has(story.status);
        return true;
      });

      const grouped = visibleStories.reduce((acc, s) => {
        const uid = s.user.id;
        if (!uid) return acc;
        if (!acc[uid]) acc[uid] = [];
        acc[uid].push(s);
        return acc;
      }, {});

      for (const uid of Object.keys(grouped)) {
        grouped[uid].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      return grouped;
    } catch (err) {
      console.error("StoryService.fetchViewerStories error:", err);
      return {};
    }
  },

  /**
   * Create story (image or video)
   */
  async createStory({ userId, fileUri, fileType, thumbnail = null, overlayTexts = [], duration = null, musicId = null, onProgress, signal }) {
    try {
      if (!userId || !fileUri || !fileType) throw new Error("Missing required parameters");

      const fileName = `${userId}_${Date.now()}.${fileType === "image" ? "jpg" : "mp4"}`;
      let mediaUrl;
      let uploadedThumbnail = thumbnail;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // -----------------------------
      // IMAGE STORY (direct upload)
      // -----------------------------
      if (fileType === "image") {
        mediaUrl = await BunnyService.uploadImageToBunnyStorage(fileUri, fileName, { onProgress, signal });

        if (mediaUrl && !mediaUrl.startsWith("http")) mediaUrl = `https://${mediaUrl}`;
        if (uploadedThumbnail && !uploadedThumbnail.startsWith("http")) uploadedThumbnail = `https://${uploadedThumbnail}`;

        const story = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, ID.unique(), {
          uploader: userId,
          mediaUrl,
          thumbnail: uploadedThumbnail || mediaUrl,
          type: "image",
          duration,
          expiresAt,
          musicId,
          status: "ready",
        });

        await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesStatsCollectionId, ID.unique(), {
          storyId: story.$id,
          totalLikes: 0,
          totalViews: 0,
        });

        onProgress?.(100);

        return {
          id: story.$id,
          type: "image",
          mediaUrl,
          thumbnail: uploadedThumbnail || mediaUrl,
          user: { id: userId },
          storyStats: { storyId: story.$id, totalLikes: 0, totalViews: 0 },
          createdAt: story.$createdAt,
          status: "ready",
        };
      }

      // -----------------------------
      // VIDEO STORY WITH TEXT OVERLAY (Appwrite Function)
      // -----------------------------
      if (overlayTexts.length) {
        onProgress?.(5);
        const fileBase64 = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        onProgress?.(10);

        const payload = {
          userId,
          fileBase64,
          overlayTexts,
          duration,
        };

        const resp = await fetch(APPWRITE_FUNCTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || "Function failed");

        const status = json.status || "processing";

        if (json.storyId) {
          try {
            await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, json.storyId, { status });
          } catch (updateErr) {
            console.warn("Failed to update story status after overlay function:", updateErr?.message || updateErr);
          }
        }

        onProgress?.(100);

        return {
          id: json.storyId,
          type: "video",
          mediaUrl: json.mediaUrl,
          thumbnail: json.thumbnail,
          user: { id: userId },
          createdAt: json.createdAt,
          status,
        };
      }

      // -----------------------------
      // VIDEO STORY WITHOUT OVERLAY
      // -----------------------------
      const { url, videoId, thumbnail: vidThumb } = await BunnyService.uploadVideoToBunnyStream(fileUri, fileName, { onProgress, signal });

      mediaUrl = url.startsWith("http") ? url : `https://${url}`;
      uploadedThumbnail = vidThumb.startsWith("http") ? vidThumb : `https://${vidThumb}`;

      const story = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, ID.unique(), {
        uploader: userId,
        mediaUrl,
        thumbnail: uploadedThumbnail,
        type: "video",
        duration,
        expiresAt,
        musicId,
        status: "processing",
      });

      await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesStatsCollectionId, ID.unique(), {
        storyId: story.$id,
        totalLikes: 0,
        totalViews: 0,
      });

      onProgress?.(100);

      return {
        id: story.$id,
        type: "video",
        mediaUrl,
        thumbnail: uploadedThumbnail,
        user: { id: userId },
        storyStats: { storyId: story.$id, totalLikes: 0, totalViews: 0 },
        createdAt: story.$createdAt,
        status: "processing",
      };
    } catch (error) {
      console.error("Error creating story:", error.response?.data || error.message);
      throw error;
    }
  },

  /** Delete story */
  async deleteStory(storyId) {
    return await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.storiesCollectionId, storyId);
  },

  // STAT FUNCTIONS
  async getStoryStats(storyId) {
    try {
      const { documents } = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesStatsCollectionId, [
        Query.equal("storyId", storyId),
      ]);
      return documents[0] || null;
    } catch (err) {
      console.log("Error fetching stats:", err);
      return null;
    }
  },

  async checkIfUserViewed(storyId, userId) {
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesViewsCollectionId, [
      Query.equal("storyId", storyId),
      Query.equal("viewerId", userId),
    ]);
    return res.documents.length > 0;
  },

  async checkIfUserLiked(storyId, userId) {
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storiesLikesCollectionId, [
      Query.equal("storyId", storyId),
      Query.equal("userId", userId),
    ]);
    return res.documents[0] || null;
  },

  async createView(storyId, userId) {
    try {
      return await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesViewsCollectionId, ID.unique(), {
        storyId,
        viewerId: userId,
      });
    } catch (err) {
      console.log("view error", err);
    }
  },

  async likeStory(storyId, userId) {
    return await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.storiesLikesCollectionId, ID.unique(), { storyId, userId });
  },

  async unlikeStory(likeDocId) {
    return await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.storiesLikesCollectionId, likeDocId);
  },

  async fetchMusic(musicId) {
    if (!musicId) return null;
    const doc = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.storyMusicCollectionId, musicId);
    return doc;
  },

  /** Delete Bunny file */
  async deleteStoryMedia(story) {
    try {
      if (!story) return;

      if (story.type === "image") {
        const fileName = story.mediaUrl.split("/").pop();
        await BunnyService.deleteImageFromStorage(fileName);
        return;
      }

      if (story.type === "video") {
        const parts = story.mediaUrl.split("/");
        const videoId = parts[parts.length - 2];
        await BunnyService.deleteVideoFromStream(videoId);
      }
    } catch (err) {
      console.log("Error deleting Bunny media:", err);
    }
  },
};
