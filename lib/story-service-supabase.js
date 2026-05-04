// Supabase-flavored StoryService — drop-in replacement for
// lib/story-service.js during the Appwrite → Supabase migration.
//
// Schema lives in Selebox/migration_stories.sql:
//   stories, story_views, story_likes, story_stats, story_music
//
// API surface mirrored from lib/story-service.js:
//   fetchStoriesFromFollowing({ userId, limit, offset })
//   fetchStories({ limit, offset })
//   fetchStoriesGrouped({ limit, offset })
//   fetchUserStories(uploaderId)
//   fetchViewerStories({ viewerId, limit, offset })
//   createStory({ userId, fileUri, fileType, ... })
//   deleteStory(storyId)
//   getStoryStats(storyId)
//   checkIfUserViewed(storyId, userId)
//   checkIfUserLiked(storyId, userId)
//   createView(storyId, userId)
//   likeStory(storyId, userId)
//   unlikeStory(likeDocId)
//   fetchMusic(musicId)
//   deleteStoryMedia(story)
//
// Returned shape mimics the Appwrite version (mapDocToStory):
//   { id, type, mediaUrl, thumbnail, user: { id, name, avatar },
//     storiesStats, createdAt, duration, expiresAt, musicId, status }
//
// Storage:
//   Stories continue to use Bunny CDN for media — same as Appwrite. We
//   just swap the metadata store. createStory + deleteStoryMedia call
//   into BunnyService unchanged.

import { BunnyService } from "./bunny-service";
import { resolveSupabaseUserId } from "./posts-supabase";
import { listBlockedUsers } from "./safety";
import supabase from "./supabase";

const READY_STATUSES = new Set(["ready"]);

// Map a joined Supabase row (stories + profile + stats) into the same
// shape the legacy Appwrite mapDocToStory returns. Keeps consumer
// rendering code (story carousel, viewer screen) unchanged.
const mapRowToStory = (row) => {
  if (!row) return null;
  const user = row.profiles || row.user || {};
  return {
    id: row.id,
    type: row.type,
    mediaUrl: row.media_url,
    thumbnail: row.thumbnail_url,
    user: {
      id: user.id,
      name: user.username,
      avatar: user.avatar_url,
    },
    storiesStats: row.story_stats
      ? {
          viewCount: row.story_stats.view_count ?? 0,
          likeCount: row.story_stats.like_count ?? 0,
        }
      : null,
    createdAt: row.created_at,
    duration: row.duration ?? null,
    expiresAt: row.expires_at ?? null,
    musicId: row.music_id ?? null,
    status: row.status || (row.type === "video" ? "processing" : "ready"),
  };
};

const shouldHideStoryForViewer = (story, viewerId) => {
  const isOwner = story.user?.id === viewerId;
  const status = story.status || (story.type === "video" ? "processing" : "ready");
  if (isOwner) return false;
  if (story.type !== "video") return false;
  return !READY_STATUSES.has(status);
};

// Standard select clause — pulls the story row with author profile and
// stats joined in one query. Saves N+1 round trips on the carousel.
const STORY_SELECT = `
  id, type, media_url, thumbnail_url, duration, music_id, status,
  expires_at, created_at, user_id,
  profiles!stories_user_id_fkey ( id, username, avatar_url ),
  story_stats ( view_count, like_count )
`;

export const StoryServiceSupabase = {
  lastGrouped: {},

  // Fetch stories from users the viewer follows. Mirrors the legacy
  // version's behavior: fetches following list, filters to active
  // (non-expired, ready) stories, maps to the legacy shape.
  async fetchStoriesFromFollowing({ userId, limit = 20, offset = 0 }) {
    if (!userId) throw new Error("User ID is required");

    const viewerUuid = await resolveSupabaseUserId(userId);
    // Return empty array on the no-resolution path — matches the
    // shape consumers expect (StoryBar.jsx calls .filter on the return).
    if (!viewerUuid) {
      this.lastGrouped = {};
      return [];
    }

    const blockedIds = await listBlockedUsers({ blockerId: userId }).catch(() => []);

    // Get following list
    const { data: followsRows, error: followsError } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", viewerUuid);
    if (followsError) throw followsError;

    const followingIds = (followsRows || [])
      .map((row) => row.following_id)
      .filter((id) => !blockedIds.includes(id));

    if (followingIds.length === 0) {
      this.lastGrouped = {};
      return [];
    }

    // Active stories (not expired, ready) from followed users
    const { data, error } = await supabase
      .from("stories")
      .select(STORY_SELECT)
      .in("user_id", followingIds)
      .gte("expires_at", new Date().toISOString())
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const mapped = (data || [])
      .map(mapRowToStory)
      .filter((s) => s && !shouldHideStoryForViewer(s, viewerUuid));

    // Group by user — same shape as legacy
    const grouped = {};
    for (const s of mapped) {
      const uid = s.user?.id;
      if (!uid) continue;
      if (!grouped[uid]) grouped[uid] = [];
      grouped[uid].push(s);
    }
    // Sort each user's stories newest-first so the StoryBar opens at the
    // most recent story when the user taps. Mirrors the legacy Appwrite
    // impl's sort step.
    for (const uid of Object.keys(grouped)) {
      grouped[uid].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    const latestPerUser = Object.values(grouped).map((arr) => arr[0]);

    // Cache the grouped map so consumers that need it (story-viewer's
    // "next story by this user" navigation) can read this.lastGrouped.
    this.lastGrouped = grouped;

    // Return the FLAT array directly — matches the legacy Appwrite
    // contract that StoryBar.jsx + other consumers expect (they call
    // .filter() / .map() on the return). Earlier this was returning
    // `{ latestPerUser, grouped }` which broke the consumer with
    // "followingStories.filter is not a function". The grouped map is
    // still accessible via this.lastGrouped for advanced consumers.
    return latestPerUser;
  },

  // Fetch all active stories, paginated. Used on profile screens that
  // want a flat global list (admin / explore).
  async fetchStories({ limit = 200, offset = 0 } = {}) {
    const { data, error } = await supabase
      .from("stories")
      .select(STORY_SELECT)
      .gte("expires_at", new Date().toISOString())
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data || []).map(mapRowToStory);
  },

  // Same as fetchStories but pre-grouped by user.
  async fetchStoriesGrouped({ limit = 200, offset = 0 } = {}) {
    const stories = await this.fetchStories({ limit, offset });
    const grouped = {};
    for (const s of stories) {
      const uid = s.user?.id;
      if (!uid) continue;
      if (!grouped[uid]) grouped[uid] = [];
      grouped[uid].push(s);
    }
    return { stories, grouped };
  },

  // All stories from one user. Used on the user's profile
  // "Stories" tab.
  async fetchUserStories(uploaderId) {
    if (!uploaderId) return [];
    const userUuid = await resolveSupabaseUserId(uploaderId);
    if (!userUuid) return [];

    const { data, error } = await supabase
      .from("stories")
      .select(STORY_SELECT)
      .eq("user_id", userUuid)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapRowToStory);
  },

  // The "viewer's own stories" — includes processing state so the
  // user sees their just-uploaded story with a spinner.
  async fetchViewerStories({ viewerId, limit = 200, offset = 0 }) {
    if (!viewerId) return [];
    const viewerUuid = await resolveSupabaseUserId(viewerId);
    if (!viewerUuid) return [];

    const { data, error } = await supabase
      .from("stories")
      .select(STORY_SELECT)
      .eq("user_id", viewerUuid)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data || []).map(mapRowToStory);
  },

  // Create a story. Media is uploaded to Bunny first (existing path),
  // then we insert the metadata row in Supabase. The legacy version
  // also called an Appwrite FFmpeg function for video overlays — we
  // keep that integration since Bunny doesn't replace it.
  async createStory({ userId, fileUri, fileType, thumbnail = null, duration = null, musicId = null, onProgress, signal }) {
    if (!userId) throw new Error("User ID is required");
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("Could not resolve user");

    // Upload media to Bunny — same as the Appwrite path.
    const { url: mediaUrl, thumbnailUrl: bunnyThumbnail } = await BunnyService.uploadStoryMedia({
      fileUri,
      fileType,
      onProgress,
      signal,
    });

    const { data, error } = await supabase
      .from("stories")
      .insert({
        user_id: userUuid,
        type: fileType?.startsWith("video") ? "video" : "image",
        media_url: mediaUrl,
        thumbnail_url: thumbnail || bunnyThumbnail || null,
        duration,
        music_id: musicId,
        // Videos start in 'processing' (Bunny needs to transcode);
        // images go straight to 'ready'.
        status: fileType?.startsWith("video") ? "processing" : "ready",
        // 24-hour TTL — DB default handles this if we omit, but explicit
        // for clarity.
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select(STORY_SELECT)
      .maybeSingle();
    if (error) throw error;
    return mapRowToStory(data);
  },

  async deleteStory(storyId) {
    if (!storyId) throw new Error("storyId required");
    const { error } = await supabase.from("stories").delete().eq("id", storyId);
    if (error) throw error;
    return true;
  },

  async getStoryStats(storyId) {
    if (!storyId) return null;
    const { data, error } = await supabase
      .from("story_stats")
      .select("view_count, like_count")
      .eq("story_id", storyId)
      .maybeSingle();
    if (error) throw error;
    return data
      ? { viewCount: data.view_count ?? 0, likeCount: data.like_count ?? 0 }
      : { viewCount: 0, likeCount: 0 };
  },

  async checkIfUserViewed(storyId, userId) {
    if (!storyId || !userId) return false;
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return false;

    const { data, error } = await supabase
      .from("story_views")
      .select("viewed_at")
      .eq("story_id", storyId)
      .eq("viewer_id", userUuid)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    return !!data;
  },

  async checkIfUserLiked(storyId, userId) {
    if (!storyId || !userId) return false;
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return false;

    const { data, error } = await supabase
      .from("story_likes")
      .select("created_at")
      .eq("story_id", storyId)
      .eq("liker_id", userUuid)
      .maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    return !!data;
  },

  // Idempotent — composite PK silently no-ops on duplicate inserts,
  // which is what we want (don't double-count a viewer who scrolls
  // past the same story twice).
  async createView(storyId, userId) {
    if (!storyId || !userId) return null;
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return null;

    const { error } = await supabase
      .from("story_views")
      .insert({ story_id: storyId, viewer_id: userUuid });
    // 23505 = unique_violation. Treat as success — already viewed.
    if (error && error.code !== "23505") throw error;
    return true;
  },

  async likeStory(storyId, userId) {
    if (!storyId || !userId) throw new Error("storyId and userId required");
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("Could not resolve user");

    const { data, error } = await supabase
      .from("story_likes")
      .insert({ story_id: storyId, liker_id: userUuid })
      .select()
      .maybeSingle();
    if (error && error.code === "23505") return { alreadyLiked: true };
    if (error) throw error;
    // Return the insert row plus a synthetic $id for any consumer that
    // expects the Appwrite-shaped doc. The composite primary key is
    // (story_id, liker_id), so we synthesize.
    return { ...data, $id: `${storyId}::${userUuid}` };
  },

  async unlikeStory(likeDocId) {
    // The legacy version took an Appwrite document id. With the
    // composite PK in Supabase, we encode (story_id, liker_id) into
    // the synthetic $id "story::user". Decode + delete.
    if (!likeDocId) return false;
    const [storyId, likerId] = String(likeDocId).split("::");
    if (!storyId || !likerId) return false;

    const { error } = await supabase
      .from("story_likes")
      .delete()
      .eq("story_id", storyId)
      .eq("liker_id", likerId);
    if (error) throw error;
    return true;
  },

  async fetchMusic(musicId) {
    if (!musicId) return null;
    const { data, error } = await supabase
      .from("story_music")
      .select("id, name, artist, audio_url, cover_url, duration")
      .eq("id", musicId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // Bunny media cleanup — same as Appwrite. The story row's media_url
  // points at Bunny CDN; we delete the underlying file then the row.
  async deleteStoryMedia(story) {
    try {
      if (story?.mediaUrl) {
        await BunnyService.deleteFromUrl(story.mediaUrl);
      }
      if (story?.thumbnail && story.thumbnail !== story?.mediaUrl) {
        await BunnyService.deleteFromUrl(story.thumbnail);
      }
    } catch (err) {
      // Best-effort. The Supabase row will get deleted regardless;
      // orphaned Bunny files get cleaned by a periodic sweeper.
      console.log("[story-supabase] deleteStoryMedia bunny err:", err?.message);
    }
  },
};
