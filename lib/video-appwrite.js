import axios from "axios";
import * as FileSystem from "expo-file-system";
import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { appwriteConfig, databases } from "./appwrite";
import { createTtlCache } from "./utils/createTtlCache";
import logger from "./utils/logger";

// Single-video read-through cache. Hits constantly from notifications
// hydration, post-resource resolution, video-comment-modal opens, and any
// "fetch the video this notification points to" path. Same video shows up
// many times in a long session.
const VIDEO_CACHE = createTtlCache({ ttlMs: 30 * 1000, maxEntries: 300 });

export const invalidateVideoCache = (videoId) => {
  if (videoId) VIDEO_CACHE.delete(videoId);
};

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
    if (!id) return null;
    const cached = VIDEO_CACHE.get(id);
    if (cached) return cached;
    const doc = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id);
    if (doc) VIDEO_CACHE.set(id, doc);
    return doc;
  }

  async searchVideo({ uri }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, [Query.equal("uri", uri)]);
  }

  async uploadVideoToBunnyStream(videoID, file, { onProgress, signal } = {}) {
    try {
      if (!file?.uri) {
        logger.error("VideosService", "uploadVideoToBunnyStream missing file uri");
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
        logger.error("VideosService", "Bunny createVideo failed", new Error(JSON.stringify(createJson)));
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
          logger.info("VideosService", "Upload cancelled by user");
          return { status: false, cancelled: true, videoId };
        }
        logger.error("VideosService", "Bunny upload task failed", err);
        return { status: false, videoId };
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
      }

      if (!uploadResult || uploadResult.status >= 400) {
        logger.error(
          "VideosService",
          `Bunny upload returned status=${uploadResult?.status}`,
          new Error(uploadResult?.body || `status=${uploadResult?.status}`),
        );
        return { status: false, videoId };
      }

      return {
        videoId,
        status: true,
      };
    } catch (error) {
      logger.error("VideosService", "uploadVideoToBunnyStream crashed", error);
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

      // Dual-write the view to Supabase video_views. Fire-and-forget —
      // explicit `void` so static analysis doesn't flag the floating
      // promise. The function catches all errors internally so it can
      // never reject; we just don't need to await the write.
      void recordVideoViewSupabase({ videoId, viewerId: userId });
    } catch (err) {
      console.error("videoView error:", err?.message || err);
    }
  }

  // Polls Bunny for a video's encoding status. Used by video-player.jsx
  // to flip the UI between processing / ready / error states.
  //
  // Library handling: Selebox now spans two Bunny Stream libraries —
  // the legacy `selebox-videos-stream` (~4,800 migrated videos) and
  // `selebox-web` (~18 web-uploaded videos). The DB stores
  // `bunny_library_id` per video so we know which library to poll;
  // callers should pass it through. If a video doesn't carry one (older
  // mobile-uploaded rows), we fall back to the secret-configured
  // default library.
  //
  // 404 handling: If the GUID isn't in the polled library at all, we
  // silently return null so the UI just doesn't show a processing
  // banner. This used to log "checkVideoProcessingStatus failed: 404"
  // every render — pure noise that isn't actionable.
  async checkVideoStatus({ videoId, libraryId } = {}) {
    if (!videoId) return null;
    const lib = libraryId || secrets.BUNNY_STREAM_VIDEOS_LIBRARY_ID;
    try {
      const response = await axios.get(`https://video.bunnycdn.com/library/${lib}/videos/${videoId}`, {
        headers: {
          AccessKey: secrets.BUNNY_STREAM_VIDEOS_API_KEY,
          "Content-Type": "application/json",
        },
      });
      return response.data;
    } catch (err) {
      // 404 = video lives in a different library (or doesn't exist
      // anymore). 401 = the API key in BUNNY_STREAM_VIDEOS_API_KEY
      // doesn't authorize for the polled library — Selebox spans two
      // Stream libraries and we currently use one key, so any video
      // in the OTHER library reports 401 here. Both are non-actionable
      // "no info" signals; treat the same and stay quiet.
      if (err?.response?.status === 404) return null;
      if (err?.response?.status === 401) return null;
      console.warn("checkVideoStatus failed:", err.message);
      return null;
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
  const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, ID, {
    title: title,
    description: description,
    thumbnail: thumbnail,
    uri: uri,
    videoUrl: videoUrl,
    uploader: uploader,
    status,
    ...props,
  });

  // ─── Dual-write video metadata to Supabase ─────────────────────────
  // Web's videos tab reads from public.videos. Without this, every
  // mobile-uploaded video stays invisible to web users. Mirror the
  // pattern from comments dual-write: best-effort, never block the
  // Appwrite path. legacy_appwrite_id preserves the linkage so likes /
  // views / comments dual-writes can find the Supabase counterpart by
  // hex lookup.
  //
  // Field mapping mirrors web's INSERT in /Selebox/js/app.js (~line 5259):
  //   bunny_video_id, bunny_library_id, video_url, thumbnail_url, title,
  //   description, tags, category, uploader_id, status, scheduled_publish_at,
  //   is_monetized.
  //
  // We don't pass bunny_video_id/library_id because those aren't
  // captured in the legacy mobile flow's argument set — they live in
  // the URL. A future optimization could parse them out of `uri`.
  try {
    await dualWriteVideoToSupabase({
      appwriteDocId: ID,
      uploaderAppwriteId: uploader,
      title,
      description,
      videoUrl,
      thumbnailUrl: thumbnail,
      status,
      ...props,
    });
  } catch (sbErr) {
    console.log("[video-appwrite] createNewVideo Supabase dual-write skipped:", sbErr?.message);
  }

  return created;
};

// Helper: mirror an Appwrite videos row into public.videos. Idempotent
// via ON CONFLICT on legacy_appwrite_id. Returns the new Supabase UUID
// (also caches the mapping so likes/views/comments dual-writes can
// resolve without a separate lookup).
const dualWriteVideoToSupabase = async ({
  appwriteDocId,
  uploaderAppwriteId,
  title,
  description,
  videoUrl,
  thumbnailUrl,
  status,
  tags,
  category,
  isMonetized,
  scheduledPublishAt,
  duration,
}) => {
  const uploaderUuid = await resolveProfileIdToSupabase(uploaderAppwriteId);
  if (!uploaderUuid) return null;
  const sb = await getSupabaseClient();
  const { data, error } = await sb
    .from("videos")
    .upsert(
      {
        uploader_id: uploaderUuid,
        title: title || null,
        description: description || null,
        video_url: videoUrl || null,
        thumbnail_url: thumbnailUrl || null,
        // Status: lowercase to match web's enum (videos table uses
        // lowercase 'processing'/'ready'/'failed'). Mobile usually passes
        // lowercase already, but normalize defensively.
        status: typeof status === "string" ? status.toLowerCase() : "processing",
        tags: Array.isArray(tags) ? tags : null,
        category: category || null,
        is_monetized: !!isMonetized,
        scheduled_publish_at: scheduledPublishAt || null,
        duration: typeof duration === "number" ? duration : null,
        legacy_appwrite_id: appwriteDocId,
      },
      { onConflict: "legacy_appwrite_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (error) {
    console.log("[video-appwrite] dualWriteVideoToSupabase error:", error.message);
    return null;
  }
  if (appwriteDocId && data?.id) _videoIdCache.set(appwriteDocId, data.id);
  return data?.id || null;
};

export const updateVideoDocument = async ({ id, data }) => {
  try {
    const res = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id, data);
    invalidateVideoCache(id);
    // Dual-write to Supabase. Only mirror columns that have a meaningful
    // counterpart on the videos table — we don't trample trigger-managed
    // counters (likes_count, views_count, comments_count) or columns web
    // owns independently.
    try {
      const update = {};
      if ("title" in data) update.title = data.title || null;
      if ("description" in data) update.description = data.description || null;
      if ("thumbnail" in data) update.thumbnail_url = data.thumbnail || null;
      if ("videoUrl" in data) update.video_url = data.videoUrl || null;
      if ("status" in data) update.status = (data.status || "ready").toLowerCase();
      if ("tags" in data) update.tags = Array.isArray(data.tags) ? data.tags : null;
      if (Object.keys(update).length > 0) {
        const sb = await getSupabaseClient();
        const { error } = await sb.from("videos").update(update).eq("legacy_appwrite_id", id);
        if (error) console.log("[video-appwrite] updateVideoDocument dual-write error:", error.message);
      }
    } catch (sbErr) {
      console.log("[video-appwrite] updateVideoDocument Supabase dual-write skipped:", sbErr?.message);
    }
    return res;
  } catch (err) {
    logger.error("video", "updateVideoDocument failed", err);
    throw err;
  }
};

export const deleteVideoDocument = async ({ id }) => {
  try {
    const res = await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, id);
    invalidateVideoCache(id);
    // Mirror the delete. ON DELETE CASCADE on FKs (video_likes, etc.)
    // cleans up children automatically — same semantics as web's
    // deleteVideo. The mobile-side _videoIdCache entry is stale after
    // this, so drop it.
    try {
      const sb = await getSupabaseClient();
      const { error } = await sb.from("videos").delete().eq("legacy_appwrite_id", id);
      if (error) console.log("[video-appwrite] deleteVideoDocument dual-write error:", error.message);
      _videoIdCache.delete(id);
    } catch (sbErr) {
      console.log("[video-appwrite] deleteVideoDocument Supabase dual-write skipped:", sbErr?.message);
    }
    return res;
  } catch (err) {
    logger.error("video", "deleteVideoDocument failed", err);
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
  const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, ID.unique(), {
    video: videoId,
    likeOwner,
  });

  // Dual-write to Supabase video_likes. Composite PK on (video_id, user_id)
  // makes this idempotent — re-likes are a no-op via upsert
  // ignoreDuplicates. Resolves both ids via legacy_appwrite_id.
  try {
    const [videoUuid, userUuid] = await Promise.all([
      resolveVideoIdToSupabase(videoId),
      resolveProfileIdToSupabase(likeOwner),
    ]);
    if (videoUuid && userUuid) {
      const sb = await getSupabaseClient();
      const { error } = await sb
        .from("video_likes")
        .upsert(
          { video_id: videoUuid, user_id: userUuid },
          { onConflict: "video_id,user_id", ignoreDuplicates: true },
        );
      if (error) console.log("[video-appwrite] createVideoLike dual-write error:", error.message);
    }
  } catch (sbErr) {
    console.log("[video-appwrite] createVideoLike Supabase dual-write skipped:", sbErr?.message);
  }

  return created;
};

export const deleteVideoLike = async ({ videoLikeId, videoId, likeOwner } = {}) => {
  const deleted = await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.videosLikesCollectionId, videoLikeId);

  // Dual-write delete. Caller may not always have videoId/likeOwner —
  // we accept them as optional params. Skipping the Supabase delete is
  // fine if either is missing (next refresh on web reads from Supabase
  // and won't show this user's stale like, since the Appwrite-side
  // delete already happened and the row will be re-created via like
  // toggle next time).
  try {
    if (videoId && likeOwner) {
      const [videoUuid, userUuid] = await Promise.all([
        resolveVideoIdToSupabase(videoId),
        resolveProfileIdToSupabase(likeOwner),
      ]);
      if (videoUuid && userUuid) {
        const sb = await getSupabaseClient();
        const { error } = await sb
          .from("video_likes")
          .delete()
          .eq("video_id", videoUuid)
          .eq("user_id", userUuid);
        if (error) console.log("[video-appwrite] deleteVideoLike dual-write error:", error.message);
      }
    }
  } catch (sbErr) {
    console.log("[video-appwrite] deleteVideoLike Supabase dual-write skipped:", sbErr?.message);
  }

  return deleted;
};

// Records a video view — INTENTIONAL NO-OP.
//
// Original implementation tried to upsert into public.video_views, but
// audit revealed that table doesn't exist in any Selebox migration. Web
// tracks video views by incrementing videos.views_count via Bunny.net
// analytics (out-of-band) and possibly a server-side trigger; there's
// no per-user view table to mirror into.
//
// Mobile keeps recording detailed per-user views in the Appwrite
// videoMetricsCollection (its existing path is unchanged). Cross-platform
// view-count parity is web's responsibility via its own counter trigger,
// not something the dual-write can solve from the client.
//
// Kept as a no-op (rather than removed) so call sites that already
// await it don't have to change. Logs once on the first call so any
// surviving caller is visible in dev builds.
let _viewWarnLogged = false;
export const recordVideoViewSupabase = async () => {
  if (!_viewWarnLogged) {
    console.log("[video-appwrite] recordVideoViewSupabase: no-op (no video_views table on Supabase)");
    _viewWarnLogged = true;
  }
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

// ─────────────────────────────────────────────────────────────────────────
// Supabase dual-write helper for video comments + replies
// ─────────────────────────────────────────────────────────────────────────
// Lazy-loaded once and cached. Same pattern as the notif dual-write to
// avoid module-load cycles between video-appwrite ↔ supabase libs.
let _supabaseClient = null;
const getSupabaseClient = async () => {
  if (_supabaseClient) return _supabaseClient;
  const mod = await import("./supabase");
  _supabaseClient = mod.default;
  return _supabaseClient;
};

// In-session cache for hex → UUID lookups. Same pattern as the safety
// resolver. Mappings are immutable so cache lifetime = bundle lifetime.
const _videoIdCache = new Map();
const _profileIdCache = new Map();
const _commentIdCache = new Map(); // appwrite-doc-id → supabase-uuid for parent lookup

const _UUID_RE_VIDEO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveVideoIdToSupabase = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_VIDEO.test(rawId)) return rawId;
  if (_videoIdCache.has(rawId)) return _videoIdCache.get(rawId);
  const sb = await getSupabaseClient();
  const { data, error } = await sb.from("videos").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[video-appwrite] resolveVideoIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _videoIdCache.set(rawId, resolved);
  return resolved;
};

const resolveProfileIdToSupabase = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_VIDEO.test(rawId)) return rawId;
  if (_profileIdCache.has(rawId)) return _profileIdCache.get(rawId);
  const sb = await getSupabaseClient();
  const { data, error } = await sb.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[video-appwrite] resolveProfileIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _profileIdCache.set(rawId, resolved);
  return resolved;
};

const resolveCommentIdToSupabase = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_VIDEO.test(rawId)) return rawId;
  if (_commentIdCache.has(rawId)) return _commentIdCache.get(rawId);
  const sb = await getSupabaseClient();
  const { data, error } = await sb.from("comments").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[video-appwrite] resolveCommentIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _commentIdCache.set(rawId, resolved);
  return resolved;
};

// Insert a row into public.comments mirroring an Appwrite video comment.
// Returns the new Supabase UUID (also caches the appwrite→uuid mapping
// so subsequent replies can find this row as their parent without a
// roundtrip).
const dualWriteVideoCommentToSupabase = async ({
  appwriteDocId,
  videoAppwriteId,
  ownerAppwriteId,
  body,
  parentSupabaseId,
}) => {
  const [videoUuid, ownerUuid] = await Promise.all([
    resolveVideoIdToSupabase(videoAppwriteId),
    resolveProfileIdToSupabase(ownerAppwriteId),
  ]);
  if (!videoUuid || !ownerUuid) {
    // The video or author isn't on Supabase yet (USE_SUPABASE_VIDEOS=false
    // means new mobile-uploaded videos go to Appwrite only). Skip the
    // Supabase write — backfill (P3) handles historical rows once both
    // sides are migrated. Still returns null so callers can detect.
    return null;
  }
  const sb = await getSupabaseClient();
  const { data, error } = await sb
    .from("comments")
    .insert({
      user_id: ownerUuid,
      video_id: videoUuid,
      parent_id: parentSupabaseId || null,
      body: (body || "").trim(),
      legacy_appwrite_id: appwriteDocId || null,
    })
    .select("id")
    .single();
  if (error) {
    console.log("[video-appwrite] dualWriteVideoCommentToSupabase insert error:", error.message);
    return null;
  }
  // Cache the mapping for future reply resolves in this session.
  if (appwriteDocId && data?.id) _commentIdCache.set(appwriteDocId, data.id);
  return data?.id || null;
};

export const createVideoComment = async ({ videoId, comment, commentOwner }) => {
  const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videosCommentsCollectionId, ID.unique(), {
    video: videoId,
    comment,
    commentOwner,
  });

  // ─── Dual-write to Supabase ────────────────────────────────────────
  // Web reads video comments from public.comments (with video_id set).
  // Without this dual-write, mobile-authored video comments are
  // invisible to web. Same belt-and-suspenders pattern we used for
  // notifications + blocks/hides.
  //
  // Resolution chain:
  //   videoId (Appwrite hex) → public.videos.legacy_appwrite_id → UUID
  //   commentOwner (hex)     → public.profiles.legacy_appwrite_id → UUID
  //
  // Either failing → skip the Supabase write but keep the Appwrite row
  // (best-effort). The P3 backfill script catches anything we miss.
  // legacy_appwrite_id on the new Supabase row preserves the linkage
  // so future replies can find their parent.
  try {
    await dualWriteVideoCommentToSupabase({
      appwriteDocId: created?.$id,
      videoAppwriteId: videoId,
      ownerAppwriteId: commentOwner,
      body: comment,
      parentSupabaseId: null,
    });
  } catch (sbErr) {
    console.log("[video-appwrite] createVideoComment Supabase dual-write skipped:", sbErr?.message);
  }

  return created;
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
  let createdReply = null;

  outer: for (const relationKey of VIDEO_COMMENT_PARENT_KEYS) {
    for (const payload of [basePayload, fallbackPayload]) {
      try {
        createdReply = await databases.createDocument(appwriteConfig.databaseId, repliesCollectionId, ID.unique(), {
          ...payload,
          [relationKey]: parentCommentId,
        });
        break outer;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!createdReply) {
    throw lastError || new Error("createVideoReplyComment failed");
  }

  // ─── Dual-write reply to Supabase ────────────────────────────────────
  // Resolve the parent's Supabase UUID via legacy_appwrite_id. If the
  // parent was written to Appwrite ONLY (before dual-write existed) and
  // hasn't been backfilled yet, we won't find it — skip this reply's
  // Supabase write rather than orphan it.
  try {
    const parentSupabaseId = await resolveCommentIdToSupabase(parentCommentId);
    if (parentSupabaseId) {
      await dualWriteVideoCommentToSupabase({
        appwriteDocId: createdReply?.$id,
        videoAppwriteId: videoId,
        ownerAppwriteId: commentOwner,
        body: trimmedComment,
        parentSupabaseId,
      });
    } else {
      // Parent has no Supabase counterpart yet. The P3 backfill will
      // create one for the parent first, then this reply can be
      // backfilled too on a subsequent run.
      console.log("[video-appwrite] reply Supabase dual-write skipped: parent not in Supabase yet");
    }
  } catch (sbErr) {
    console.log("[video-appwrite] createVideoReplyComment Supabase dual-write skipped:", sbErr?.message);
  }

  return createdReply;
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
