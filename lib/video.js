// lib/video.js — VideosService + helpers dispatcher
//
// Routes the VideosService class between Supabase
// (lib/video-supabase.js) and Appwrite (lib/video-appwrite.js) based
// on the USE_SUPABASE_VIDEOS feature flag. Pure helpers (initialVideoForm,
// resolve*ParentId, map*ByParentId etc.) re-export unconditionally
// because they're backend-agnostic transforms.
//
// Pre-flight before flipping USE_SUPABASE_VIDEOS=true:
//   1. Verify Supabase has the expected tables: videos, video_likes,
//      video_views, video_comments, video_comment_likes (matching the
//      column names in lib/video-supabase.js — uploader_id, status,
//      tags[], etc.).
//   2. Verify legacy_appwrite_id column on `videos` so historical
//      Appwrite-shaped IDs still resolve.
//   3. Optional: add increment_video_views RPC for atomic view count
//      bumps (the JS skips silently if the RPC doesn't exist).
//   4. Test on dev build by flipping the flag locally.
//
// Bunny CDN methods (uploadVideoToBunnyStream, deleteVideoFromBunnyStream,
// uploadVideo, checkVideoStatus) live on the Appwrite version — the
// Supabase wrapper proxies through to those, so Bunny integration is
// unchanged regardless of flag.

import { USE_SUPABASE_VIDEOS } from "./feature-flags";
import { VideosServiceSupabase } from "./video-supabase";
import * as supabaseImpl from "./video-supabase";
import * as appwriteImpl from "./video-appwrite";

// Active service implementation — class chosen by flag. Consumers do
// `new VideosService()` and get whichever backend is wired.
export const VideosService = USE_SUPABASE_VIDEOS
  ? VideosServiceSupabase
  : appwriteImpl.VideosService;

// Top-level helper functions — same dispatch pattern. Each function is
// exported from both files; we just pick the right module's export.
const impl = USE_SUPABASE_VIDEOS ? supabaseImpl : appwriteImpl;

export const invalidateVideoCache = impl.invalidateVideoCache;
export const initialVideoForm = impl.initialVideoForm;
export const createNewVideo = impl.createNewVideo;
export const updateVideoDocument = impl.updateVideoDocument;
export const deleteVideoDocument = impl.deleteVideoDocument;
export const createVideoMetric = impl.createVideoMetric;
export const createVideoLikes = impl.createVideoLikes;
export const getVideoLikeByOwner = impl.getVideoLikeByOwner;
export const createVideoLike = impl.createVideoLike;
export const deleteVideoLike = impl.deleteVideoLike;
export const updateVideo = impl.updateVideo;
export const incrementVideoLikes = impl.incrementVideoLikes;
export const createVideoComment = impl.createVideoComment;

// Pure helpers (backend-agnostic) — always from the Appwrite file
// since they're string-transform utilities, not DB queries.
export const resolveVideoCommentParentId = appwriteImpl.resolveVideoCommentParentId;
export const mapVideoRepliesByParentId = appwriteImpl.mapVideoRepliesByParentId;
export const resolveVideoCommentLikeId = appwriteImpl.resolveVideoCommentLikeId;
export const mapVideoCommentLikesByCommentId = appwriteImpl.mapVideoCommentLikesByCommentId;
export const fetchVideoCommentLikesByCommentIds = appwriteImpl.fetchVideoCommentLikesByCommentIds;
export const getVideoCommentLikeByOwner = appwriteImpl.getVideoCommentLikeByOwner;
