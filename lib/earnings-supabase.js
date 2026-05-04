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
    .select("id, source_type, source_id, gross_coins, share_pct, net_coins, net_php_minor, currency_used, status, available_at, created_at")
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

// Per-item earnings breakdown for the Payments page drill-down. When
// the user taps the Books / Videos / Post / Clips tile, we navigate to
// a list screen that groups this author's earnings by source_id within
// the requested category and resolves titles from the underlying
// content table (books for chapter/book_bulk, videos for video).
//
// Returns an array of:
//   { source_id, title, total_pesos, unlock_count,
//     coin_count, star_count, last_at }
//
// Sorted by total_pesos desc so creators see their top earners first.
//
// `category` is the high-level bucket the UI tile represents:
//   'book'  → unions chapter + book_bulk earnings, joins to public.books
//             via the chapter's book_id (chapters) or source_id (book_bulk).
//   'video' → joins to public.videos via source_id.
//   'post'  → returns rows with source_id as the title (no posts table
//             join wired yet — placeholder until posts unlocks land).
//   'clip'  → same as post — placeholder.
//
// monthYear filter behaves the same as elsewhere ("YYYY-MM" or
// "Month YYYY"). Omit for lifetime.
export const getAuthorEarningsBreakdownByItem = async ({ category, monthYear } = {}) => {
  const me = await requireUser().catch(() => null);
  if (!me) return [];

  // Translate the high-level UI category into the DB source_type
  // values that count toward it. `book` rolls up two source_types
  // because a chapter unlock and a whole-book bulk unlock both feed
  // the Books tile.
  const sourceTypes =
    category === "book" ? ["chapter", "book_bulk"] :
    category === "video" ? ["video"] :
    category === "post" ? ["post"] :
    category === "clip" ? ["clip"] :
    [];

  if (sourceTypes.length === 0) return [];

  let query = supabase
    .from("author_earnings")
    .select("source_id, source_type, net_php_minor, currency_used, created_at")
    .eq("author_id", me.id)
    .in("source_type", sourceTypes)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (monthYear) {
    const range = parseMonthYear(monthYear);
    if (range) {
      query = query.gte("created_at", range.start.toISOString()).lte("created_at", range.end.toISOString());
    }
  }

  const { data: rows, error } = await query;
  if (error) {
    console.log("[earnings-supabase] getAuthorEarningsBreakdownByItem error:", error.message);
    return [];
  }

  // Aggregate per source_id (sum pesos, count unlocks, split by currency).
  const byId = new Map();
  for (const r of rows || []) {
    const id = r.source_id;
    if (!id) continue;
    const cents = Number(r.net_php_minor) || 0;
    const isStar = r.currency_used === "star";
    const at = r.created_at ? new Date(r.created_at).getTime() : 0;
    const existing = byId.get(id);
    if (existing) {
      existing.totalMinor += cents;
      existing.unlockCount += 1;
      if (isStar) existing.starCount += 1; else existing.coinCount += 1;
      if (at > existing.lastAtMs) existing.lastAtMs = at;
    } else {
      byId.set(id, {
        source_id: id,
        source_type: r.source_type,
        totalMinor: cents,
        unlockCount: 1,
        coinCount: isStar ? 0 : 1,
        starCount: isStar ? 1 : 0,
        lastAtMs: at,
      });
    }
  }

  // Resolve titles. Two parallel lookups — chapters → books for
  // chapter-source ids, books for book_bulk-source ids, videos for
  // video-source ids.
  const ids = Array.from(byId.keys());
  const chapterIds = ids.filter((id) => byId.get(id).source_type === "chapter");
  const bookBulkIds = ids.filter((id) => byId.get(id).source_type === "book_bulk");
  const videoIds = ids.filter((id) => byId.get(id).source_type === "video");

  const titleByKey = new Map();

  const tasks = [];

  // Chapter → parent book title. Chapters table: id (uuid),
  // book_id (uuid). Books table: id (uuid), title (text).
  if (chapterIds.length > 0) {
    tasks.push((async () => {
      // Chunk to avoid overlong .in() arrays.
      const CHUNK = 500;
      for (let i = 0; i < chapterIds.length; i += CHUNK) {
        const slice = chapterIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("chapters")
          .select("id, title, books!inner(id, title)")
          .in("id", slice);
        (data || []).forEach((row) => {
          const bookTitle = row.books?.title || "Untitled book";
          // Show "Book — Chapter" when chapter has its own title; else
          // just the parent book title.
          const label = row.title ? `${bookTitle} — ${row.title}` : bookTitle;
          titleByKey.set(`chapter:${row.id}`, label);
        });
      }
    })());
  }

  if (bookBulkIds.length > 0) {
    tasks.push((async () => {
      const CHUNK = 500;
      for (let i = 0; i < bookBulkIds.length; i += CHUNK) {
        const slice = bookBulkIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("books")
          .select("id, title, legacy_appwrite_id")
          .or(`id.in.(${slice.join(",")}),legacy_appwrite_id.in.(${slice.join(",")})`);
        (data || []).forEach((row) => {
          // book_bulk source_id may be the Supabase UUID or the legacy
          // Appwrite hex ID (depending on which RPC path created the
          // row). Index by both so lookup hits.
          const label = row.title ? `${row.title} (full book)` : "Untitled book (full)";
          titleByKey.set(`book_bulk:${row.id}`, label);
          if (row.legacy_appwrite_id) titleByKey.set(`book_bulk:${row.legacy_appwrite_id}`, label);
        });
      }
    })());
  }

  if (videoIds.length > 0) {
    tasks.push((async () => {
      const CHUNK = 500;
      for (let i = 0; i < videoIds.length; i += CHUNK) {
        const slice = videoIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("videos")
          .select("id, title, legacy_appwrite_id")
          .or(`id.in.(${slice.join(",")}),legacy_appwrite_id.in.(${slice.join(",")})`);
        (data || []).forEach((row) => {
          const label = row.title || "Untitled video";
          titleByKey.set(`video:${row.id}`, label);
          if (row.legacy_appwrite_id) titleByKey.set(`video:${row.legacy_appwrite_id}`, label);
        });
      }
    })());
  }

  await Promise.all(tasks);

  // Project + sort.
  const items = Array.from(byId.values()).map((row) => ({
    source_id: row.source_id,
    source_type: row.source_type,
    title: titleByKey.get(`${row.source_type}:${row.source_id}`) || "Unknown item",
    total_pesos: row.totalMinor / 100,
    unlock_count: row.unlockCount,
    coin_count: row.coinCount,
    star_count: row.starCount,
    last_at: row.lastAtMs ? new Date(row.lastAtMs).toISOString() : null,
  }));

  items.sort((a, b) => b.total_pesos - a.total_pesos);
  return items;
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
//   - amount >= app_config.WITHDRAWAL_MINIMUM_AMOUNT × 100 (centavos)
//   - amount <= the author's available_php_minor
//   - no existing pending/approved request
//   - Pioneer-tier authors with role='pioneer' AND pioneer_at within
//     app_config.pioneer_exemption_days are charged ZERO fees;
//     everyone else is debited PLATFORM_COST + TRANSFER_FEE (parallel
//     deduction = sum of fractions).
//
// Returns the RPC payload:
//   { ok, withdrawal_id, amount_php_minor, fee_php_minor,
//     net_php_minor, is_pioneer_exempt, error? }
//
// Caller can render error.error code to a localized message
// (kyc_not_approved / below_minimum / fees_exceed_amount / etc.).
//
// Switched from amountCoins → amountPhpMinor in the May 2026 earnings
// overhaul so star + coin earnings can be withdrawn through a single
// peso-denominated path. The RPC handles mixed-currency earmarking
// FIFO across both.
export const requestAuthorWithdrawal = async ({ amountPhpMinor, payoutMethod, payoutDetails }) => {
  if (!Number.isFinite(amountPhpMinor) || amountPhpMinor <= 0) {
    throw new Error("amountPhpMinor must be a positive number (centavos)");
  }
  if (!payoutMethod || typeof payoutMethod !== "string") {
    throw new Error("payoutMethod required");
  }
  if (!payoutDetails || typeof payoutDetails !== "object") {
    throw new Error("payoutDetails object required");
  }
  // p_actor_id: server-side fallback for Appwrite-auth mobile users who
  // have no Supabase JWT — see migration_unlock_rpcs_actor_id_fallback.sql.
  // Resolved via requireUser() (same path used by getWallet, etc).
  const me = await requireUser().catch(() => null);
  const { data, error } = await supabase.rpc("request_author_withdrawal", {
    p_amount_php_minor: Math.round(amountPhpMinor),
    p_payout_method: payoutMethod,
    p_payout_details: payoutDetails,
    p_actor_id: me?.id || null,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// Fetches the current user's role + pioneer_at from public.profiles.
// Used by the withdrawal UI to compute Pioneer-exempt status client-side
// for the fee preview (server is the source of truth at submit time, but
// the preview saves a round-trip and lets us show "Pioneer perk: free
// withdrawals for X more days" in the modal).
//
// Returns { role, pioneer_at } or null if the profile row isn't found
// (shouldn't happen post-onboarding but the UI shouldn't crash either way).
export const getMyAuthorProfile = async () => {
  const me = await requireUser();
  const { data, error } = await supabase
    .from("profiles")
    .select("role, pioneer_at")
    .eq("id", me.id)
    .maybeSingle();
  if (error) {
    console.log("[earnings-supabase] getMyAuthorProfile error:", error.message);
    return null;
  }
  return data || null;
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
