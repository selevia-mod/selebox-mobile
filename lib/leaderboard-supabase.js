// lib/leaderboard-supabase.js
//
// Supporter Leaderboard service. Calls the
// `get_supporter_leaderboard(p_period, p_limit)` Postgres RPC and
// returns the ranked rows. The RPC sums ABS(coin_transactions.delta)
// per user, excluding 'legacy_balance_restore' + 'goal_pool_claim',
// so the leaderboard reflects real "coins bought + coins spent"
// activity (per user request).
//
// Caching strategy:
//   • In-memory Map keyed by `period` with a 5min TTL — back-to-back
//     opens of the leaderboard within five minutes are instant and
//     don't hit the network.
//   • Concurrent callers share one in-flight request via a promise
//     map (same dedup pattern used by books-rankings-supabase).
//   • `getSupporterLeaderboard({ force: true })` bypasses the cache
//     for pull-to-refresh.
//
// Tier derivation lives here so the UI doesn't have to import the
// rules separately. Keep the thresholds in sync with the badges shown
// on the supporter-leaderboard screen.

import supabase from "./supabase";

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map(); // period -> { rows, ts }
const inflight = new Map(); // period -> Promise

// Tier badges are now POSITION-based (not total-based) to match the
// "podium" mental model: the ranking itself confers the title.
//   • #1  → Global King   👑
//   • #2  → Diamond Fan   💎
//   • #3  → Elite Fan     💜  (brand purple — anchors the podium in
//                              the same hue as the rest of the app)
//   • #4+ → Super Fan     ✨  (sparkles — distinct from the podium
//                              glyphs so the eye reads "on the board,
//                              not on the podium")
const RANK_TIERS = {
  1: { label: "Global King", emoji: "👑", color: "#fbbf24" },
  2: { label: "Diamond Fan", emoji: "💎", color: "#7dd3fc" },
  3: { label: "Elite Fan", emoji: "💜", color: "#c084fc" },
};
const SUPER_FAN = { label: "Super Fan", emoji: "✨", color: "#a78bfa" };

/**
 * Resolve the supporter tier for a rank position. Always returns a
 * tier — anything outside the top-3 falls back to "Super Fan".
 */
export const resolveSupporterTier = (rank) => {
  const r = Number(rank) || 0;
  return RANK_TIERS[r] || SUPER_FAN;
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
    totalCoins: Number(row?.total_coins) || 0,
    coinsBought: Number(row?.coins_bought) || 0,
    coinsSpent: Number(row?.coins_spent) || 0,
    txCount: Number(row?.tx_count) || 0,
    // Tier derives from rank now — Global King/Diamond Fan/Elite Fan
    // for the podium, Super Fan for everyone else on the board.
    tier: resolveSupporterTier(rank),
  };
};

/**
 * Fetch the supporter leaderboard for the given period.
 *
 * @param {Object}   opts
 * @param {string}   opts.period - 'all_time' | 'month' | 'week'
 * @param {number}   opts.limit  - top-N (default 100)
 * @param {boolean}  opts.force  - bypass cache
 * @returns {Promise<Array<{rank, userId, username, avatarUrl, totalCoins, ...}>>}
 */
export const getSupporterLeaderboard = async ({ period = "all_time", limit = 100, force = false } = {}) => {
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
      const { data, error } = await supabase.rpc("get_supporter_leaderboard", {
        p_period: key,
        p_limit: Math.max(1, Math.min(500, limit)),
      });
      if (error) {
        console.warn("[leaderboard] rpc error", error.message);
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
 * Invalidate the in-memory cache. Use after a transaction surface
 * (Store / Goals / Unlock) where the user just changed their own
 * totals and wants to see them reflected next focus.
 */
export const invalidateSupporterLeaderboard = () => {
  cache.clear();
};

export default {
  getSupporterLeaderboard,
  invalidateSupporterLeaderboard,
  resolveSupporterTier,
};
