import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createVideoLike, deleteVideoLike, getVideoLikeByOwner, getVideoLikeCount, getVideoCommentCount, getVideoViewCount } from "../lib/video";

const VideosStatsContext = createContext();

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
        // Fetch like + comment + view counts in parallel — three single-row
        // reads on the denormalized counter columns kept current by triggers.
        // Sequential awaits would add ~150ms of round-trips per card; parallel
        // collapses the wait to one round-trip.
        const [actualLikeCount, actualCommentCount, actualViewCount, resp] = await Promise.all([
          getVideoLikeCount({ videoId }),
          getVideoCommentCount({ videoId }),
          getVideoViewCount({ videoId }),
          getVideoLikeByOwner({ videoId, likeOwner: userId }),
        ]);
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
          const [likeCount, commentCount, viewCount, likeResp] = await Promise.all([
            getVideoLikeCount({ videoId }),
            getVideoCommentCount({ videoId }),
            getVideoViewCount({ videoId }),
            getVideoLikeByOwner({ videoId, likeOwner: userId }),
          ]);

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
