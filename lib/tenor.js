// Tenor GIF API wrapper for chat composer's GIF picker.
//
// Tenor is Google's free GIF API. We use the v2 search endpoint to power
// the composer's GIF modal — query a search term, get back a list of
// MP4/GIF URLs, and let the user tap one to send as a chat message.
//
// API key lives in private/secrets.js as TENOR_API_KEY. If unset, this
// module returns empty results and the UI shows an "unavailable" state
// rather than crashing.
//
// Docs: https://developers.google.com/tenor/guides/quickstart

import secrets from "../private/secrets";

const TENOR_BASE = "https://tenor.googleapis.com/v2";
const CLIENT_KEY = "selebox-mobile";

// Trending GIFs — what to show when the picker opens with no search.
export const fetchTrendingGifs = async ({ limit = 24 } = {}) => {
  const key = secrets?.TENOR_API_KEY;
  if (!key) return [];
  const url = `${TENOR_BASE}/featured?key=${encodeURIComponent(key)}&client_key=${CLIENT_KEY}&limit=${limit}&media_filter=tinygif,gif&contentfilter=high`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return normalizeTenorResults(json);
  } catch (e) {
    console.log("[tenor] trending fetch failed:", e?.message);
    return [];
  }
};

// Search GIFs by term. Debounce on the caller side.
export const searchTenorGifs = async (query, { limit = 24 } = {}) => {
  const term = (query || "").trim();
  if (!term) return fetchTrendingGifs({ limit });
  const key = secrets?.TENOR_API_KEY;
  if (!key) return [];
  const url = `${TENOR_BASE}/search?key=${encodeURIComponent(key)}&client_key=${CLIENT_KEY}&q=${encodeURIComponent(term)}&limit=${limit}&media_filter=tinygif,gif&contentfilter=high`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return normalizeTenorResults(json);
  } catch (e) {
    console.log("[tenor] search failed:", e?.message);
    return [];
  }
};

// Normalize Tenor's response shape to our internal { id, previewUrl, gifUrl,
// width, height } shape. We pick the smaller "tinygif" for the picker
// thumbnail and the full "gif" for the actual sent message — no point
// loading a 5MB GIF behind a 100×100 thumbnail.
const normalizeTenorResults = (json) => {
  const items = json?.results || [];
  return items
    .map((it) => {
      const tiny = it?.media_formats?.tinygif;
      const full = it?.media_formats?.gif;
      const previewUrl = tiny?.url || full?.url || null;
      const gifUrl = full?.url || tiny?.url || null;
      if (!previewUrl || !gifUrl) return null;
      const dims = full?.dims || tiny?.dims || [240, 240];
      return {
        id: it.id,
        previewUrl,
        gifUrl,
        width: dims[0] || 240,
        height: dims[1] || 240,
      };
    })
    .filter(Boolean);
};
