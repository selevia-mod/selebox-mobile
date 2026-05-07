import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createVideoLike, deleteVideoLike, getVideoLikeByOwner, getVideoLikeCount, getVideoCommentCount, getVideoViewCount } from "../lib/video";

const VideosStatsContext = createContext();

// Module-level cache for the three count queries (like / comment / view).
// Without this, every Videos tab open fired ~200 concurrent queries for a
// 50-card feed (4 queries per card via batchLoadVideoStats). The counts
// come from denormalized columns kept fresh by triggers, so a 30s TTL is
// effectively realtime to the human eye while killing the burst.
//
// We deliberately do NOT cache `getVideoLikeByOwner` here — that's per-user
// state and gets stored in the React `videosStats` map (which already dedups
// per-mount). Toggle actions (toggleLike) patch BOTH the local state AND
// invalidate this cache so the next batch read sees the fresh count.
const VIDEO_COUNTS_TTL_MS = 30 * 1000;
const VIDEO_COUNTS_CACHE_MAX = 1000;
const videoCountsCache = new Map();

const readVideoCounts = (videoId) => {
  if (!videoId) return null;
  const entry = videoCountsCache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.ts > VIDEO_COUNTS_TTL_MS) {
    videoCountsCache.delete(videoId);
    return null;
  }
  return entry.value;
};

const writeVideoCounts = (videoId, value) => {
  if (!videoId) return;
  if (videoCountsCache.size >= VIDEO_COUNTS_CACHE_MAX) {
    const oldest = videoCountsCache.keys().next().value;
    if (oldest !== undefined) videoCountsCache.delete(oldest);
  }
  videoCountsCache.set(videoId, { ts: Date.now(), value });
};

const invalidateVideoCounts = (videoId) => {
  if (videoId) videoCountsCache.delete(videoId);
};

export const VideosStatsProvider = ({ children }) => {
  // videosStats: { [videoId]: { liked, likeId, videoLikes, commentCount } }
  const [videosStats, setVideosStats] = useState({});
  const videosStatsRef = useRef(videosStats);
  const debounceTimersRef = useRef(new Map());
  const loadGenRef = useRef(new Map());

  videosStatsRef.current = videosStats;

  const updateVideoStats = useCallback((videoId, data) => {
    setVideosStats((prev) => ({
      ...prev,
      [videoId]: { ...(prev[videoId] || {}), ...data },
    }));
  }, []);

  const getVideoStats = useCallback((videoId) => videosStats[videoId] || {}, [videosStats]);

  // === Load Like Status ===
  const loadVideoStats = useCallback(
    async (videoId, userId) => {
      if (!videoId || !userId) return;
      const gen = (loadGenRef.current.get(videoId) || 0) + 1;
      loadGenRef.current.set(videoId, gen);
      try {
        // Cache hit — skip the three count round-trips and just go for the
        // per-user like-by-owner query. 30s TTL above means we still see
        // fresh numbers when a video has activity, and toggleLike below
        // invalidates the entry on local writes.
        const cachedCounts = readVideoCounts(videoId);
        const countsPromises = cachedCounts
          ? [Promise.resolve(cachedCounts.likeCount), Promise.resolve(cachedCounts.commentCount), Promise.resolve(cachedCounts.viewCount)]
          : [getVideoLikeCount({ videoId }), getVideoCommentCount({ videoId }), getVideoViewCount({ videoId })];

        const [actualLikeCount, actualCommentCount, actualViewCount, resp] = await Promise.all([
          ...countsPromises,
          getVideoLikeByOwner({ videoId, likeOwner: userId }),
        ]);

        if (!cachedCounts) {
          writeVideoCounts(videoId, { likeCount: actualLikeCount, commentCount: actualCommentCount, viewCount: actualViewCount });
        }
        const preservedCommentCount = videosStatsRef.current[videoId]?.commentsCount;
        const nextCommentCount = actualCommentCount ?? preservedCommentCount ?? 0;

        // A toggleLike happened while we were fetching — don't overwrite user action
        if (loadGenRef.current.get(videoId) !== gen) return;

        if (resp?.documents?.length > 0) {
          const likeDoc = resp.documents[0];
          updateVideoStats(videoId, {
            liked: true,
            likeId: likeDoc.$id,
            videoLikes: actualLikeCount,
            videoViews: actualViewCount,
            commentsCount: nextCommentCount,
          });
        } else {
          updateVideoStats(videoId, {
            liked: false,
            likeId: null,
            videoLikes: actualLikeCount,
            videoViews: actualViewCount,
            commentsCount: nextCommentCount,
          });
        }
      } catch (e) {
        console.warn("loadVideoStats error", e);
      }
    },
    [updateVideoStats],
  );

  // === Batch Load Stats (pre-fetch for feed) ===
  const batchLoadVideoStats = useCallback(
    async (videoIds, userId) => {
      if (!userId || !videoIds?.length) return;

      // Filter out IDs that already have stats loaded
      const needed = videoIds.filter((id) => id && videosStats[id]?.videoLikes === undefined);
      if (needed.length === 0) return;

      // Capture generation per video before fetching
      const genSnapshot = new Map();
      for (const videoId of needed) {
        const gen = (loadGenRef.current.get(videoId) || 0) + 1;
        loadGenRef.current.set(videoId, gen);
        genSnapshot.set(videoId, gen);
      }

      const results = await Promise.allSettled(
        needed.map(async (videoId) => {
          // Cache hit drops the 3 count queries, leaving just the per-user
          // like-by-owner. For a 50-card feed where the cache is warm this
          // takes the burst from 200 queries down to 50.
          const cachedCounts = readVideoCounts(videoId);
          const countsPromises = cachedCounts
            ? [Promise.resolve(cachedCounts.likeCount), Promise.resolve(cachedCounts.commentCount), Promise.resolve(cachedCounts.viewCount)]
            : [getVideoLikeCount({ videoId }), getVideoCommentCount({ videoId }), getVideoViewCount({ videoId })];

          const [likeCount, commentCount, viewCount, likeResp] = await Promise.all([...countsPromises, getVideoLikeByOwner({ videoId, likeOwner: userId })]);

          if (!cachedCounts) {
            writeVideoCounts(videoId, { likeCount, commentCount, viewCount });
          }

          const likeDoc = likeResp?.documents?.[0];
          return {
            videoId,
            stats: {
              liked: !!likeDoc,
              likeId: likeDoc?.$id || null,
              videoLikes: likeCount,
              videoViews: viewCount,
              commentsCount: commentCount ?? videosStatsRef.current[videoId]?.commentsCount ?? 0,
            },
          };
        }),
      );

      // Collect all fulfilled results into one update, skipping videos toggled during fetch
      const batchUpdate = {};
      for (const result of results) {
        if (result.status === "fulfilled") {
          const { videoId, stats } = result.value;
          if (loadGenRef.current.get(videoId) === genSnapshot.get(videoId)) {
            batchUpdate[videoId] = stats;
          }
        }
      }

      if (Object.keys(batchUpdate).length > 0) {
        setVideosStats((prev) => ({ ...prev, ...batchUpdate }));
      }
    },
    [videosStats],
  );

  const syncVideoLike = async (videoId, userId) => {
    try {
      const stats = videosStatsRef.current[videoId] || {};
      if (stats.liked) {
        const existing = await getVideoLikeByOwner({ videoId, likeOwner: userId });
        if (!existing?.documents?.length) {
          const newLike = await createVideoLike({ videoId, likeOwner: userId });
          updateVideoStats(videoId, { likeId: newLike?.$id });
        }
      } else {
        const existing = await getVideoLikeByOwner({ videoId, likeOwner: userId });
        if (existing?.documents?.[0]) await deleteVideoLike({ videoLikeId: existing.documents[0].$id });
      }
      const actualLikeCount = await getVideoLikeCount({ videoId });
      updateVideoStats(videoId, { videoLikes: actualLikeCount });
    } catch (e) {
      console.warn("syncVideoLike error", e);
      await loadVideoStats(videoId, userId);
    }
  };

  // === Toggle Like (Optimistic Update) ===
  const toggleLike = useCallback(
    (video, user) => {
      if (!video || !user) return;
      const videoId = video?.$id;
      const stats = videosStats[videoId] || {};
      const currentLiked = stats.liked ?? false;
      const currentLikeCount = stats.videoLikes ?? video?.videoStats?.totalLikes ?? 0;

      // Invalidate any in-flight loadVideoStats so it won't overwrite this toggle
      loadGenRef.current.set(videoId, (loadGenRef.current.get(videoId) || 0) + 1);
      // Drop the cached counts so the next batch read after sync sees the
      // fresh number instead of a stale entry that pretends nothing changed.
      invalidateVideoCounts(videoId);

      if (currentLiked) {
        updateVideoStats(videoId, { liked: false, likeId: null, videoLikes: Math.max(0, currentLikeCount - 1) });
      } else {
        updateVideoStats(videoId, { liked: true, videoLikes: currentLikeCount + 1 });
      }

      if (debounceTimersRef.current.has(videoId)) clearTimeout(debounceTimersRef.current.get(videoId));
      debounceTimersRef.current.set(
        videoId,
        setTimeout(() => syncVideoLike(videoId, user.$id), 500),
      );
    },
    [videosStats, updateVideoStats],
  );

  return (
    <VideosStatsContext.Provider
      value={{
        videosStats,
        getVideoStats,
        updateVideoStats,
        loadVideoStats,
        batchLoadVideoStats,
        toggleLike,
      }}
    >
      {children}
    </VideosStatsContext.Provider>
  );
};

export const useVideosStats = () => useContext(VideosStatsContext);
