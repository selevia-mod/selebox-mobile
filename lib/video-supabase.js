// Supabase-flavored VideosService — drop-in replacement for the video
// metadata side of lib/video.js during the Appwrite → Supabase migration.
//
// What's covered here:
//   • Read paths: fetchVideos, getVideo, searchVideo
//   • Write paths: createNewVideo, updateVideoDocument, deleteVideoDocument
//   • Engagement: viewVideo, like/unlike video, like counts, comments
//
// What is NOT in this file (intentional):
//   • Bunny CDN upload/delete (uploadVideoToBunnyStream, etc.) — those
//     stay in the Appwrite version because they're pure CDN calls and
//     don't depend on the metadata backend.
//   • Video unlocks / paywall — already handled by lib/wallet-supabase.js
//     (unlockVideoThreshold, getPaidThroughSeconds).
//   • Resource hydration for notifications — Phase 2 of notif migration.
//
// Schema assumed (Supabase):
//   videos             — id, uploader_id, title, description, video_url,
//                        thumbnail_url, status, tags[], duration,
//                        likes_count, views_count, comments_count,
//                        created_at, legacy_appwrite_id
//   video_likes        — video_id, user_id, created_at (composite PK)
//   video_views        — video_id, viewer_id, viewed_at (composite PK)
//   video_comments     — id, video_id, user_id, comment, parent_id,
//                        created_at
//   video_comment_likes — comment_id, user_id, created_at
//
// If your Supabase schema names differ (e.g., `creator_id` instead of
// `uploader_id`), adjust the column names in the queries below — the
// API surface stays identical.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";
import { createTtlCache } from "./utils/createTtlCache";

// Local TTL cache, matching the legacy lib/video.js pattern (which
// defines VIDEO_CACHE inline rather than in a separate caches/ file).
// 30s TTL — long enough to dedupe back-to-back reads in a session,
// short enough that admin updates show fresh on the next render.
const VIDEO_CACHE = createTtlCache({ ttlMs: 30 * 1000, maxEntries: 300 });

// Exported invalidator — same shape as the legacy version. The
// dispatcher in lib/video.js picks this or the legacy one based on
// USE_SUPABASE_VIDEOS, so consumers calling `invalidateVideoCache(id)`
// always hit the cache that matches the active backend.
export const invalidateVideoCache = (videoId) => {
  if (videoId) VIDEO_CACHE.delete(videoId);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// resolveVideoUuid — accepts either a Supabase UUID or a legacy Appwrite
// hex ID (20 chars) and returns the canonical UUID. Migrated videos still
// surface their hex ID through `video.$id` (the Appwrite-shape alias on
// mapRowToVideo), and consumer screens — like VideoStatsProvider — pass
// that ID straight to engagement queries. Without this resolver, those
// queries hit Postgres with a hex string against a UUID column and we get
// `invalid input syntax for type uuid`. Returns null when nothing resolves
// so callers can short-circuit (rather than throw at the DB layer).
const VIDEO_UUID_CACHE = new Map();
const resolveVideoUuid = async (videoId) => {
  if (!videoId) return null;
  if (UUID_RE.test(videoId)) return videoId;
  const cached = VIDEO_UUID_CACHE.get(videoId);
  if (cached) return cached;
  const { data, error } = await supabase
    .from("videos")
    .select("id")
    .eq("legacy_appwrite_id", videoId)
    .maybeSingle();
  if (error || !data?.id) return null;
  VIDEO_UUID_CACHE.set(videoId, data.id);
  return data.id;
};

// Map a Supabase videos row + uploader profile into the Appwrite-shaped
// document the rest of the app expects ($id, uploader: { $id, username,
// avatar }, etc.). Mirrors mapDocToVideo in lib/video.js.
const mapRowToVideo = (row) => {
  if (!row) return null;
  const uploader = row.profiles || row.uploader || {};
  const likes = row.likes_count ?? 0;
  const views = row.views_count ?? 0;
  const comments = row.comments_count ?? 0;
  return {
    // Native Supabase columns
    id: row.id,
    title: row.title,
    description: row.description,
    video_url: row.video_url,
    thumbnail_url: row.thumbnail_url,
    status: row.status,
    tags: row.tags || [],
    duration: row.duration,
    likes_count: likes,
    views_count: views,
    comments_count: comments,
    created_at: row.created_at,
    legacy_appwrite_id: row.legacy_appwrite_id,
    // Bunny library_id — videos can live in different Stream libraries
    // (selebox-videos-stream vs selebox-web). Surface it so callers
    // (e.g. checkVideoStatus polling) hit the right library.
    bunny_library_id: row.bunny_library_id || null,
    bunny_video_id: row.bunny_video_id || null,
    // Monetization. The mobile player reads `video?.monetization_enabled`
    // (legacy Appwrite column name) — alias it from the canonical
    // Supabase column `is_monetized` so the unlock-modal gate
    // (monetizationActive in video-player.jsx) actually fires on paid
    // videos. Per-video coin/star overrides land here too; downstream
    // hooks (useAutoUnlock) fall back to globalSettings when these
    // are null/undefined.
    is_monetized: !!row.is_monetized,
    monetization_enabled: !!row.is_monetized,
    unlock_cost_coins: row.unlock_cost_coins ?? null,
    unlock_cost_stars: row.unlock_cost_stars ?? null,

    // Appwrite-shaped legacy aliases
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    title_: row.title,
    videoUrl: row.video_url,
    thumbnail: row.thumbnail_url,
    // Selebox-internal route URI — every consumer that opens a video
    // detail screen reads `video.uri`, then strips the `/videos/`
    // prefix to recover the ID (e.g. video-player.jsx:672, line 487 of
    // VideoCommentModal.jsx). The Appwrite mapper always emitted this
    // alongside the Bunny URL; without it, opening comments crashes
    // with "Cannot read property 'replace' of undefined".
    uri: `/videos/${row.legacy_appwrite_id || row.id}`,
    // Engagement aliases — Appwrite-era code reads view counts via
    // videoStats.totalViews / videos.views / videos.totalViews (e.g.,
    // utils/audiobookVideoSections.getVideoViewCount). Without these
    // aliases the "Most People Want" section sees every video at 0
    // views and the >100-view threshold filters them all out.
    views: views,
    totalViews: views,
    totalLikes: likes,
    totalComments: comments,
    videoStats: {
      totalViews: views,
      totalLikes: likes,
      totalComments: comments,
      commentsCount: comments,
      commentCount: comments,
      videoComments: comments,
    },
    uploader: {
      $id: uploader.legacy_appwrite_id || uploader.id,
      id: uploader.id,
      username: uploader.username,
      avatar: uploader.avatar_url,
      avatar_url: uploader.avatar_url,
    },
  };
};

// Denormalized engagement counts (likes_count / views_count /
// comments_count) are kept current by triggers installed in
// migration_videos_engagement_counts.sql — the same pattern the books
// table uses. If you ever see "column videos.likes_count does not exist"
// (Postgres 42703), that migration needs to be deployed.
//
// Monetization columns: is_monetized + unlock_cost_coins/stars come
// from the same schema the web admin writes to (see
// /Selebox/js/app.js:4567 — the SELECT for the videos tab includes
// these). Without surfacing them here, the mobile player's
// `monetizationActive = video?.monetization_enabled && !isUploader`
// check is always falsy, the unlock modal never fires, and paid
// videos play for free.
const VIDEO_SELECT = `
  id, title, description, video_url, thumbnail_url, status, tags,
  duration, likes_count, views_count, comments_count, created_at,
  legacy_appwrite_id, uploader_id, bunny_library_id, bunny_video_id,
  is_monetized, unlock_cost_coins, unlock_cost_stars,
  profiles!videos_uploader_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

export class VideosServiceSupabase {
  // Paginated video list. Filters by uploader, category (tag), and
  // status. Returns Appwrite-shaped { documents, total } so existing
  // consumers (FlashList in app/(tabs)/videos.jsx, profile videos tab)
  // don't fork.
  async fetchVideos({ userId, lastId, category, limit = 20, status, offset }) {
    let q = supabase.from("videos").select(VIDEO_SELECT, { count: "exact" });

    if (userId) {
      const uploaderUuid = Array.isArray(userId)
        ? userId
        : [userId];
      // Resolve hex IDs to UUIDs via legacy_appwrite_id when needed.
      const resolved = await Promise.all(
        uploaderUuid.map((id) => (UUID_RE.test(id) ? id : resolveSupabaseUserId(id))),
      );
      const ids = resolved.filter(Boolean);
      if (ids.length > 0) q = q.in("uploader_id", ids);
    }

    if (category) q = q.contains("tags", [category]);

    if (status) {
      // Mobile call sites pass status: 'published' (Appwrite-era token).
      // The Supabase + web schema settled on 'ready' as the canonical
      // live state (verified: 3040 ready rows, 0 published rows). Bunny
      // CDN's processing webhook flips a video from 'processing' →
      // 'ready' on encode completion, and js/app.js (web) filters on
      // 'ready' everywhere. We translate 'published' → 'ready' here so
      // all 16 mobile call sites keep working without per-file edits;
      // new tokens (draft, processing, deleted, unpublished) pass
      // through unchanged.
      const resolvedStatus = status === "published" ? "ready" : status;
      q = q.eq("status", resolvedStatus);
    } else {
      q = q.neq("status", "deleted");
    }

    q = q.order("created_at", { ascending: false }).limit(limit);
    if (typeof offset === "number" && offset > 0) {
      q = q.range(offset, offset + limit - 1);
    }
    if (lastId) {
      // Cursor pagination — lastId is a Supabase UUID. We page strictly
      // backwards in time, so we use lt on created_at of the last row.
      // The caller would need to pass the created_at as the cursor, but
      // for compatibility with the Appwrite signature we accept the id
      // and look up its created_at first.
      const { data: cursorRow } = await supabase
        .from("videos")
        .select("created_at")
        .eq("id", lastId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }

    const { data, error, count } = await q;
    if (error) throw error;

    return {
      documents: (data || []).map(mapRowToVideo),
      total: count ?? data?.length ?? 0,
    };
  }

  async getVideo({ id }) {
    if (!id) return null;
    const cached = VIDEO_CACHE.get(id);
    if (cached) return cached;

    const isUuid = UUID_RE.test(id);
    const column = isUuid ? "id" : "legacy_appwrite_id";
    const { data, error } = await supabase
      .from("videos")
      .select(VIDEO_SELECT)
      .eq(column, id)
      .maybeSingle();
    if (error) throw error;
    const mapped = mapRowToVideo(data);
    if (mapped) VIDEO_CACHE.set(id, mapped);
    return mapped;
  }

  async searchVideo({ uri }) {
    if (!uri) return { documents: [] };
    const { data, error } = await supabase
      .from("videos")
      .select(VIDEO_SELECT)
      .eq("video_url", uri);
    if (error) throw error;
    return { documents: (data || []).map(mapRowToVideo) };
  }

  // Bunny upload paths — kept on the Appwrite-flavored implementation
  // because they're pure CDN calls. Re-exported here so the dispatcher
  // can find them when consumers expect them on VideosService.
  async uploadVideoToBunnyStream(...args) {
    const { VideosService: legacy } = await import("./video-appwrite");
    return new legacy().uploadVideoToBunnyStream(...args);
  }
  async deleteVideoFromBunnyStream(...args) {
    const { VideosService: legacy } = await import("./video-appwrite");
    return new legacy().deleteVideoFromBunnyStream(...args);
  }
  async deleteThumbnailFromBunnyStorage(...args) {
    const { VideosService: legacy } = await import("./video-appwrite");
    return new legacy().deleteThumbnailFromBunnyStorage(...args);
  }
  async uploadVideo(...args) {
    const { VideosService: legacy } = await import("./video-appwrite");
    return new legacy().uploadVideo(...args);
  }
  async checkVideoStatus(...args) {
    const { VideosService: legacy } = await import("./video-appwrite");
    return new legacy().checkVideoStatus(...args);
  }

  // viewVideo — increment views_count + insert a video_views row for
  // dedup. Composite PK (video_id, viewer_id) makes the view count
  // unique per viewer over the lifetime — matching the Appwrite
  // behavior.
  async viewVideo({ videoId, userId }) {
    if (!videoId || !userId) return null;
    const videoUuid = await resolveVideoUuid(videoId);
    if (!videoUuid) return null;
    const viewerUuid = await resolveSupabaseUserId(userId);
    if (!viewerUuid) return null;

    const { error: viewErr } = await supabase
      .from("video_views")
      .insert({ video_id: videoUuid, viewer_id: viewerUuid });
    // 23505 = unique violation = already viewed (no-op).
    if (viewErr && viewErr.code !== "23505") throw viewErr;

    // The trigger in migration_videos_engagement_counts.sql already bumps
    // videos.views_count on insert, so no follow-up RPC is needed.
    return { ok: true };
  }
}


// ─────────────────────────────────────────────────────────────────────────
// v4 shelves — backed by migration_video_shelves_v4.sql RPCs.
// All four wrap RPC calls and pipe the result through `mapRowToVideo`
// so callers (videos.jsx) get the same Appwrite-shaped objects the
// rest of the app already consumes. Each accepts a `userId` (Appwrite
// hex or Supabase UUID — resolved internally) and a soft `limit`.
// All four are best-effort: an empty array on error / no signal,
// never throws to the caller.
// ─────────────────────────────────────────────────────────────────────────

// Hydrate the bare RPC video rows by re-fetching them through the
// full VIDEO_SELECT — same SELECT that fetchVideos() uses, with the
// embedded profiles!videos_uploader_id_fkey join.
//
// Why this approach (and not a separate profiles fetch + merge):
//   The 4 v4 RPCs (feed_continue_watching / feed_rising_creators /
//   feed_because_you_watched / feed_from_your_followers) all
//   `returns setof public.videos` for simplicity, returning bare
//   table rows. The client mapRowToVideo expects `row.profiles` for
//   the uploader avatar/username; without it, cards render "Unknown"
//   with a "?" avatar.
//
//   First attempt was a separate `profiles where id in (...)` query
//   — but RLS on `profiles` may evaluate differently for a direct
//   anon SELECT vs. a foreign-key embedded SELECT, and we hit
//   "Unknown" rows even after that hydration.
//
//   This second approach mirrors lib/posts-supabase _hydrateRankedPosts:
//   re-fetch the video rows by id through the full VIDEO_SELECT,
//   which uses the working FK-embedded profiles join. The cost is
//   one extra round trip per shelf load (~30ms on a typical page),
//   but it guarantees parity with everything else in the app —
//   monetization fields, library_id, joined uploader profile, all
//   populated identically to the home tab.
//
//   Order preservation: the RPC's row order matters (e.g., rising
//   creators ranked by net_gain). After `.in("id", ids)` we map back
//   through a byId lookup keyed on the original id sequence so the
//   order returned to the caller exactly matches the RPC.
const hydrateVideosByIds = async (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ids = rows.map((r) => r?.id).filter(Boolean);
  if (ids.length === 0) return [];
  const { data: hydrated, error } = await supabase
    .from("videos")
    .select(VIDEO_SELECT)
    .in("id", ids);
  if (error) {
    if (__DEV__) console.log("[video-supabase] hydrateVideosByIds:", error.message);
    return rows; // best effort — degraded to "Unknown" but better than nothing
  }
  const byId = new Map((hydrated || []).map((v) => [v.id, v]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

// Read the current user's last-known watch position for a single
// video. Used by the player to seek to where the user left off
// on re-open (the "resume at 3:00" UX). Returns 0 when:
//   • the user has no progress row for this video
//   • the row exists but last_watched_seconds is null (legacy row
//     that pre-dates the v4 column add)
//   • the user isn't signed in (auth.uid() is null on the supabase
//     client — we just bail rather than throw)
export const fetchVideoProgress = async ({ videoId }) => {
  if (!videoId || !UUID_RE.test(String(videoId))) return 0;
  // Use the messages-user cache (same pattern as wallet-supabase) so
  // both Appwrite-auth and Supabase-auth users resolve correctly.
  let userId = null;
  try {
    const { getMessagesUserId } = await import("./messages-supabase");
    userId = getMessagesUserId?.() || null;
  } catch (_) {
    /* fall back to anonymous read; RLS will gate it */
  }
  if (!userId) return 0;
  const { data, error } = await supabase
    .from("video_progress")
    .select("last_watched_seconds")
    .eq("user_id", userId)
    .eq("video_id", videoId)
    .maybeSingle();
  if (error) {
    if (__DEV__) console.log("[video-supabase] fetchVideoProgress:", error.message);
    return 0;
  }
  return Math.max(0, Number(data?.last_watched_seconds || 0));
};

// Continue Watching writer — debounced from the video player every
// ~10s. `seconds` is the current playback position (clamped server-side
// to >= 0). Idempotent: same (user, video) row gets upserted with the
// newer position + timestamp.
//
// Passes p_user_id explicitly so the RPC works regardless of whether
// the supabase-js client carries an auth session (Appwrite-auth users
// don't, but their Supabase UUID is resolvable via the messages-user
// cache — same pattern wallet-supabase / referrals use).
export const tickVideoProgress = async ({ videoId, seconds, userId }) => {
  if (!videoId || !UUID_RE.test(String(videoId))) return;
  const pos = Math.max(0, Number(seconds) || 0);
  // Skip useless writes — first second of a video play is just noise
  // (autoplay handshake, buffer settles). Server's GREATEST clause
  // would also reject these, but skipping client-side saves the round
  // trip.
  if (pos < 1) return;

  // Resolve a user id even when the caller didn't pass one explicitly.
  // Order: explicit > messages-user cache > auth.user().
  let resolvedUserId = null;
  if (userId) {
    resolvedUserId = UUID_RE.test(String(userId)) ? userId : await resolveSupabaseUserId(userId);
  }
  if (!resolvedUserId) {
    try {
      const { getMessagesUserId } = await import("./messages-supabase");
      resolvedUserId = getMessagesUserId?.() || null;
    } catch (_) {
      /* fall through; the RPC will use auth.uid() if any */
    }
  }

  const { error } = await supabase.rpc("tick_video_progress", {
    p_video_id: videoId,
    p_seconds: Math.floor(pos),
    p_user_id: resolvedUserId, // null is OK; RPC falls back to auth.uid()
  });
  if (error && __DEV__) {
    console.log("[video-supabase] tick_video_progress:", error.message);
  }
};

// Continue Watching reader — videos the user started but didn't finish.
// Excludes videos within 30 seconds of the end (or 10% for shorter
// videos) to avoid keeping completed videos in the shelf forever.
export const fetchContinueWatching = async ({ userId, limit = 30 } = {}) => {
  if (!userId) return [];
  const resolvedUserId = UUID_RE.test(String(userId)) ? userId : await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  const { data, error } = await supabase.rpc("feed_continue_watching", {
    p_user_id: resolvedUserId,
    p_limit: limit,
  });
  if (error) {
    if (__DEV__) console.log("[video-supabase] feed_continue_watching:", error.message);
    return [];
  }
  const hydrated = await hydrateVideosByIds(data || []);
  return hydrated.map(mapRowToVideo).filter(Boolean);
};

// Rising Creators — videos by creators with the fastest 7-day follower
// growth. Each creator contributes their most-recent ready video.
export const fetchRisingCreators = async ({ userId, limit = 20 } = {}) => {
  if (!userId) return [];
  const resolvedUserId = UUID_RE.test(String(userId)) ? userId : await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  const { data, error } = await supabase.rpc("feed_rising_creators", {
    p_user_id: resolvedUserId,
    p_limit: limit,
  });
  if (error) {
    if (__DEV__) console.log("[video-supabase] feed_rising_creators:", error.message);
    return [];
  }
  const hydrated = await hydrateVideosByIds(data || []);
  return hydrated.map(mapRowToVideo).filter(Boolean);
};

// Because You Watched <X> — server returns the anchor video as the
// FIRST row so the client can build the shelf title dynamically.
// We split the response: { anchor, recommendations } so the caller
// (videos.jsx) doesn't have to know about that contract.
export const fetchBecauseYouWatched = async ({ userId, limit = 20 } = {}) => {
  if (!userId) return { anchor: null, recommendations: [] };
  const resolvedUserId = UUID_RE.test(String(userId)) ? userId : await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return { anchor: null, recommendations: [] };
  const { data, error } = await supabase.rpc("feed_because_you_watched", {
    p_user_id: resolvedUserId,
    p_limit: limit,
  });
  if (error) {
    if (__DEV__) console.log("[video-supabase] feed_because_you_watched:", error.message);
    return { anchor: null, recommendations: [] };
  }
  const hydrated = await hydrateVideosByIds(data || []);
  const mapped = hydrated.map(mapRowToVideo).filter(Boolean);
  if (mapped.length === 0) return { anchor: null, recommendations: [] };
  return { anchor: mapped[0], recommendations: mapped.slice(1) };
};

// From Your Followers — videos liked or watched by users you follow,
// in the last 14 days, dedupped per video by most-recent engagement.
export const fetchFromYourFollowers = async ({ userId, limit = 20 } = {}) => {
  if (!userId) return [];
  const resolvedUserId = UUID_RE.test(String(userId)) ? userId : await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  const { data, error } = await supabase.rpc("feed_from_your_followers", {
    p_user_id: resolvedUserId,
    p_limit: limit,
  });
  if (error) {
    if (__DEV__) console.log("[video-supabase] feed_from_your_followers:", error.message);
    return [];
  }
  const hydrated = await hydrateVideosByIds(data || []);
  return hydrated.map(mapRowToVideo).filter(Boolean);
};


// ─────────────────────────────────────────────────────────────────────────
// Module-level helpers (mirroring the rest of lib/video.js's export list)
// ─────────────────────────────────────────────────────────────────────────

export const initialVideoForm = {
  title: "",
  description: "",
  thumbnail: null,
  uri: null,
  videoUrl: "",
  tags: [],
};

export const createNewVideo = async ({
  ID, title, description, thumbnail, uri, videoUrl, uploader, status = "uploading", ...props
}) => {
  const uploaderUuid = await resolveSupabaseUserId(uploader);
  if (!uploaderUuid) throw new Error("createNewVideo: cannot resolve uploader");
  // Same alias rewrite as updateVideoDocument — UploadVideo passes
  // through Appwrite-shaped keys (e.g. monetization_enabled) which
  // PostgREST rejects with PGRST204 unless we translate first.
  const normalizedProps = normalizeVideoPatch(props);
  const { data, error } = await supabase
    .from("videos")
    .insert({
      id: ID || undefined, // let Supabase generate if not provided
      title,
      description,
      thumbnail_url: thumbnail,
      video_url: videoUrl || uri,
      uploader_id: uploaderUuid,
      status,
      ...normalizedProps,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return mapRowToVideo(data);
};

// Translate Appwrite-shaped column names in update patches to the
// canonical Supabase columns. The mapper aliases on READ
// (is_monetized → monetization_enabled, etc.); without the inverse on
// WRITE, callers like CreatorVideoCard's monetization toggle hit
// PGRST204 ("Could not find the 'monetization_enabled' column of
// 'videos' in the schema cache"). Add new aliases here whenever the
// mapper grows a new alias.
const VIDEO_PATCH_ALIASES = {
  monetization_enabled: "is_monetized",
};

const normalizeVideoPatch = (patch = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const target = VIDEO_PATCH_ALIASES[key] || key;
    out[target] = value;
  }
  return out;
};

export const updateVideoDocument = async ({ id, data: patch }) => {
  const isUuid = UUID_RE.test(id);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const normalizedPatch = normalizeVideoPatch(patch);
  const { data, error } = await supabase
    .from("videos")
    .update(normalizedPatch)
    .eq(column, id)
    .select()
    .maybeSingle();
  if (error) throw error;
  // Bust the read-side TTL cache so the next getVideo for this row
  // doesn't return the pre-update mapped object.
  if (id) VIDEO_CACHE.delete(id);
  return mapRowToVideo(data);
};

export const deleteVideoDocument = async ({ id }) => {
  const isUuid = UUID_RE.test(id);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  // Soft-delete to match Appwrite behavior.
  const { error } = await supabase
    .from("videos")
    .update({ status: "deleted" })
    .eq(column, id);
  if (error) throw error;
};

// Likes — composite PK on (video_id, user_id) makes these idempotent.
// Each function resolves the incoming videoId through resolveVideoUuid so
// hex-shaped legacy IDs (passed in from `video.$id` on migrated rows) are
// translated to the canonical Supabase UUID before hitting the DB.
export const createVideoLike = async ({ videoId, likeOwner }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) throw new Error("createVideoLike: cannot resolve video");
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid) throw new Error("createVideoLike: cannot resolve user");
  const { error } = await supabase
    .from("video_likes")
    .insert({ video_id: videoUuid, user_id: userUuid });
  if (error && error.code !== "23505") throw error;
  return { $id: `${videoUuid}::${userUuid}` };
};

export const deleteVideoLike = async ({ videoLikeId }) => {
  if (!videoLikeId) return;
  const [videoId, userId] = String(videoLikeId).split("::");
  if (!videoId || !userId) return;
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return;
  const { error } = await supabase
    .from("video_likes")
    .delete()
    .eq("video_id", videoUuid)
    .eq("user_id", userId);
  if (error) throw error;
};

export const getVideoLikeByOwner = async ({ videoId, likeOwner }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return { documents: [] };
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid) return { documents: [] };
  const { data, error } = await supabase
    .from("video_likes")
    .select("video_id, user_id, created_at")
    .eq("video_id", videoUuid)
    .eq("user_id", userUuid)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data
    ? { documents: [{ $id: `${videoUuid}::${userUuid}`, video_id: videoUuid, user_id: userUuid }] }
    : { documents: [] };
};

// Engagement counters — read straight from the denormalized counter
// columns on `videos` (maintained by the triggers in
// migration_videos_engagement_counts.sql). Cheap single-row read instead
// of a count(*) scan on video_likes / video_comments.
export const getVideoLikeCount = async ({ videoId }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return 0;
  const { data, error } = await supabase
    .from("videos")
    .select("likes_count")
    .eq("id", videoUuid)
    .maybeSingle();
  if (error) {
    console.warn("getVideoLikeCount error:", error.message);
    return 0;
  }
  return data?.likes_count ?? 0;
};

export const getVideoCommentCount = async ({ videoId }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return 0;
  const { data, error } = await supabase
    .from("videos")
    .select("comments_count")
    .eq("id", videoUuid)
    .maybeSingle();
  if (error) {
    console.warn("getVideoCommentCount error:", error.message);
    return 0;
  }
  return data?.comments_count ?? 0;
};

// getVideoViewCount — same shape as the like/comment counters above.
// Reads videos.views_count, the denormalized counter kept current by
// the trigger in migration_videos_engagement_counts.sql. Used by the
// stats provider so the videos tab + cards reflect bumps without
// requiring the FlashList row to refetch.
export const getVideoViewCount = async ({ videoId }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return 0;
  const { data, error } = await supabase
    .from("videos")
    .select("views_count")
    .eq("id", videoUuid)
    .maybeSingle();
  if (error) {
    console.warn("getVideoViewCount error:", error.message);
    return 0;
  }
  return data?.views_count ?? 0;
};

// ─────────────────────────────────────────────────────────────────────────
// Comments — port of the Appwrite comment threading + likes
// ─────────────────────────────────────────────────────────────────────────
//
// Schema (migration_videos_engagement_counts.sql):
//   video_comments       — id, video_id, user_id, content, parent_id,
//                          likes_count, created_at, updated_at
//   video_comment_likes  — comment_id, user_id, created_at (composite PK)
//
// VideoCommentModal expects each comment to look Appwrite-shaped:
//   { $id, $createdAt, comment, commentOwner: { $id, username, avatar },
//     videoCommentLikes (hydrated separately), videoComments (replies),
//     videoComment / parentCommentId (parent ref) }
//
// hydrateCommentRow translates a Supabase row + joined profile into that
// shape. The `comment` field carries the body (Appwrite called it that
// even though our column is `content`); `videoComment` is the parent
// alias — modal's resolveVideoCommentParentId tries that key first.

const COMMENT_SELECT = `
  id, video_id, user_id, content, parent_id, likes_count,
  created_at, updated_at,
  profiles!video_comments_user_id_fkey ( id, username, avatar_url, role, legacy_appwrite_id )
`;

const hydrateCommentRow = (row) => {
  if (!row) return null;
  const owner = row.profiles || {};
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    id: row.id,
    video_id: row.video_id,
    video: row.video_id,
    parent_id: row.parent_id,
    // Modal reads parent ref via resolveVideoCommentParentId, which checks
    // `videoComment`, `videoComments`, `parentComment`, `parentCommentId`,
    // `replyToComment` in order. We populate `videoComment` (the first
    // checked key) so threading works without modal changes.
    videoComment: row.parent_id || null,
    parentCommentId: row.parent_id || null,
    comment: row.content,
    content: row.content,
    likesCount: row.likes_count ?? 0,
    commentOwner: {
      $id: owner.id || row.user_id,
      id: owner.id || row.user_id,
      username: owner.username || null,
      avatar: owner.avatar_url || null,
      avatar_url: owner.avatar_url || null,
      role: owner.role || "user",
    },
    videoCommentLikes: [],
    videoComments: [],
  };
};

// Top-level comments only (parent_id IS NULL). Cursor pagination via
// created_at-as-cursor: lastId is the cursor's $id, we look up its
// created_at and page strictly older.
export const fetchVideoComments = async ({ videoId, lastId, limit = 10 }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) return { documents: [], total: 0 };

  let q = supabase
    .from("video_comments")
    .select(COMMENT_SELECT, { count: "exact" })
    .eq("video_id", videoUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (lastId) {
    const { data: cursorRow } = await supabase
      .from("video_comments")
      .select("created_at")
      .eq("id", lastId)
      .maybeSingle();
    if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
  }

  const { data, error, count } = await q;
  if (error) {
    console.warn("fetchVideoComments error:", error.message);
    return { documents: [], total: 0 };
  }
  return {
    documents: (data || []).map(hydrateCommentRow),
    total: count ?? data?.length ?? 0,
  };
};

// Replies grouped by parent. Returns Appwrite-shaped { documents,
// byParentId, relationKey } so the modal can index into byParentId.
export const fetchVideoCommentRepliesByParentIds = async ({ parentCommentIds = [], limit = 400 }) => {
  if (!Array.isArray(parentCommentIds) || parentCommentIds.length === 0) {
    return { relationKey: "videoComment", documents: [], byParentId: {} };
  }
  const { data, error } = await supabase
    .from("video_comments")
    .select(COMMENT_SELECT)
    .in("parent_id", parentCommentIds)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.warn("fetchVideoCommentRepliesByParentIds error:", error.message);
    return { relationKey: "videoComment", documents: [], byParentId: {} };
  }
  const documents = (data || []).map(hydrateCommentRow);
  const byParentId = {};
  documents.forEach((reply) => {
    const parentId = reply.parent_id;
    if (!parentId) return;
    if (!byParentId[parentId]) byParentId[parentId] = [];
    byParentId[parentId].push(reply);
  });
  return { relationKey: "videoComment", documents, byParentId };
};

// Likes grouped by comment_id. Modal reads byCommentId[commentId] to
// know like count + who liked.
export const fetchVideoCommentLikesByCommentIds = async ({ commentIds = [], limit = 1000 }) => {
  if (!Array.isArray(commentIds) || commentIds.length === 0) {
    return { relationKey: "videoComment", documents: [], byCommentId: {} };
  }
  const { data, error } = await supabase
    .from("video_comment_likes")
    .select("comment_id, user_id, created_at")
    .in("comment_id", commentIds)
    .limit(limit);
  if (error) {
    console.warn("fetchVideoCommentLikesByCommentIds error:", error.message);
    return { relationKey: "videoComment", documents: [], byCommentId: {} };
  }
  const documents = (data || []).map((l) => ({
    $id: `${l.comment_id}::${l.user_id}`,
    videoComment: l.comment_id,
    likeOwner: { $id: l.user_id, id: l.user_id },
  }));
  const byCommentId = {};
  documents.forEach((like) => {
    const cid = like.videoComment;
    if (!byCommentId[cid]) byCommentId[cid] = [];
    byCommentId[cid].push(like);
  });
  return { relationKey: "videoComment", documents, byCommentId };
};

export const getVideoCommentLikeByOwner = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) return { relationKey: "videoComment", total: 0, documents: [] };
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid) return { relationKey: "videoComment", total: 0, documents: [] };
  const { data, error } = await supabase
    .from("video_comment_likes")
    .select("comment_id, user_id, created_at")
    .eq("comment_id", commentId)
    .eq("user_id", userUuid)
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    console.warn("getVideoCommentLikeByOwner error:", error.message);
    return { relationKey: "videoComment", total: 0, documents: [] };
  }
  return data
    ? {
        relationKey: "videoComment",
        total: 1,
        documents: [{ $id: `${commentId}::${userUuid}`, videoComment: commentId, likeOwner: { $id: userUuid } }],
      }
    : { relationKey: "videoComment", total: 0, documents: [] };
};

export const createVideoCommentLike = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) return null;
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid) return null;
  const { error } = await supabase
    .from("video_comment_likes")
    .insert({ comment_id: commentId, user_id: userUuid });
  // 23505 = unique violation = already liked (no-op).
  if (error && error.code !== "23505") {
    console.warn("createVideoCommentLike error:", error.message);
    return null;
  }
  return { $id: `${commentId}::${userUuid}`, videoComment: commentId };
};

export const removeVideoCommentLike = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) return null;
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid) return null;
  const { error } = await supabase
    .from("video_comment_likes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", userUuid);
  if (error) {
    console.warn("removeVideoCommentLike error:", error.message);
    return null;
  }
  return { $id: `${commentId}::${userUuid}` };
};

export const createVideoComment = async ({ videoId, comment, commentOwner }) => {
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) throw new Error("createVideoComment: cannot resolve video");
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!userUuid) throw new Error("createVideoComment: cannot resolve user");
  const { data, error } = await supabase
    .from("video_comments")
    .insert({ video_id: videoUuid, user_id: userUuid, content: comment })
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return hydrateCommentRow(data);
};

export const createVideoReplyComment = async ({ videoId, comment, commentOwner, parentCommentId }) => {
  if (!videoId || !commentOwner || !parentCommentId || !comment?.trim()) {
    throw new Error("createVideoReplyComment: missing required params");
  }
  const videoUuid = await resolveVideoUuid(videoId);
  if (!videoUuid) throw new Error("createVideoReplyComment: cannot resolve video");
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!userUuid) throw new Error("createVideoReplyComment: cannot resolve user");
  const { data, error } = await supabase
    .from("video_comments")
    .insert({ video_id: videoUuid, user_id: userUuid, content: comment.trim(), parent_id: parentCommentId })
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return hydrateCommentRow(data);
};

// Counter increment is a no-op on Supabase — the trigger
// _tg_video_comments_count maintains videos.comments_count automatically
// on insert/delete from video_comments. Kept exported so the dispatcher
// finds it and doesn't fall through to the Appwrite version.
export const incrementVideoComments = async () => ({ ok: true });

// Pure-helper re-exports — backend-agnostic transforms.
export { incrementVideoLikes, createVideoMetric, createVideoLikes,
  resolveVideoCommentParentId, mapVideoRepliesByParentId,
  resolveVideoCommentLikeId, mapVideoCommentLikesByCommentId,
  updateVideo,
} from "./video-appwrite";
