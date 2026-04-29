import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createClipLike, deleteClipLike, getClipLike } from "../lib/clips";

const ClipsStatsContext = createContext();

export const ClipsStatsProvider = ({ children }) => {
  // clipsStats: { [clipId]: { liked, likeId, likeCount, commentCount } }
  const [clipsStats, setClipsStats] = useState({});
  const clipsStatsRef = useRef(clipsStats);
  const debounceTimersRef = useRef(new Map());

  clipsStatsRef.current = clipsStats;

  const updateClipStats = useCallback((clipId, data) => {
    setClipsStats((prev) => ({ ...prev, [clipId]: { ...(prev[clipId] || {}), ...data } }));
  }, []);

  const getClipStats = useCallback((clipId) => clipsStats[clipId] || {}, [clipsStats]);

  // load initial like state (whether current user liked this clip)
  const loadLikeStatus = useCallback(
    async (clipId, userId) => {
      if (!clipId || !userId) return;
      try {
        const resp = await getClipLike({ clipId, likeOwner: userId });
        if (resp?.documents?.length > 0) {
          const likeDoc = resp.documents[0];
          updateClipStats(clipId, { liked: true, likeId: likeDoc.$id });
        } else {
          updateClipStats(clipId, { liked: false, likeId: null });
        }
      } catch (e) {
        console.warn("loadLikeStatus error", e);
      }
    },
    [updateClipStats],
  );

  const syncClipLike = async (clipId, userId) => {
    try {
      const stats = clipsStatsRef.current[clipId] || {};
      if (stats.liked) {
        const existing = await getClipLike({ clipId, likeOwner: userId });
        if (!existing?.documents?.length) {
          const newLike = await createClipLike({ clipId, likeOwner: userId });
          updateClipStats(clipId, { likeId: newLike?.$id });
        } else {
          updateClipStats(clipId, { likeId: existing.documents[0].$id });
        }
      } else {
        const existing = await getClipLike({ clipId, likeOwner: userId });
        if (existing?.documents?.[0]) await deleteClipLike({ clipLikeId: existing.documents[0].$id });
        updateClipStats(clipId, { likeId: null });
      }
    } catch (e) {
      console.warn("syncClipLike error", e);
      await loadLikeStatus(clipId, userId);
    }
  };

  // toggle like
  const toggleLike = useCallback(
    (clip, user) => {
      if (!clip || !user) return;
      const clipId = clip.$id;
      const stats = clipsStats[clipId] || {};
      const currentLiked = stats.liked ?? false;
      const currentLikeCount = stats.likeCount ?? clip.clipLikes ?? 0;

      if (currentLiked) {
        updateClipStats(clipId, { liked: false, likeId: null, likeCount: Math.max(0, currentLikeCount - 1) });
      } else {
        updateClipStats(clipId, { liked: true, likeCount: currentLikeCount + 1 });
      }

      if (debounceTimersRef.current.has(clipId)) clearTimeout(debounceTimersRef.current.get(clipId));
      debounceTimersRef.current.set(clipId, setTimeout(() => syncClipLike(clipId, user.$id), 500));
    },
    [clipsStats, updateClipStats],
  );

  const incrementCommentCount = useCallback((clipId) => {
    setClipsStats((prev) => ({
      ...prev,
      [clipId]: { ...(prev[clipId] || {}), commentCount: (prev[clipId]?.commentCount ?? 0) + 1 },
    }));
  }, []);

  const decrementCommentCount = useCallback((clipId) => {
    setClipsStats((prev) => ({
      ...prev,
      [clipId]: { ...(prev[clipId] || {}), commentCount: Math.max((prev[clipId]?.commentCount ?? 1) - 1, 0) },
    }));
  }, []);

  const updateClipCommentCount = useCallback((clipId, newCount) => {
    setClipsStats((prev) => ({
      ...prev,
      [clipId]: { ...(prev[clipId] || {}), commentCount: newCount },
    }));
  }, []);

  const syncClipCommentCount = useCallback(async (clipId, fetchClip) => {
    try {
      const freshClip = await fetchClip({ ID: clipId });
      setClipsStats((prev) => ({
        ...prev,
        [clipId]: { ...(prev[clipId] || {}), commentCount: freshClip.clipComments || 0 },
      }));
    } catch (err) {
      console.error("syncClipCommentCount error:", err);
    }
  }, []);

  return (
    <ClipsStatsContext.Provider
      value={{
        clipsStats,
        getClipStats,
        updateClipStats,
        loadLikeStatus,
        toggleLike,
        incrementCommentCount,
        decrementCommentCount,
        updateClipCommentCount,
        syncClipCommentCount,
      }}
    >
      {children}
    </ClipsStatsContext.Provider>
  );
};

export const useClipsStats = () => useContext(ClipsStatsContext);
