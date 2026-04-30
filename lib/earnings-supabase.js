// Supabase author earnings + withdrawals service — Phase F.2 of the
// cross-platform wallet migration. Mirrors web's "Author Earnings" page
// in /Selebox/js/app.js around line 6261 (loadAuthorEarnings + the
// withdrawal request flow).
//
// What this exposes:
//   - getAuthorBalance()     — current available + pending coin balance
//   - getAuthorEarnings()    — paginated earnings rows (per-source attribution)
//   - getAuthorWithdrawals() — withdrawal request history
//   - getAuthorKyc()         — current KYC status
//   - requestAuthorWithdrawal({ amountCoins, payoutMethod, payoutDetails })
//   - submitAuthorKyc({ ...fields })  — kicks off the KYC flow
//
// Schema (all on Supabase, used by web in production):
//   author_earnings
//     - id (uuid PK)
//     - author_id (uuid → profiles.id)
//     - source_type ('post' | 'video' | 'chapter' | 'book_bulk')
//     - source_id (uuid — the row that earned this)
//     - gross_coins (int)
//     - share_pct (int — author's revenue share at time of earn)
//     - net_coins (int — gross_coins × share_pct / 100)
//     - net_php_minor (int — peso amount in minor units, i.e. cents)
//     - status ('pending' | 'available' — flips after hold period)
//     - available_at (timestamptz — when status flips)
//     - created_at (timestamptz)
//   author_withdrawals
//     - id, author_id, amount_coins, amount_php_minor
//     - status ('pending' | 'approved' | 'paid' | 'rejected')
//     - payout_method ('gcash' | 'bank' | etc.)
//     - requested_at, approved_at, paid_at
//     - rejection_reason (text, nullable)
//   author_kyc
//     - user_id (uuid PK)
//     - status ('not_submitted' | 'pending' | 'approved' | 'rejected')
//     - rejection_reason (text, nullable)
//     - submitted_at, reviewed_at
//
// Atomic RPCs (server-authoritative):
//   author_balance_for(p_author_id)
//     → { available_coins, pending_coins, available_php_minor, pending_php_minor }
//   request_author_withdrawal(p_amount_coins, p_payout_method, p_payout_details)
//     → { ok, withdrawal_id, error?, minimum_coins?, available_coins? }
//   submit_author_kyc(p_legal_name, p_id_number, p_id_type, ...)
//     → { ok, error? }

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";

// Defensive: prefer cached Appwrite-resolved id, fall back to Supabase
// session, never throw the raw AuthSessionMissingError (which surfaces
// as a red toast in dev for Appwrite-auth users).
const requireUser = async () => {
  try {
    const cached = getMessagesUserId?.();
    if (cached) return { id: cached };
  } catch (_) {}
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user) return data.user;
  } catch (_) { /* no session */ }
  throw new Error("Not signed in");
};

// ─────────────────────────────────────────────────────────────────────────
// Balance
// ─────────────────────────────────────────────────────────────────────────

// Returns the author's current rolled-up balance:
//   { available_coins, pending_coins, available_php_minor, pending_php_minor }
// Pending coins are earnings still in the hold window (defaults to 7
// days on web — configured via app_config.author_earnings_hold_days).
// When the user has no earnings yet, the RPC returns zeros.
export const getAuthorBalance = async () => {
  const me = await requireUser();
  const { data, error } = await supabase.rpc("author_balance_for", { p_author_id: me.id });
  if (error) {
    console.log("[earnings-supabase] getAuthorBalance error:", error.message);
    return { available_coins: 0, pending_coins: 0, available_php_minor: 0, pending_php_minor: 0 };
  }
  return data || { available_coins: 0, pending_coins: 0, available_php_minor: 0, pending_php_minor: 0 };
};

// ─────────────────────────────────────────────────────────────────────────
// Earnings list (per-source attribution rows)
// ─────────────────────────────────────────────────────────────────────────

// Returns the author's earnings rows newest-first, capped at `limit`.
// Web pulls 500 by default for the breakdown calculation; mobile UIs
// typically want fewer for the list view (50 is plenty for a scroll).
// `monthYear` (optional) filters to a single month for monthly-summary
// screens; format: "YYYY-MM" or "September 2025" — matches the legacy
// fetchUserEarnings API so consumers can swap in place.
export const getAuthorEarnings = async ({ limit = 500, monthYear } = {}) => {
  const me = await requireUser();
  let query = supabase
    .from("author_earnings")
    .select("id, source_type, source_id, gross_coins, share_pct, net_coins, net_php_minor, status, available_at, created_at")
    .eq("author_id", me.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (monthYear) {
    const range = parseMonthYear(monthYear);
    if (range) {
      query = query.gte("created_at", range.start.toISOString()).lte("created_at", range.end.toISOString());
    }
  }

  const { data, error } = await query;
  if (error) {
    console.log("[earnings-supabase] getAuthorEarnings error:", error.message);
    return [];
  }
  return data || [];
};

// Adapts the Supabase earnings rows into the legacy { total,
// totalEarningsThisMonth, breakdown } shape mobile's existing
// useEarnings hook + EarningsScreen consume. Lets us swap the
// data source without touching the consumer code.
//
// Mapping:
//   - total                  → sum of net_php_minor / 100 across ALL rows for the author
//   - totalEarningsThisMonth → sum of net_php_minor / 100 for the month
//   - breakdown              → { posts, video, book, clips } in pesos
//
// `clips` is mapped to 0 because the Supabase model doesn't
// distinguish clips from videos in source_type — they're both
// `'video'`. The legacy mobile UI can hide the clips row when zero.
const SOURCE_TO_BREAKDOWN = {
  post: "posts",
  video: "video",
  chapter: "book",
  book_bulk: "book",
};

// Money correctness: we sum in MINOR units (cents — `net_php_minor` is
// already an int from the DB) and divide by 100 only at the very end.
// Summing fractional pesos accumulates IEEE-754 drift (0.1 + 0.2 !== 0.3
// in floating point). For balances rendered to a user, we want exact
// arithmetic — every coin row is an int, so totals stay exact until the
// final pesos cast for display.
export const adaptEarningsToLegacyShape = (lifetimeRows = [], monthRows = []) => {
  const lifetimeTotalMinor = lifetimeRows.reduce((sum, r) => sum + (Number(r.net_php_minor) || 0), 0);

  let totalEarningsThisMonthMinor = 0;
  const breakdownMinor = { posts: 0, clips: 0, video: 0, book: 0 };
  for (const r of monthRows) {
    const cents = Number(r.net_php_minor) || 0;
    totalEarningsThisMonthMinor += cents;
    const bucket = SOURCE_TO_BREAKDOWN[r.source_type];
    if (bucket && breakdownMinor[bucket] !== undefined) breakdownMinor[bucket] += cents;
  }

  return {
    total: lifetimeTotalMinor / 100,
    totalEarningsThisMonth: totalEarningsThisMonthMinor / 100,
    breakdown: {
      posts: breakdownMinor.posts / 100,
      clips: breakdownMinor.clips / 100,
      video: breakdownMinor.video / 100,
      book: breakdownMinor.book / 100,
    },
  };
};

// Convenience: returns the legacy-shaped { total, totalEarningsThisMonth,
// breakdown } object the existing useEarnings hook + EarningsScreen
// consume. The lifetime `total` comes from `author_balance_for` (the
// authoritative server-side rollup) PLUS any already-paid/approved
// withdrawals — that gives true lifetime gross even for authors with
// thousands of earnings rows that wouldn't fit in a single page.
//
// The monthly breakdown still pulls rows directly because we need the
// per-source attribution (post / video / book), which the balance RPC
// doesn't expose. Capping at 1000 rows for the month is safe — a
// single author earning over 1000 entries in one month would be an
// outlier and the breakdown would still be directionally correct.
export const fetchUserEarnings = async (_unusedAccountId, monthYear) => {
  const me = await requireUser().catch(() => null);
  if (!me) return { total: 0, totalEarningsThisMonth: 0, breakdown: { posts: 0, clips: 0, video: 0, book: 0 } };

  // Three reads in parallel: the authoritative balance, the month's
  // attribution rows, and the withdrawal history (so we can add back
  // already-paid amounts to the lifetime gross).
  const [balance, monthRows, withdrawals] = await Promise.all([
    getAuthorBalance(),
    monthYear ? getAuthorEarnings({ limit: 1000, monthYear }) : Promise.resolve([]),
    getAuthorWithdrawals({ limit: 200 }),
  ]);

  // Lifetime gross = current available + pending earnings + everything
  // already paid out or approved. All in minor units to preserve int
  // exactness.
  const balanceMinor = (Number(balance?.available_php_minor) || 0) + (Number(balance?.pending_php_minor) || 0);
  const paidOutMinor = (withdrawals || [])
    .filter((w) => w.status === "approved" || w.status === "paid")
    .reduce((sum, w) => sum + (Number(w.amount_php_minor) || 0), 0);
  const lifetimeTotalMinor = balanceMinor + paidOutMinor;

  // Month rows still drive the breakdown chart.
  let totalEarningsThisMonthMinor = 0;
  const breakdownMinor = { posts: 0, clips: 0, video: 0, book: 0 };
  for (const r of monthRows) {
    const cents = Number(r.net_php_minor) || 0;
    totalEarningsThisMonthMinor += cents;
    const bucket = SOURCE_TO_BREAKDOWN[r.source_type];
    if (bucket && breakdownMinor[bucket] !== undefined) breakdownMinor[bucket] += cents;
  }

  return {
    total: lifetimeTotalMinor / 100,
    totalEarningsThisMonth: totalEarningsThisMonthMinor / 100,
    breakdown: {
      posts: breakdownMinor.posts / 100,
      clips: breakdownMinor.clips / 100,
      video: breakdownMinor.video / 100,
      book: breakdownMinor.book / 100,
    },
  };
};

// Month-name → index map. Hardcoded (locale-independent) because the
// legacy mobile UI passes English month names ("September 2025") and
// `new Date("September 1, 2025")` parsing is unreliable across JS
// engines + device locales. This table covers both full names and
// 3-letter abbreviations.
const MONTH_INDEX = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const parseMonthYear = (monthYear) => {
  if (!monthYear || typeof monthYear !== "string") return null;
  let year, monthIndex;
  if (monthYear.includes("-")) {
    // Format: YYYY-MM
    const [yStr, mStr] = monthYear.split("-");
    year = Number(yStr);
    monthIndex = Number(mStr) - 1;
  } else {
    // Format: "September 2025" / "Sep 2025"
    const parts = monthYear.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const lookup = MONTH_INDEX[parts[0].toLowerCase()];
    if (lookup === undefined) return null;
    year = Number(parts[1]);
    monthIndex = lookup;
  }
  if (!Number.isFinite(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  return {
    start: new Date(year, monthIndex, 1, 0, 0, 0),
    end: new Date(year, monthIndex + 1, 0, 23, 59, 59),
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Withdrawals
// ─────────────────────────────────────────────────────────────────────────

// Returns the author's withdrawal request history newest-first. Web
// caps at 20 — enough for the UI list; older requests stay in the DB.
export const getAuthorWithdrawals = async ({ limit = 20 } = {}) => {
  const me = await requireUser();
  const { data, error } = await supabase
    .from("author_withdrawals")
    .select("id, amount_coins, amount_php_minor, status, payout_method, requested_at, approved_at, paid_at, rejection_reason")
    .eq("author_id", me.id)
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.log("[earnings-supabase] getAuthorWithdrawals error:", error.message);
    return [];
  }
  return data || [];
};

// Submits a withdrawal request. Server enforces:
//   - KYC must be approved
//   - amount >= app_config.author_payout_min_coins
//   - amount <= the author's available_coins
//   - no existing pending/approved request
// Returns the RPC payload — caller can render error.error code to a
// localized message (kyc_not_approved / below_minimum / etc.).
export const requestAuthorWithdrawal = async ({ amountCoins, payoutMethod, payoutDetails }) => {
  if (!Number.isFinite(amountCoins) || amountCoins <= 0) {
    throw new Error("amountCoins must be a positive number");
  }
  if (!payoutMethod || typeof payoutMethod !== "string") {
    throw new Error("payoutMethod required");
  }
  if (!payoutDetails || typeof payoutDetails !== "object") {
    throw new Error("payoutDetails object required");
  }
  const { data, error } = await supabase.rpc("request_author_withdrawal", {
    p_amount_coins: amountCoins,
    p_payout_method: payoutMethod,
    p_payout_details: payoutDetails,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// ─────────────────────────────────────────────────────────────────────────
// KYC
// ─────────────────────────────────────────────────────────────────────────

// Returns the author's current KYC row (or null if never submitted).
// Used by the earnings UI to gate the "Request withdrawal" button + show
// rejection reasons inline.
export const getAuthorKyc = async () => {
  const me = await requireUser();
  const { data, error } = await supabase
    .from("author_kyc")
    .select("status, rejection_reason, submitted_at, reviewed_at")
    .eq("user_id", me.id)
    .maybeSingle();
  if (error) {
    console.log("[earnings-supabase] getAuthorKyc error:", error.message);
    return null;
  }
  return data || null;
};

// Submits / re-submits author KYC. Server validates the fields and
// flips the status to 'pending' for admin review. Web exposes this
// via two callers (initial submit + re-submit after rejection); same
// RPC handles both.
export const submitAuthorKyc = async (fields = {}) => {
  const { data, error } = await supabase.rpc("submit_author_kyc", fields);
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};
