// lib/bunny-image-url.js
// ────────────────────────────────────────────────────────────────────────
// Bunny CDN image transform helper.
//
// Why this matters:
//   Most thumbnails on Bunny Storage are uploaded at 1080p+ but render
//   into 200–400px wide tiles. Loading the full-resolution asset costs
//   10–20× the bytes and GPU decompression time vs. asking Bunny to
//   downscale at the edge. On low-tier Android in particular, decoding
//   a 1920×1080 JPEG into a 320px ImageView is a major frame-drop
//   source during scroll.
//
//   Bunny's image processing endpoint accepts width/height query
//   params: `?width=400&height=235`. The CDN downscales server-side,
//   serves a smaller variant, and caches it. First request hits cold
//   cache (~50ms work); every subsequent request is free.
//
// Usage:
//   import { getBunnyImageUrl } from "../lib/bunny-image-url";
//   <FastImage source={{ uri: getBunnyImageUrl(item.thumbnail, {
//     width: cardWidth, height: imageHeight,
//   }) }} />
//
// What it handles:
//   • Null / missing URLs — returns the input as-is.
//   • URLs that already have query strings — appends with "&" rather
//     than "?" so existing params aren't clobbered.
//   • Non-Bunny URLs (Appwrite legacy, Cloudflare, base64) — returned
//     unchanged. Only URLs whose host contains "bunnycdn.com" or
//     "b-cdn.net" get transforms.
//   • DPR-aware sizing — multiplies the requested width/height by the
//     device's pixel ratio so a 320pt card on a 3× iPhone fetches a
//     960px image instead of 320px (which would look blurry).
//   • Sane caps — clamps width to 1024 max so a misuse (passing
//     screenWidth instead of cardWidth) doesn't request a 4K frame.

import { PixelRatio } from "react-native";

const BUNNY_HOST_PATTERNS = [/\.bunnycdn\.com\b/i, /\.b-cdn\.net\b/i];
const MAX_WIDTH = 1024;
const MAX_HEIGHT = 1024;

const isBunnyUrl = (url) => {
  if (typeof url !== "string" || url.length === 0) return false;
  return BUNNY_HOST_PATTERNS.some((rx) => rx.test(url));
};

/**
 * Append width/height transform params to a Bunny CDN URL.
 *
 * @param {string} url
 * @param {{ width?: number, height?: number, quality?: number }} opts
 *   width, height — in points (CSS px). DPR is applied internally.
 *   quality — JPEG/WebP quality 1–100. Default 75 — visually
 *             indistinguishable from 90 on phone screens, ~25% smaller.
 * @returns {string} The transformed URL, or the input if unchanged.
 */
export const getBunnyImageUrl = (url, { width, height, quality = 75 } = {}) => {
  if (!isBunnyUrl(url)) return url;

  const params = [];

  if (width && Number.isFinite(width) && width > 0) {
    const pxWidth = Math.min(MAX_WIDTH, Math.round(width * PixelRatio.get()));
    params.push(`width=${pxWidth}`);
  }
  if (height && Number.isFinite(height) && height > 0) {
    const pxHeight = Math.min(MAX_HEIGHT, Math.round(height * PixelRatio.get()));
    params.push(`height=${pxHeight}`);
  }
  if (Number.isFinite(quality) && quality > 0 && quality < 100) {
    params.push(`quality=${Math.round(quality)}`);
  }

  if (params.length === 0) return url;

  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${params.join("&")}`;
};

/**
 * Convenience: avatar-sized variant. Most avatars render at 36–56pt;
 * 128px source is a good balance of crispness vs. weight.
 */
export const getBunnyAvatarUrl = (url) => getBunnyImageUrl(url, { width: 128, height: 128 });
