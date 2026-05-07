// lib/audius.js — Audius music API wrapper.
//
// Audius is a decentralized music streaming network with a free,
// public, no-auth REST API. We use it to extend the Selebox-curated
// music library in MusicPickerModal so users can pick a track from
// the full Audius catalog when ours doesn't have what they want.
//
// Endpoints we use:
//   • GET /v1/tracks/search?query=<term>    — keyword search
//   • GET /v1/tracks/trending               — trending feed for empty state
//   • GET /v1/tracks/<id>/stream            — direct MP3 stream URL
//
// Required query param: `app_name`. Audius asks every consumer to
// identify itself for usage analytics (no auth gate, just an
// attribution string). We hard-code "selebox" so traffic is easy to
// attribute on their dashboards.
//
// Discovery-node strategy:
//   Audius is decentralized — dozens of community-run discovery
//   nodes serve the API. Single-node calls are fragile (any one
//   node can be slow / down / behind on indexing). The recommended
//   pattern is to fetch the live node list from api.audius.co,
//   cache it, and rotate through nodes if a request fails.
//
//   This module:
//     1. On first call, fetches https://api.audius.co (returns
//        { data: ["https://node1.../v1", "https://node2.../v1", ...] }).
//     2. Caches the list for the session.
//     3. Picks a random node from the list, makes the request.
//     4. On failure, retries with the next node (up to 3 attempts).
//     5. Falls back to a hard-coded list of known-good nodes if the
//        api.audius.co bootstrap itself fails (e.g., the host is
//        blocked on the user's network).
//
// Output shape:
//   The picker reuses its existing renderItem, which expects:
//     { $id, title, artist, fileUrl, thumbnailUrl }
//   We normalize Audius results into that exact shape so the picker
//   doesn't need to fork the render logic.
//
// Docs: https://audiusproject.github.io/api-docs/

const APP_NAME = "selebox";

// Hard-coded fallbacks if api.audius.co is unreachable. These are
// stable Audius-foundation-operated nodes that have been around for
// years. If they ALL fail, the wrapper gives up and returns []; the
// picker shows its empty state.
const FALLBACK_NODES = [
  "https://discoveryprovider.audius.co/v1",
  "https://discoveryprovider2.audius.co/v1",
  "https://discoveryprovider3.audius.co/v1",
];

let _cachedNodes = null;
let _bootstrapPromise = null;

// Fetches the live node list from api.audius.co once per session
// and caches the result. Subsequent callers get the cached list
// without re-fetching. If the bootstrap fails, falls back to the
// hard-coded list above.
const _bootstrapNodes = async () => {
  if (_cachedNodes) return _cachedNodes;
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    try {
      const res = await fetch("https://api.audius.co");
      if (!res.ok) throw new Error(`bootstrap status ${res.status}`);
      const json = await res.json();
      const nodes = Array.isArray(json?.data) ? json.data : [];
      // The api.audius.co response gives node base URLs like
      // "https://discoveryprovider.audius.co" — append /v1 so the
      // rest of this module can compose paths uniformly.
      const v1Nodes = nodes
        .map((n) => (typeof n === "string" ? n.replace(/\/$/, "") + "/v1" : null))
        .filter(Boolean);
      _cachedNodes = v1Nodes.length ? v1Nodes : FALLBACK_NODES;
    } catch (e) {
      console.log("[audius] bootstrap failed, using fallback nodes:", e?.message);
      _cachedNodes = FALLBACK_NODES;
    }
    return _cachedNodes;
  })();
  return _bootstrapPromise;
};

// Try a request against rotating nodes until one returns 200 or we
// exhaust the retry budget. Returns parsed JSON on success, null
// on total failure (caller maps null → empty list for the picker).
const _fetchWithFallback = async (path, { retries = 3 } = {}) => {
  const nodes = await _bootstrapNodes();
  // Shuffle once per call so we don't hammer the same node for a
  // burst of requests (light load-balance).
  const shuffled = [...nodes].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(retries, shuffled.length); i++) {
    const url = `${shuffled[i]}${path}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`[audius] node ${shuffled[i]} returned ${res.status}, trying next`);
        continue;
      }
      return await res.json();
    } catch (e) {
      console.log(`[audius] node ${shuffled[i]} fetch failed (${e?.message}), trying next`);
    }
  }
  console.log("[audius] all retries exhausted");
  return null;
};

// Search Audius by keyword. Empty / blank query → trending. Caller
// should debounce input — we don't queue requests internally.
export const searchAudiusTracks = async (query, { limit = 25 } = {}) => {
  const term = (query || "").trim();
  if (!term) return fetchTrendingAudiusTracks({ limit });

  console.log(`[audius] search start: "${term}" (limit ${limit})`);
  const path = `/tracks/search?query=${encodeURIComponent(term)}&app_name=${APP_NAME}&limit=${limit}`;
  const json = await _fetchWithFallback(path);
  if (!json) {
    console.log(`[audius] search "${term}" → null (all nodes failed)`);
    return [];
  }
  const tracks = normalizeAudiusTracks(json);
  console.log(`[audius] search "${term}" → ${tracks.length} tracks`);
  return tracks;
};

// Trending feed — the default when the picker opens with no query.
// Dropped the genre=All param (Audius treats absence as "all
// genres" already and "All" sometimes 400s on stricter nodes).
// time=week balances "currently popular" without showing the same
// evergreens forever.
export const fetchTrendingAudiusTracks = async ({ limit = 25 } = {}) => {
  console.log(`[audius] trending start (limit ${limit})`);
  const path = `/tracks/trending?time=week&app_name=${APP_NAME}&limit=${limit}`;
  const json = await _fetchWithFallback(path);
  if (!json) {
    console.log("[audius] trending → null (all nodes failed)");
    return [];
  }
  const tracks = normalizeAudiusTracks(json);
  console.log(`[audius] trending → ${tracks.length} tracks`);
  return tracks;
};

// Audius response → MusicPickerModal-shape:
//   $id           ← track.id (string, treat as opaque)
//   title         ← track.title
//   artist        ← track.user.name
//   fileUrl       ← stream endpoint (returns 302 → MP3 host;
//                    expo-av's Audio.Sound follows redirects)
//   thumbnailUrl  ← track.artwork["150x150"] (small for the picker
//                    list — the row only shows a 55dp thumbnail)
//   _audius       ← marker so callers can tell the source apart
//                    later (e.g. when the upload pipeline needs to
//                    store an Audius track id vs an Appwrite doc id).
const normalizeAudiusTracks = (json) => {
  const items = json?.data || [];
  // Pick a stable host for stream URLs. Stream endpoint serves a 302
  // redirect to the actual MP3, and any healthy node will serve it.
  // Prefer the first cached node from bootstrap; fall back to the
  // first FALLBACK_NODES entry. We can't use _fetchWithFallback
  // here because the URL is embedded in the returned object and
  // played via expo-av (no retry surface from us).
  const streamHost = (_cachedNodes && _cachedNodes[0]) || FALLBACK_NODES[0];
  return items
    .map((t) => {
      if (!t?.id || !t?.title) return null;
      const artwork = t?.artwork || {};
      const thumbnailUrl = artwork["150x150"] || artwork["480x480"] || artwork["1000x1000"] || null;
      return {
        $id: `audius:${t.id}`,
        title: t.title,
        artist: t?.user?.name || "Unknown",
        fileUrl: `${streamHost}/tracks/${t.id}/stream?app_name=${APP_NAME}`,
        thumbnailUrl,
        _audius: true,
        _audiusId: t.id,
      };
    })
    .filter(Boolean);
};
