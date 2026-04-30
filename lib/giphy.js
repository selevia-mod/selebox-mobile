// Giphy GIF API wrapper for chat composer's GIF picker.
//
// Replaces lib/tenor.js so mobile and web share the same provider. The web
// client (Selebox/js/app.js) uses Giphy via DM_GIPHY_KEY; we use the same
// key here so both surfaces hit one Giphy account and share its rate-limit
// pool. Free tier = 100k requests/day — far above Selebox's real load.
//
// Endpoints:
//   - GET /v1/gifs/trending  (when no query)
//   - GET /v1/gifs/search?q=…  (when a query is provided)
//
// We pin contentfilter via `rating=pg-13` to match web's rating gate so
// the same content shows on both surfaces. The API returns a richer object
// per result; we normalize down to { id, previewUrl, gifUrl } so the
// caller doesn't need to know Giphy-specific shapes.
//
// Docs: https://developers.giphy.com/docs/api/endpoint

import secrets from "../private/secrets";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

// Search GIFs by term. Empty / blank query → trending. Caller should
// debounce — we don't queue requests internally.
export const searchGiphyGifs = async (query, { limit = 24 } = {}) => {
  const term = (query || "").trim();
  const key = secrets?.GIPHY_API_KEY;
  if (!key) return [];

  const url = term
    ? `${GIPHY_BASE}/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(term)}&limit=${limit}&rating=pg-13&bundle=messaging_non_clips`
    : `${GIPHY_BASE}/trending?api_key=${encodeURIComponent(key)}&limit=${limit}&rating=pg-13&bundle=messaging_non_clips`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log("[giphy] non-OK response:", res.status);
      return [];
    }
    const json = await res.json();
    return normalizeGiphyResults(json);
  } catch (e) {
    console.log("[giphy] fetch failed:", e?.message);
    return [];
  }
};

// Trending shortcut — explicit caller convenience.
export const fetchTrendingGifs = ({ limit = 24 } = {}) => searchGiphyGifs("", { limit });

// Normalize Giphy's response shape to our internal { id, previewUrl, gifUrl,
// width, height } shape. Picks the smaller "fixed_width_small" still for the
// picker thumbnail (preview poster) and the full-size GIF "downsized_medium"
// for the actual sent message. Web uses the same pair for parity.
const normalizeGiphyResults = (json) => {
  const items = json?.data || [];
  return items
    .map((it) => {
      const images = it?.images || {};
      // Prefer the small still as a poster (loads fast); fall back to the
      // animated tiny if no still is available.
      const previewUrl =
        images.fixed_width_small_still?.url ||
        images.fixed_width_small?.url ||
        images.fixed_width?.url ||
        null;
      // For the actual send, use a medium-quality animated GIF.
      // `downsized_medium` is capped at ~5MB by Giphy; `original` can be
      // huge and would blow our chat bubble's bandwidth budget.
      const gifUrl =
        images.downsized_medium?.url ||
        images.fixed_width?.url ||
        images.original?.url ||
        null;
      if (!previewUrl || !gifUrl) return null;
      const w = parseInt(images.fixed_width?.width || "240", 10) || 240;
      const h = parseInt(images.fixed_width?.height || "240", 10) || 240;
      return {
        id: it.id,
        previewUrl,
        gifUrl,
        width: w,
        height: h,
      };
    })
    .filter(Boolean);
};
