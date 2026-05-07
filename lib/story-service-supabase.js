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
import { FollowService } from "./follows";
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
    // Link attachment from the 2026-05-07_stories_link_url migration.
    // `link` is null when the author didn't attach one; otherwise it's
    // { url, resourceType, resourceId } where resourceType is one of
    // 'book' | 'video' | 'external'. The story-viewer reads this on
    // swipe-up to deep-link in-app (book/video) or open the system
    // browser (external).
    link: row.link_url
      ? {
          url: row.link_url,
          resourceType: row.link_resource_type || "external",
          resourceId: row.link_resource_id || null,
        }
      : null,
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
// Link columns added 2026-05-07 — surface the swipe-up target alongside
// the story so the viewer doesn't need a follow-up read on Moment open.
const STORY_SELECT = `
  id, type, media_url, thumbnail_url, duration, music_id, status,
  link_url, link_resource_type, link_resource_id,
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

  // Stories visible to the viewer in the cube — viewer's own +
  // followed users' (mirrors the Appwrite contract). Returns a
  // grouped object keyed by user_id:
  //   { [userId]: Story[] }
  // The story-viewer screen calls sanitizeGroupedStories(grouped)
  // which does Object.entries; passing a flat array there causes
  // every "group" to be a single Story (not a Story[]) and the
  // viewer ends up with 0 user groups and renders "Story not
  // available." — that was the exact symptom of the previous
  // implementation, which returned (data || []).map(mapRowToStory).
  //
  // Includes the viewer's own freshly-uploaded story even when its
  // status is 'processing' (videos transcoding on Bunny Stream) so
  // the owner sees their just-posted Moment immediately. Other
  // viewers only see ready stories — sanitizeGroupedStories filters
  // non-ready video on the consumer side.
  async fetchViewerStories({ viewerId, limit = 200, offset = 0 }) {
    if (!viewerId) return {};
    const viewerUuid = await resolveSupabaseUserId(viewerId);
    if (!viewerUuid) return {};

    // Resolve who the viewer follows so we can include their
    // active stories in the cube. Best-effort: if the lookup fails
    // we still return the viewer's own stories so they can at least
    // see what they just posted.
    let followingUuids = [];
    try {
      const followingRes = await FollowService.getFollowing({ userId: viewerUuid });
      const docs = Array.isArray(followingRes?.documents) ? followingRes.documents : Array.isArray(followingRes) ? followingRes : [];
      followingUuids = docs
        .map((d) => d?.following_id || d?.followingId)
        .filter((id) => typeof id === "string" && id.length > 0);
    } catch (e) {
      console.log("[stories] followings fetch failed, falling back to own only:", e?.message);
    }

    const userIds = Array.from(new Set([viewerUuid, ...followingUuids]));

    const { data, error } = await supabase
      .from("stories")
      .select(STORY_SELECT)
      .in("user_id", userIds)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    // Group by uploader. Preserves recency-desc order within each
    // group because we sorted server-side.
    const grouped = {};
    for (const row of data || []) {
      const story = mapRowToStory(row);
      const uid = story?.user?.id;
      if (!uid) continue;
      if (!grouped[uid]) grouped[uid] = [];
      grouped[uid].push(story);
    }
    return grouped;
  },

  // Create a story. Media is uploaded to Bunny first, then we insert
  // the Supabase metadata row.
  //
  // CRITICAL: BunnyService doesn't expose a single uploadStoryMedia()
  // method — it has separate uploadImageToBunnyStorage (Bunny Storage
  // Zone for stills) and uploadVideoToBunnyStream (Bunny Stream for
  // HLS video). The previous version of this function called a
  // non-existent uploadStoryMedia() which silently broke every Moment
  // upload with "Upload Failed". The branching here mirrors the
  // Appwrite createStory in lib/story-service-appwrite.js.
  async createStory({ userId, fileUri, fileType, thumbnail = null, duration = null, musicId = null, link = null, onProgress, signal }) {
    if (!userId) throw new Error("User ID is required");
    if (!fileUri || !fileType) throw new Error("fileUri and fileType are required");
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("Could not resolve user");

    // Normalize fileType — accept either short forms ("image"/"video")
    // or full MIME types ("image/jpeg"/"video/mp4"). The picker can
    // pass either depending on which OS sheet was used.
    const isVideo = fileType === "video" || (typeof fileType === "string" && fileType.startsWith("video"));
    const isImage = fileType === "image" || (typeof fileType === "string" && fileType.startsWith("image"));
    if (!isVideo && !isImage) throw new Error(`Unsupported fileType: ${fileType}`);

    let mediaUrl;
    let bunnyThumbnail = null;

    if (isImage) {
      // Bunny Storage path — direct PUT, returns CDN URL.
      const fileName = `${userUuid}_${Date.now()}.jpg`;
      mediaUrl = await BunnyService.uploadImageToBunnyStorage(fileUri, fileName, { onProgress, signal });
      // Some BunnyService variants return a protocol-less URL; normalize.
      if (mediaUrl && !mediaUrl.startsWith("http")) mediaUrl = `https://${mediaUrl}`;
    } else {
      // Bunny Stream path — creates a video object, uploads bytes,
      // returns { videoId, url, thumbnail } where url is the HLS
      // playlist and thumbnail is auto-generated by Bunny.
      const title = `story_${userUuid}_${Date.now()}`;
      const result = await BunnyService.uploadVideoToBunnyStream(fileUri, title, { onProgress, signal });
      mediaUrl = result?.url;
      bunnyThumbnail = result?.thumbnail || null;
      if (!mediaUrl) throw new Error("Bunny Stream upload returned no URL");
    }

    // Link attachment from LinkPickerModal — { url, resourceType,
    // resourceId } | null. Re-validate shape here so a future caller
    // can't slip non-string values past the DB CHECK constraints (see
    // 2026-05-07_stories_link_url SQL migration). resourceType is
    // narrowed to the recognized whitelist; anything else gets nulled
    // out so the column stays clean even if the editor introduces a
    // new resource kind we haven't taught the viewer about yet.
    const linkUrl = typeof link?.url === "string" ? link.url.slice(0, 2000) : null;
    const linkResourceType = ["book", "video", "external"].includes(link?.resourceType) ? link.resourceType : null;
    const linkResourceId = typeof link?.resourceId === "string" ? link.resourceId : null;

    const { data, error } = await supabase
      .from("stories")
      .insert({
        user_id: userUuid,
        type: isVideo ? "video" : "image",
        media_url: mediaUrl,
        // Image stories don't get a separate thumbnail from Bunny —
        // the media URL IS the thumbnail. Videos get a server-generated
        // poster from Bunny Stream. Caller-supplied `thumbnail` always
        // wins when present.
        thumbnail_url: thumbnail || bunnyThumbnail || (isImage ? mediaUrl : null),
        duration,
        music_id: musicId,
        link_url: linkUrl,
        link_resource_type: linkResourceType,
        link_resource_id: linkResourceId,
        // Videos start in 'processing' (Bunny needs to transcode);
        // images go straight to 'ready'.
        status: isVideo ? "processing" : "ready",
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

  // Bunny media cleanup. BunnyService doesn't expose a generic
  // deleteFromUrl helper (the previous version of this method called
  // a non-existent BunnyService.deleteFromUrl which silently no-op'd
  // every cleanup). We branch on the story type:
  //   • video → Bunny Stream — extract videoId from the playlist URL
  //             via BunnyService.getVideoIdFromUrl, then deleteVideoFromStream
  //   • image → Bunny Storage — extract the filename after /stories/
  //             from the CDN URL, then deleteImageFromStorage
  // All best-effort. The Supabase row deletion isn't gated on Bunny
  // success — orphaned blobs are cleaned by a periodic sweeper.
  async deleteStoryMedia(story) {
    try {
      const url = story?.mediaUrl;
      if (!url) return;
      if (story?.type === "video") {
        const videoId = BunnyService.getVideoIdFromUrl?.(url);
        if (videoId) await BunnyService.deleteVideoFromStream(videoId);
      } else {
        // Storage URL: ${BUNNY_STORAGE_CDN_URL}/stories/${fileName}
        const marker = "/stories/";
        const idx = url.indexOf(marker);
        if (idx !== -1) {
          const fileName = url.slice(idx + marker.length).split("?")[0];
          if (fileName) await BunnyService.deleteImageFromStorage(fileName);
        }
      }
    } catch (err) {
      console.log("[story-supabase] deleteStoryMedia bunny err:", err?.message);
    }
  },

  // ────────────────────────────────────────────────────────────────────
  // Premium viewer features (May 2026)
  //
  // Reactions: Heart, Haha, Sad, Cry, Angry — backed by story_reactions.
  // Each user can have at most ONE reaction per story (composite PK +
  // upsert pattern). Switching reactions is a single round-trip.
  //
  // Views: existing createView is reused — story_views table already
  // tracks (story_id, viewer_id). The new getStoryViewers method joins
  // profiles for the owner-only viewers sheet.
  //
  // Repost: creates a new story row that references the original via
  // repost_of_id. Media URLs are reused — we DON'T re-upload to Bunny
  // because the original is still live for 24h. When the original
  // expires, the repost row gets cleaned up via the FK cascade
  // (deletion of the original cascades to all reposts).
  // ────────────────────────────────────────────────────────────────────

  // Returns a normalized reaction summary for a story:
  //   { counts: { heart, haha, sad, cry, angry }, total, ownReaction }
  // ownReaction is null if the viewer hasn't reacted; otherwise one of
  // the five keys above. Counts come from a single fetch + client-side
  // aggregation (no count(*) per emoji on the server) — for a 24-hour-
  // ephemeral story, the row count is bounded and small enough that
  // this stays cheap.
  async getStoryReactions(storyId, userId) {
    if (!storyId) return { counts: {}, total: 0, ownReaction: null };

    const { data, error } = await supabase
      .from("story_reactions")
      .select("reaction, user_id")
      .eq("story_id", storyId);
    if (error) throw error;

    // Pre-seed all known keys with 0 so callers can read counts.fire
    // etc. without hasOwnProperty checks. Includes the legacy 'angry'
    // key for backwards compat with old rows.
    const counts = {
      heart: 0,
      fire: 0,
      haha: 0,
      love: 0,
      cry: 0,
      eyes: 0,
      sparkle: 0,
      sad: 0,
      mind_blown: 0,
      clap: 0,
      angry: 0,
    };
    let ownReaction = null;
    let userUuid = null;
    if (userId) {
      userUuid = await resolveSupabaseUserId(userId);
    }
    for (const row of data || []) {
      if (counts[row.reaction] !== undefined) counts[row.reaction]++;
      if (userUuid && row.user_id === userUuid) ownReaction = row.reaction;
    }
    return { counts, total: data?.length || 0, ownReaction };
  },

  // Upsert pattern — switching from heart → haha overwrites the
  // existing row in a single round-trip. The trigger keeps
  // story_stats.reaction_count aligned (no change on UPDATE; only
  // INSERT/DELETE move the counter, which matches the desired
  // semantic — total reactions count stays constant when a user
  // switches their reaction).
  // Allowed reaction keys mirror the SQL CHECK constraint
  // (2026-05-07_story_reactions_expand.sql). 'angry' kept in the list
  // for backwards compat with rows written before the May 2026 picker
  // change — even though the new picker doesn't expose it.
  // eslint-disable-next-line no-irregular-whitespace
  // ['heart', 'fire', 'haha', 'love', 'cry', 'eyes', 'sparkle', 'sad', 'mind_blown', 'clap', 'angry']
  async setStoryReaction(storyId, userId, reaction) {
    if (!storyId || !userId) throw new Error("storyId and userId required");
    if (!["heart", "fire", "haha", "love", "cry", "eyes", "sparkle", "sad", "mind_blown", "clap", "angry"].includes(reaction)) {
      throw new Error(`Invalid reaction: ${reaction}`);
    }
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("Could not resolve user");

    const { error } = await supabase
      .from("story_reactions")
      .upsert(
        { story_id: storyId, user_id: userUuid, reaction, created_at: new Date().toISOString() },
        { onConflict: "story_id,user_id" },
      );
    if (error) throw error;
    return true;
  },

  async removeStoryReaction(storyId, userId) {
    if (!storyId || !userId) return false;
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return false;

    const { error } = await supabase
      .from("story_reactions")
      .delete()
      .eq("story_id", storyId)
      .eq("user_id", userUuid);
    if (error) throw error;
    return true;
  },

  // Owner-only — returns the list of viewers with their profile data
  // and (if any) their reaction. Sorted by recency. Default limit 50
  // matches the IG/TikTok pattern (viewers list shows recent first;
  // older viewers paginated in if the user scrolls).
  async getStoryViewers(storyId, { limit = 50, offset = 0 } = {}) {
    if (!storyId) return [];

    // 1) Fetch the view rows joined with profile data.
    const { data: viewRows, error: viewErr } = await supabase
      .from("story_views")
      .select(`
        viewer_id, viewed_at,
        profiles!story_views_viewer_id_fkey ( id, username, avatar_url )
      `)
      .eq("story_id", storyId)
      .order("viewed_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (viewErr) throw viewErr;

    // 2) Fetch reactions for the same story so we can decorate each
    //    viewer with their reaction emoji (if any). One round-trip is
    //    cheaper than per-viewer lookups.
    const { data: reactionRows, error: rxnErr } = await supabase
      .from("story_reactions")
      .select("user_id, reaction")
      .eq("story_id", storyId);
    if (rxnErr) throw rxnErr;

    const reactionByUser = new Map();
    for (const r of reactionRows || []) {
      reactionByUser.set(r.user_id, r.reaction);
    }

    return (viewRows || []).map((row) => {
      const profile = row.profiles || {};
      return {
        viewerId: row.viewer_id,
        viewedAt: row.viewed_at,
        username: profile.username || "Unknown",
        avatar: profile.avatar_url || null,
        reaction: reactionByUser.get(row.viewer_id) || null,
      };
    });
  },

  // Create a repost — new story row referencing the original via
  // repost_of_id. Media URLs are reused (the original Bunny upload
  // is still live; reposting doesn't burn extra storage). Status is
  // copied so the repost is immediately ready if the original was.
  // The FK cascade ensures reposts get cleaned up when the original
  // expires/deletes.
  async repostStory(originalStoryId, userId) {
    if (!originalStoryId || !userId) throw new Error("storyId and userId required");
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("Could not resolve user");

    // Fetch the original story to copy its media references.
    const { data: original, error: fetchErr } = await supabase
      .from("stories")
      .select("type, media_url, thumbnail_url, duration, music_id, status")
      .eq("id", originalStoryId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!original) throw new Error("Original story not found");

    const { data: inserted, error: insertErr } = await supabase
      .from("stories")
      .insert({
        user_id: userUuid,
        type: original.type,
        media_url: original.media_url,
        thumbnail_url: original.thumbnail_url,
        duration: original.duration,
        music_id: original.music_id,
        status: original.status || "ready",
        repost_of_id: originalStoryId,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;
    return inserted;
  },
};
