// Client-side HLS-master filtering — caps the available renditions
// so the player's adaptive-bitrate logic can degrade between
// 480p / 360p / 240p but never auto-promote to 720p / 1080p.
//
// Why filter the master client-side
// ---------------------------------
// expo-video doesn't expose a `preferredPeakBitRate` or track-selection
// API. The supported way to constrain quality on iOS/Android is to
// feed the player a master playlist that only references the variants
// you want it to consider. Bunny Stream serves a master that lists
// every transcoded rendition (typically 240p through 1080p); the
// player picks freely among them based on bandwidth.
//
// We can't change Bunny's master remotely, but we can fetch it,
// filter the variant lines, and write the filtered master to a temp
// file. The player then loads our filtered master via a file:// URI;
// each variant entry inside the filtered master still points at
// Bunny's absolute URLs (we resolve them to absolute during the
// filter pass), so segments still stream from Bunny normally.
//
// Result: the player adaptive-switches among 240p / 360p / 480p only.
// On weak networks it degrades; on strong networks it stays at 480p
// instead of promoting to 720p+. Manual quality override is a future
// follow-up that would surface the original master URL when the user
// taps "Change quality".
//
// Caching
// -------
// In-memory cache keyed by `${masterUrl}|${maxHeight}` so re-opening
// the same video doesn't re-fetch + re-write. Survives screen mounts
// but not full app restarts (the temp files live in cacheDirectory,
// which the OS may evict between sessions — that's fine, we just
// rebuild on first miss).

import * as FileSystem from "expo-file-system";

// Module-level cache. Entries are { uri: string, builtAt: number }.
// We don't bother with TTL — the master playlist for a given video
// doesn't change. If Bunny re-encodes a video, the URL changes too
// (new bunny_video_id), so the old cache entry naturally falls out.
const CAPPED_MASTER_CACHE = new Map();

const cacheKey = (masterUrl, maxHeight) => `${masterUrl}|${maxHeight}`;

const fetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
};

// Parse #EXT-X-STREAM-INF attribute strings. Same minimal parser the
// download-quality flow uses; duplicated here to keep the modules
// independent (download-flow imports nothing from us, and vice versa).
const parseAttrList = (attrLine) => {
  const out = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = regex.exec(attrLine)) !== null) {
    out[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return out;
};

// Walk the master playlist text and return [{ infoLine, variantUri,
// height }]. variantUri is resolved to an absolute URL against the
// master's base so the filtered output can be loaded from anywhere
// (file://, data:, https://) and still find the variants.
const parseVariants = (masterText, masterUrl) => {
  const lines = String(masterText || "").split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrList(line.replace(/^#EXT-X-STREAM-INF:/, ""));
    let height = null;
    if (attrs.RESOLUTION) {
      const parts = String(attrs.RESOLUTION).toLowerCase().split("x");
      const w = Number(parts[0]);
      const h = Number(parts[1]);
      // Use the SHORTER edge as "height" — handles vertical videos
      // (where RESOLUTION lists portrait dims like 720x1280) the same
      // way the download flow normalizes.
      height = Number.isFinite(w) && Number.isFinite(h) ? Math.min(w, h) : null;
    }
    // The next non-blank, non-comment line is the variant URI.
    let variantUri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      try {
        variantUri = new URL(candidate, masterUrl).toString();
      } catch {
        variantUri = candidate;
      }
      break;
    }
    if (variantUri) {
      variants.push({ infoLine: line, variantUri, height });
    }
  }
  return variants;
};

// Reconstruct a master playlist from a filtered list of variants.
// Header preserved as the standard #EXTM3U + #EXT-X-VERSION:3 line;
// every variant emits its INFO line + absolute URI on the next line.
// Players don't care about the order of variants in the master.
const buildMasterText = (variants) => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const v of variants) {
    lines.push(v.infoLine);
    lines.push(v.variantUri);
  }
  return lines.join("\n") + "\n";
};

// Public — fetches the master at masterUrl, filters out variants
// taller than maxHeight, writes the filtered master to a temp file,
// returns its file:// URI.
//
// Returns null on any failure (network, parse, fs write). Caller is
// expected to fall back to the original masterUrl in that case so
// playback isn't blocked by a quality-cap miss.
export const buildCappedHlsMaster = async ({ videoUrl, maxHeight = 480 } = {}) => {
  if (!videoUrl || typeof videoUrl !== "string") return null;
  // Only meaningful on Bunny HLS masters. Local files / direct MP4 /
  // anything else passes through (caller will skip the cap and use
  // the URL as-is).
  if (!/\/playlist\.m3u8(\?|$)/i.test(videoUrl)) return null;

  const key = cacheKey(videoUrl, maxHeight);
  const cached = CAPPED_MASTER_CACHE.get(key);
  if (cached?.uri) return cached.uri;

  try {
    const masterText = await fetchText(videoUrl);
    const variants = parseVariants(masterText, videoUrl);
    if (variants.length === 0) return null;

    // Keep variants whose height is unknown (defensive — better to
    // include than silently drop) OR whose height is at or below the
    // cap. Sort by height descending so the player's first-pick
    // bandwidth-test starts at the highest allowed rendition (480p)
    // instead of climbing up from 240p.
    const filtered = variants
      .filter((v) => v.height == null || v.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (filtered.length === 0) return null;

    const filteredText = buildMasterText(filtered);

    // Write to cacheDirectory. Filename derived from the master URL +
    // cap so concurrent caps for the same video coexist (theoretical;
    // we don't actually use multiple caps today).
    const cacheDir = FileSystem.cacheDirectory || "";
    if (!cacheDir) return null;

    // Hash-y filename — base64-url of the URL portion that uniquely
    // identifies the video. Avoids collisions across different
    // Bunny libraries / videos.
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
    const path = `${cacheDir}capped-hls-${safeKey}.m3u8`;
    await FileSystem.writeAsStringAsync(path, filteredText);

    CAPPED_MASTER_CACHE.set(key, { uri: path, builtAt: Date.now() });
    return path;
  } catch (error) {
    console.warn("[video-quality] buildCappedHlsMaster failed:", error?.message);
    return null;
  }
};

// Public — clear the in-memory cache. Use on sign-out or when the
// user manually picks a new max quality (so the next fetch rebuilds
// at the new cap).
export const clearCappedHlsMasterCache = () => {
  CAPPED_MASTER_CACHE.clear();
};
