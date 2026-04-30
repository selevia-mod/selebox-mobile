// Tier-aware image source helper — Phase E.4.
//
// What this is:
//   A small utility that takes a remote image URL + a target render
//   width and returns a ready-to-feed `source` prop for FastImage with
//   tier-appropriate optimizations applied. Centralizing this means
//   feed cards don't repeat the "what size + priority should I load?"
//   logic in 12 different places.
//
// What it does:
//   1. Maps the device tier into a (qualityCeiling, widthMultiplier,
//      priority) triple. Low-tier devices get smaller decoded images
//      (less RAM per decoded bitmap, less GPU memory pressure) and
//      a lower FastImage priority so off-screen loads don't stall
//      visible-content paints.
//   2. If the URL is hosted on a Bunny CDN domain, appends Bunny
//      Optimizer query params (?width&quality). Bunny Optimizer is a
//      pull-zone feature — when enabled it transforms the image
//      server-side; when not enabled the query params are silently
//      ignored, so this is safe either way. No backend changes needed
//      to ship this.
//   3. For non-Bunny URLs (legacy Appwrite covers, S3 / CloudFront,
//      external avatars) returns the URL as-is + a tier-mapped
//      priority. We don't try to be clever about other CDNs.
//
// Why width-as-multiplier and not pixels:
//   The caller knows the layout width of the slot; we just multiply
//   by a tier-specific factor (low: 0.6, mid: 0.85, high: 1.0 — see
//   TIER_PRESET below) to derive the target source width. That keeps
//   the contract simple — callers pass "this slot is 320 dp" and we
//   figure out a sensible source pixel width for the device.
//
// Caveats:
//   - Avatar URLs are usually small to begin with (Bunny pull zones
//     return the original on missing transforms). The bandwidth win
//     there is marginal, but the priority gate still helps batter
//     life when scrolling past 30 cards in the feed.
//   - Bunny URL detection is loose (matches "bunnycdn.com" and
//     "b-cdn.net" — both standard Bunny domains). Selebox-specific
//     CDN aliases would still pass through optimization params if
//     they're CNAMEs onto Bunny.
//
// API:
//   - optimizedImageUri(url, { tier, width }) → string  (the URL to fetch)
//   - imagePriority(tier, isViewport) → FastImage.priority constant
//   - optimizedImageSource(url, opts) → { uri, priority }  (the FastImage `source` prop)

import FastImage from "react-native-fast-image";
import { getDeviceTier } from "../device-tier";

// Tier → (target width multiplier, quality ceiling). The multiplier is
// applied on top of the slot's intrinsic width to pick a Bunny
// transform; quality maps to Bunny Optimizer's `?quality=N` param.
//
// These values are conservative — we'd rather slightly under-decode
// than ship a blurry feed. The biggest absolute win is on `low` where
// we cap quality at 60 (vs 80 baseline), which roughly halves
// decoded-bitmap memory for the same on-screen size.
const TIER_PRESET = {
  low: { widthMultiplier: 0.6, quality: 60 },
  mid: { widthMultiplier: 0.85, quality: 75 },
  high: { widthMultiplier: 1, quality: 85 },
};

// Bunny CDN hostnames we know about. The check is conservative — only
// these domains get optimizer params; anything else passes through.
const BUNNY_HOST_RE = /(?:^|\.)(bunnycdn\.com|b-cdn\.net)(?:\/|$)/i;

const isBunnyUrl = (url) => {
  if (!url || typeof url !== "string") return false;
  return BUNNY_HOST_RE.test(url);
};

// Returns the URL to fetch — adds Bunny Optimizer params on Bunny
// hosts, returns the original otherwise.
//
// Why screen pixels (not dp): FastImage decodes at source resolution,
// not display resolution. Asking Bunny for a 480px-wide image means
// the decoded bitmap is 480px wide regardless of how it lays out.
// Callers pass `width` as the layout width in dp; we round up to the
// nearest 80px multiple so we get a small set of cache-friendly
// transform variants instead of a unique URL per dp.
//
// Idempotency: if the caller hands us a URL that ALREADY carries a
// `width=` or `quality=` Bunny Optimizer param (e.g. someone called
// this twice on the same URL by accident), we skip the append so the
// URL doesn't accumulate duplicate params. Bunny itself takes the
// first occurrence so duplicates wouldn't break rendering, but it
// pollutes the URL cache key and breaks transform reuse.
const HAS_BUNNY_OPTIMIZER_PARAM = /[?&](?:width|quality)=/i;

export const optimizedImageUri = (url, { tier = getDeviceTier(), width } = {}) => {
  if (!url || typeof url !== "string") return url;
  if (!isBunnyUrl(url)) return url;
  if (HAS_BUNNY_OPTIMIZER_PARAM.test(url)) return url;

  const preset = TIER_PRESET[tier] || TIER_PRESET.mid;
  const targetWidth = width ? Math.max(160, Math.round((width * preset.widthMultiplier) / 80) * 80) : null;

  // Build query string. Preserve any existing params the caller may
  // have set (signed tokens, etc.) by detecting the right separator.
  const separator = url.includes("?") ? "&" : "?";
  const params = [];
  if (targetWidth) params.push(`width=${targetWidth}`);
  params.push(`quality=${preset.quality}`);
  return `${url}${separator}${params.join("&")}`;
};

// Picks a FastImage priority value based on tier + whether the image
// is in the user's current viewport. Off-screen / about-to-scroll
// loads get demoted on low-tier so they don't compete with the
// visible card's bitmap decode.
export const imagePriority = (tier = getDeviceTier(), isViewport = true) => {
  if (tier === "low") return isViewport ? FastImage.priority.normal : FastImage.priority.low;
  if (tier === "mid") return isViewport ? FastImage.priority.high : FastImage.priority.normal;
  return isViewport ? FastImage.priority.high : FastImage.priority.normal;
};

// Convenience: returns a `{ uri, priority }` object ready to spread
// into FastImage's `source` prop. Most callers want this.
export const optimizedImageSource = (url, { tier = getDeviceTier(), width, isViewport = true } = {}) => {
  return {
    uri: optimizedImageUri(url, { tier, width }),
    priority: imagePriority(tier, isViewport),
  };
};
