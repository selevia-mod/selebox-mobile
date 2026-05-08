// lib/rankings-supabase.js
//
// Creator & Writer Rankings service. Calls
// `get_creator_writer_rankings(p_period, p_limit)` and returns the
// ranked rows.
//
// Score = (views×1 + likes×5 + comments×15 + rates×25) × (0.7 + avg_rating/10)
// Shares are NOT scored — not persisted in any table.
//
// Caching mirrors the supporter-leaderboard service: 5min TTL Map
// keyed by `period`, in-flight dedup so concurrent callers share one
// request.

import supabase from "./supabase";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // period -> { rows, ts }
const inflight = new Map(); // period -> Promise

// Tier badges are POSITION-based (matches the supporter leaderboard's
// model). Different glyphs from the supporter board so the two
// leaderboards feel distinct at a glance.
//   • #1  → Top Voice       👑  (gold king)
//   • #2  → Superstar       💎  (sky blue)
//   • #3  → Rising Star     🌟  (glowing star — matches the label)
//   • #4+ → On the Charts   ✨  (sparkles)
const RANK_TIERS = {
  1: { label: "Top Voice", emoji: "👑", color: "#fbbf24" },
  2: { label: "Superstar", emoji: "💎", color: "#7dd3fc" },
  3: { label: "Rising Star", emoji: "🌟", color: "#c084fc" },
};
const ON_THE_CHARTS = { label: "On the Charts", emoji: "✨", color: "#a78bfa" };

export const resolveCreatorTier = (rank) => {
  const r = Number(rank) || 0;
  return RANK_TIERS[r] || ON_THE_CHARTS;
};

const normalizePeriod = (period) => {
  const allowed = new Set(["all_time", "month", "week"]);
  return allowed.has(period) ? period : "all_time";
};

const adaptRow = (row) => {
  const rank = Number(row?.rank) || 0;
  return {
    rank,
    userId: row?.user_id || null,
    username: row?.username || "Unknown",
    avatarUrl: row?.avatar_url || null,
    score: Number(row?.score) || 0,
    totalViews: Number(row?.total_views) || 0,
    totalLikes: Number(row?.total_likes) || 0,
    totalComments: Number(row?.total_comments) || 0,
    totalRates: Number(row?.total_rates) || 0,
    avgRating: Number(row?.avg_rating) || 0,
    contentCount: Number(row?.content_count) || 0,
    tier: resolveCreatorTier(rank),
  };
};

/**
 * Fetch the creator/writer rankings for the given period.
 *
 * @param {Object}  opts
 * @param {string}  opts.period - 'all_time' | 'month' | 'week'
 * @param {number}  opts.limit  - top-N (default 100)
 * @param {boolean} opts.force  - bypass cache for pull-to-refresh
 */
export const getCreatorWriterRankings = async ({ period = "all_time", limit = 100, force = false } = {}) => {
  const key = normalizePeriod(period);

  if (!force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      return cached.rows;
    }
  }

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      const { data, error } = await supabase.rpc("get_creator_writer_rankings", {
        p_period: key,
        p_limit: Math.max(1, Math.min(500, limit)),
      });
      if (error) {
        console.warn("[rankings] rpc error", error.message);
        return cache.get(key)?.rows || [];
      }
      const rows = Array.isArray(data) ? data.map(adaptRow) : [];
      cache.set(key, { rows, ts: Date.now() });
      return rows;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
};

/**
 * Invalidate the in-memory cache. Use after a content surface that
 * changes the user's score (publish, big spike) so the next focus
 * sees fresh totals.
 */
export const invalidateCreatorWriterRankings = () => {
  cache.clear();
};

export default {
  getCreatorWriterRankings,
  invalidateCreatorWriterRankings,
  resolveCreatorTier,
};
