// Shared video-duration helpers.
//
// Selebox videos don't store their duration on the document — they're served
// as HLS streams and the runtime length lives in the M3U8 manifest. This util
// exposes:
//
//   - extractDurationSeconds(video) — reads any duration-ish field that may
//     have been hydrated onto the doc by a creator-side helper. Cheap, sync.
//   - fetchDurationFromPlaylist(playlistUrl) — fetches and parses the HLS
//     manifest's #EXTINF tags, summing them. Networked, async.
//   - getVideoDurationSeconds(video) — combines the above with a module-level
//     TTL cache so repeat lookups for the same video are free across mounts
//     and across surfaces (Playlist, VideoCardNew, VideoCardSmall, etc.).
//   - formatDurationCompact(seconds) — "0:42" / "12:34" / "1:23:45".
//   - formatRuntimeTotal(seconds) — "0m" / "12m" / "1h 23m".
//
// Pulled from the inline implementation that previously lived in
// CreatorVideoCard so every video surface in the app shows the same number.

import { createTtlCache } from "./createTtlCache";

// 10 minute TTL is long enough that the user won't refetch on screen swaps,
// short enough that a re-encoded source picks up a new value within a session.
// 500 entries comfortably holds Discover pool + active playlist + watched feed.
const DURATION_CACHE = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 500 });
// Tracks in-flight fetches per playlistUrl so a burst of mounts on the same
// video doesn't trigger N parallel HTTP fetches of the same manifest.
const INFLIGHT_FETCHES = new Map();

const parseDurationString = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  }
  if (parts.length === 1) return parts[0];
  return null;
};

const normalizeDurationSeconds = (value) => {
  if (value === null || value === undefined) return null;
  const fromString = parseDurationString(value);
  if (fromString !== null) return fromString;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  // Some pipelines stash milliseconds. Collapse those back to seconds.
  return numeric > 10000 ? numeric / 1000 : numeric;
};

export const extractDurationSeconds = (video) => {
  const candidates = [
    video?.durationSeconds,
    video?.duration_sec,
    video?.duration,
    video?.videoDuration,
    video?.video_duration,
    video?.length,
    video?.lengthSeconds,
    video?.videoStats?.duration,
    video?.videoStats?.durationSeconds,
  ];
  const raw = candidates.find((v) => v !== undefined && v !== null);
  return normalizeDurationSeconds(raw);
};

export const fetchDurationFromPlaylist = async (playlistUrl) => {
  if (!playlistUrl) return null;

  // Reuse an in-flight fetch for the same URL if one's already running.
  const existing = INFLIGHT_FETCHES.get(playlistUrl);
  if (existing) return existing;

  const fetchText = async (url) => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.text();
    } catch (err) {
      return null;
    }
  };

  const parseMediaPlaylistSeconds = (text) => {
    if (!text) return null;
    let total = 0;
    const regex = /#EXTINF:([0-9.]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = parseFloat(match[1]);
      if (!Number.isNaN(value)) total += value;
    }
    return total > 0 ? total : null;
  };

  const promise = (async () => {
    const rootText = await fetchText(playlistUrl);
    if (!rootText) return null;

    // Master playlist — fetch the first variant manifest.
    if (rootText.includes("#EXT-X-STREAM-INF")) {
      const lines = rootText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const variantLine = lines.find((line) => !line.startsWith("#") && line.toLowerCase().endsWith(".m3u8"));
      if (variantLine) {
        try {
          const variantUrl = new URL(variantLine, playlistUrl).toString();
          const variantText = await fetchText(variantUrl);
          const variantSeconds = parseMediaPlaylistSeconds(variantText);
          if (variantSeconds !== null) return variantSeconds;
        } catch (err) {
          // bad variant URL — fall through to media-playlist parse
        }
      }
    }

    // Media playlist — parse #EXTINF directly.
    return parseMediaPlaylistSeconds(rootText);
  })().finally(() => {
    INFLIGHT_FETCHES.delete(playlistUrl);
  });

  INFLIGHT_FETCHES.set(playlistUrl, promise);
  return promise;
};

/**
 * Resolves a video's duration in seconds, with caching.
 *
 * Cache key prefers `video.$id`, falling back to the streaming URL. Returns
 * `null` if neither doc fields nor the M3U8 yield a duration. Safe to call
 * many times for the same video — cache and in-flight dedupe handle the rest.
 */
export const getVideoDurationSeconds = async (video) => {
  if (!video) return null;
  const cacheKey = video.$id || video.uri || video.videoUrl || null;
  if (cacheKey) {
    const cached = DURATION_CACHE.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const fromFields = extractDurationSeconds(video);
  if (fromFields !== null) {
    if (cacheKey) DURATION_CACHE.set(cacheKey, fromFields);
    return fromFields;
  }

  const playlistUrl = video.videoUrl || video.uri;
  const fromManifest = await fetchDurationFromPlaylist(playlistUrl);
  if (cacheKey) DURATION_CACHE.set(cacheKey, fromManifest);
  return fromManifest;
};

/**
 * "0:42" / "12:34" / "1:23:45". Returns null when no duration is available.
 */
export const formatDurationCompact = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * "12 videos • 2h 34m" style — meant for playlist totals.
 */
export const formatRuntimeTotal = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
};
