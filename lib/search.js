// Cross-content search — Supabase-native.
//
// Why this lives entirely on Supabase:
//   Mobile's earlier search hit Appwrite for everything (userCollection,
//   posts, books, videos), but the rest of the platform has been moving
//   to Supabase progressively. By the time USE_SUPABASE_POSTS landed in
//   production, mobile's post search was effectively dead — every new
//   post wrote to Supabase, and the Appwrite collection stayed frozen.
//   Same gap for users (web signups never reached Appwrite users) and,
//   to a lesser extent, videos (web uploads only on Supabase) and books
//   (USE_SUPABASE_BOOKS still false but search across the unified
//   catalog still mostly works because the new V1 video dual-write +
//   the future books migration backfill).
//
//   Switching the search read-path to Supabase pulls all four surfaces
//   into a single, consistent index — same data web's runFeedSearch
//   queries — and immediately closes the cross-platform gap. No data
//   migration required: the tables are already populated by other
//   phases.
//
// Mirroring web:
//   - sanitizeSearchQuery / escapeIlike — hardening borrowed from
//     /Selebox/js/app.js. Without them, commas / parens / underscores
//     in user input silently break PostgREST .or() filters.
//   - Filters: profiles is_banned=false; videos status='ready' AND
//     is_hidden=false AND uploader not banned; books is_public=true
//     AND is_hidden=false AND status IN [ongoing, completed] AND
//     author not banned. Web applies these on every query; mobile now
//     does too.
//
// Adapter:
//   The mobile search screen renders Appwrite-shaped rows ($id,
//   postOwner.username, etc.). We map Supabase shapes to those keys
//   inline so the screen doesn't have to fork.

import supabase from "./supabase";
import logger from "./utils/logger";

const trimQuery = (q) => (typeof q === "string" ? q.trim() : "");

// Strip PostgREST-special chars that would break or() filters.
// Mirrors /Selebox/js/app.js sanitizeSearchQuery.
const sanitizeSearchQuery = (raw) =>
  (raw || "")
    .replace(/[,()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Escape ilike wildcards so a literal underscore doesn't match every char.
const escapeIlike = (s) => (s || "").replace(/[\\%_]/g, (m) => "\\" + m);

const buildIlikeTerm = (q) => `%${escapeIlike(q)}%`;

// ─── Profiles / People ─────────────────────────────────────────────────
// `$id` is the Appwrite-shape id the search consumer routes on. Today
// /creator-profile reads from Appwrite (USE_SUPABASE_USERS=false), so we
// surface `legacy_appwrite_id` as `$id` and keep the Supabase UUID under
// `id` for callers that care. Earlier draft set `$id = row.id` (UUID),
// which made tapping a search result open a blank profile screen because
// the Appwrite-side lookup couldn't resolve a UUID. The hard filter
// (`legacy_appwrite_id IS NOT NULL`) below guarantees we always have a
// hex to fall back on.
const adaptProfileRow = (row) => ({
  $id: row.legacy_appwrite_id || row.id,
  id: row.id,
  username: row.username || "",
  avatar: row.avatar_url || null,
  avatar_url: row.avatar_url || null,
  bio: row.bio || "",
  is_guest: !!row.is_guest,
  is_banned: !!row.is_banned,
  legacy_appwrite_id: row.legacy_appwrite_id || null,
});

export const searchUserProfiles = async (query, limit = 5) => {
  const safe = sanitizeSearchQuery(trimQuery(query));
  if (!safe) return [];
  try {
    // Fetch a wider candidate pool than `limit` so we can re-rank
    // client-side by relevance. Pure server-side `order by username asc`
    // truncated alphabetically — when a user searched "LIGAYA" they got
    // ["AB Ligaya", "Aurelia Maligaya", "faith Ligaya", "Genbel Maligaya",
    //  "I am Ligaya"] and the exact-match user "LIGAYA" was sorted past
    // the cutoff (5th alphabetical position from top went to "I am Ligaya").
    //
    // Postgres trigram or pg_trgm-based ranking would be cleaner, but
    // adding an extension is overkill for what's a simple client-side
    // re-sort over <=50 rows. Buckets:
    //   1. Exact (case-insensitive) match — username ILIKE query exactly.
    //   2. Prefix match — username ILIKE 'query%'.
    //   3. Substring match — username ILIKE '%query%'.
    // Within each bucket we still alphabetize so the order is stable.
    const POOL_LIMIT = Math.max(limit * 10, 50);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, avatar_url, bio, is_guest, is_banned, legacy_appwrite_id")
      .ilike("username", buildIlikeTerm(safe))
      .eq("is_banned", false)
      // No legacy_appwrite_id filter. Earlier versions had
      // `.not("legacy_appwrite_id", "is", null)` as a temporary guard
      // while USE_SUPABASE_USERS was false; flag has since flipped and
      // /creator-profile resolves UUIDs natively via UUID_REGEX. Leaving
      // it in had been censoring every web signup from search.
      .order("username", { ascending: true })
      .limit(POOL_LIMIT);
    if (error) throw error;

    const needle = safe.toLowerCase();
    const ranked = (data || [])
      .map((row) => {
        const u = (row.username || "").toLowerCase();
        let bucket = 3; // substring (worst)
        if (u === needle) bucket = 0;          // exact match
        else if (u.startsWith(needle)) bucket = 1; // prefix match
        else if (u.includes(needle)) bucket = 2;   // substring match
        return { row, bucket };
      })
      .sort((a, b) => {
        if (a.bucket !== b.bucket) return a.bucket - b.bucket;
        return (a.row.username || "").localeCompare(b.row.username || "");
      })
      .slice(0, limit)
      .map((entry) => adaptProfileRow(entry.row));

    return ranked;
  } catch (err) {
    logger.warn("search", "searchUserProfiles failed", err);
    return [];
  }
};

// ─── Videos ─────────────────────────────────────────────────────────────
const adaptVideoRow = (row) => {
  const profile = row.profiles || {};
  return {
    $id: row.legacy_appwrite_id || row.id,
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    thumbnail: row.thumbnail_url || null,
    thumbnail_url: row.thumbnail_url || null,
    videoUrl: row.video_url || null,
    video_url: row.video_url || null,
    uri: row.video_url || null, // search-screen player uses item.uri
    duration: row.duration ?? null,
    status: row.status,
    uploader: {
      $id: profile.legacy_appwrite_id || profile.id || row.uploader_id,
      id: profile.id || row.uploader_id,
      username: profile.username || "Unknown",
      avatar: profile.avatar_url || null,
      avatar_url: profile.avatar_url || null,
    },
  };
};

export const searchVideosByTitle = async (query, limit = 5) => {
  const safe = sanitizeSearchQuery(trimQuery(query));
  if (!safe) return [];
  try {
    const term = buildIlikeTerm(safe);
    const { data, error } = await supabase
      .from("videos")
      .select(
        "id, legacy_appwrite_id, title, description, thumbnail_url, video_url, duration, status, uploader_id, profiles!videos_uploader_id_fkey(id, username, avatar_url, is_banned, legacy_appwrite_id)",
      )
      .eq("status", "ready")
      .eq("is_hidden", false)
      // No legacy_appwrite_id filter. Same fix as the user-search
      // path: USE_SUPABASE_VIDEOS has flipped to true, /video-player
      // resolves UUIDs natively, and the filter was silently hiding
      // every web-uploaded video from mobile search.
      .or(`title.ilike.${term},description.ilike.${term}`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || [])
      .filter((v) => !v.profiles?.is_banned)
      .map(adaptVideoRow);
  } catch (err) {
    logger.warn("search", "searchVideosByTitle failed", err);
    return [];
  }
};

// ─── Books ──────────────────────────────────────────────────────────────
const adaptBookRow = (row) => {
  const profile = row.profiles || {};
  return {
    $id: row.legacy_appwrite_id || row.id,
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    thumbnail: row.cover_url || null,
    cover_url: row.cover_url || null,
    status: row.status,
    is_public: !!row.is_public,
    bookOwner: {
      $id: profile.legacy_appwrite_id || profile.id || row.author_id,
      id: profile.id || row.author_id,
      username: profile.username || "Unknown",
      avatar: profile.avatar_url || null,
    },
  };
};

export const searchBooks = async (query, limit = 5) => {
  const safe = sanitizeSearchQuery(trimQuery(query));
  if (!safe) return [];
  try {
    const term = buildIlikeTerm(safe);
    const { data, error } = await supabase
      .from("books")
      .select(
        "id, legacy_appwrite_id, title, description, cover_url, status, is_public, author_id, profiles!books_author_id_fkey(id, username, avatar_url, is_banned, legacy_appwrite_id)",
      )
      .eq("is_public", true)
      .eq("is_hidden", false)
      .in("status", ["ongoing", "completed"])
      // No legacy_appwrite_id filter. Same fix as the user-search
      // path: USE_SUPABASE_BOOKS has flipped to true, /book-info
      // resolves UUIDs natively, and the filter was silently hiding
      // every Supabase-native book from mobile search.
      .or(`title.ilike.${term},description.ilike.${term}`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || [])
      .filter((b) => !b.profiles?.is_banned)
      .map(adaptBookRow);
  } catch (err) {
    logger.warn("search", "searchBooks failed", err);
    return [];
  }
};

// ─── Posts ──────────────────────────────────────────────────────────────
// Note the body→post key rename — the search screen reads `post`. Same
// shape contract as adaptSupabasePostToAppwriteShape in posts-supabase
// but lighter (no original-post hydration; search rows are flat).
//
// $id PREFERS the Supabase UUID over the legacy_appwrite_id hex.
// Earlier versions surfaced the hex first (because /post-item used to
// hit Appwrite directly), which broke the read path: getPost saw a
// hex, tried Appwrite, and 404'd for any post whose Appwrite mirror
// had been deleted in the migration era — surfacing as the "Unable to
// load post" red banner. With USE_SUPABASE_POSTS=true the post-item
// screen's getPost is UUID-aware via fetchPostById, so giving it the
// UUID directly is the more reliable path and works for both
// migrated posts (UUID + hex) and Supabase-native posts (UUID only).
const adaptPostRowForSearch = (row) => {
  const profile = row.profiles || {};
  return {
    $id: row.id || row.legacy_appwrite_id,
    id: row.id,
    legacy_appwrite_id: row.legacy_appwrite_id || null,
    post: row.body || "",
    body: row.body || "",
    image_url: row.image_url || null,
    $createdAt: row.created_at,
    created_at: row.created_at,
    postOwner: {
      $id: profile.id || profile.legacy_appwrite_id || row.user_id,
      id: profile.id || row.user_id,
      username: profile.username || "Unknown",
      avatar: profile.avatar_url || null,
      avatar_url: profile.avatar_url || null,
    },
  };
};

export const searchPosts = async (query, limit = 6) => {
  const safe = sanitizeSearchQuery(trimQuery(query));
  if (!safe) return [];
  try {
    const term = buildIlikeTerm(safe);
    const { data, error } = await supabase
      .from("posts")
      .select(
        "id, legacy_appwrite_id, body, image_url, created_at, user_id, profiles!user_id(id, username, avatar_url, is_banned, legacy_appwrite_id)",
      )
      .eq("is_hidden", false)
      .ilike("body", term)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || [])
      .filter((p) => !p.profiles?.is_banned)
      .map(adaptPostRowForSearch);
  } catch (err) {
    logger.warn("search", "searchPosts failed", err);
    return [];
  }
};

// ─── Combined ──────────────────────────────────────────────────────────
export const searchAll = async ({ query, limit = 5 }) => {
  const safe = sanitizeSearchQuery(trimQuery(query));
  if (!safe) return { users: [], posts: [], books: [], videos: [] };

  // Run all four in parallel — each settles independently so a single
  // backend hiccup doesn't black out the whole search experience. The
  // section-specific helpers each return [] on failure, so we don't
  // need additional error fan-out here.
  const [users, posts, books, videos] = await Promise.all([
    searchUserProfiles(safe, limit),
    searchPosts(safe, Math.max(limit, 6)),
    searchBooks(safe, limit),
    searchVideosByTitle(safe, limit),
  ]);

  return { users, posts, books, videos };
};
