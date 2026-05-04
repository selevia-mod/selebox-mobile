// Supabase wallet service — Phase F.1 of the cross-platform wallet
// migration. Mirrors the web's wallet system in /Selebox/js/app.js
// (around line 247 — loadWalletState + the three unlock dialog
// helpers) so coin / star balances, unlocks, and video-paid-through
// progress all live on the SAME backend tables across platforms.
//
// Why this is the right layer:
//   - Web already calls into Postgres tables (`wallets`, `unlocks`,
//     `app_config`, `video_progress`) and atomic RPCs (`unlock_content`,
//     `unlock_video_threshold`, `unlock_book_bulk`). All the billing
//     math + idempotency lives server-side, which means we can't drift
//     between platforms even if a client implementation has a bug —
//     the server wins.
//   - Mobile previously had three split paths: an Appwrite `coins`
//     collection, two stars Cloud Functions, and an unlock_video Cloud
//     Function. Each had its own bug surface (race conditions, retry
//     loops, wallet not updating after unlock). One Supabase layer
//     replaces all three.
//
// Schema (already live on web):
//   wallets
//     - user_id (uuid PK → profiles.id)
//     - coin_balance (int)
//     - star_balance (int)
//     - updated_at (timestamptz)
//   unlocks
//     - id (uuid PK)
//     - user_id (uuid)
//     - target_type ('video' | 'chapter' | 'book' | future content)
//     - target_id (uuid — the row in the matching content table)
//     - currency_used ('coin' | 'star')
//     - cost (int)
//     - created_at (timestamptz)
//   app_config
//     - key (text PK — e.g. 'default_video_unlock_coins')
//     - value_int (int)
//   video_progress
//     - user_id (uuid)
//     - video_id (uuid)
//     - paid_through_seconds (int)
//     - updated_at (timestamptz)
//     - composite unique on (user_id, video_id)
//
// Atomic RPCs (server-authoritative — these enforce balance + idempotency):
//   unlock_content(p_target_type, p_target_id, p_currency)
//     → { ok, balance_after, cost, already_unlocked, error? }
//   unlock_video_threshold(p_video_id, p_currency, p_threshold_seconds)
//     → { ok, balance_after, cost, mode: 'permanent' | 'window', error? }
//   unlock_book_bulk(p_book_id, p_currency)
//     → { ok, balance_after, cost, cost_before_discount,
//         chapters_unlocked, error? }

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";

// UUID v4 shape — used to short-circuit unlock RPCs when callers
// hold legacy Appwrite-shaped IDs (24-char hex), avoiding both a
// pointless server roundtrip and a confusing "invalid input syntax
// for uuid" Postgres error in logs. Defined at module scope so all
// helpers reference the same regex.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defensive: prefer cached Appwrite-resolved id, fall back to Supabase
// session, never throw the raw AuthSessionMissingError.
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
// Wallet reads
// ─────────────────────────────────────────────────────────────────────────

// Returns { coin_balance, star_balance } for the current user. If the
// wallet row doesn't exist yet (brand-new account before the trigger
// has fired), returns zeros. Mirrors web's `loadWalletState` fallback
// so first-time users always see a deterministic { 0, 0 } pill instead
// of a flicker between "loading" and "0".
export const getWallet = async () => {
  const me = await requireUser();
  const { data, error } = await supabase.from("wallets").select("coin_balance, star_balance").eq("user_id", me.id).maybeSingle();
  if (error) {
    console.log("[wallet-supabase] getWallet error:", error.message);
    return { coin_balance: 0, star_balance: 0 };
  }
  return data || { coin_balance: 0, star_balance: 0 };
};

// Subscribes to wallet INSERTs and UPDATEs for the current user.
// Web pushes a fresh balance after every successful unlock RPC, so
// consumers (topbar pill, store screen) re-render automatically.
// Returns an `unsubscribe()` function — call it on unmount / sign-out.
//
// We listen to BOTH INSERT and UPDATE because a brand-new user's
// first wallet row arrives via INSERT (the trigger that creates it
// fires a fraction of a second after sign-up); subscribing only to
// UPDATE would miss the initial balance push for new accounts.
//
// `onChange` is invoked with the new { coin_balance, star_balance }.
export const subscribeToWallet = async (onChange) => {
  const me = await requireUser().catch(() => null);
  if (!me) return () => {};

  const handlePayload = (payload) => {
    const next = payload?.new;
    if (!next) return;
    try {
      onChange({ coin_balance: next.coin_balance ?? 0, star_balance: next.star_balance ?? 0 });
    } catch (error) {
      console.log("[wallet-supabase] subscribeToWallet onChange threw:", error?.message);
    }
  };

  const channel = supabase
    .channel(`wallet-${me.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "wallets", filter: `user_id=eq.${me.id}` }, handlePayload)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "wallets", filter: `user_id=eq.${me.id}` }, handlePayload)
    .subscribe();

  return () => {
    try {
      supabase.removeChannel(channel);
    } catch (error) {
      console.log("[wallet-supabase] removeChannel error:", error?.message);
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Unlocks
// ─────────────────────────────────────────────────────────────────────────

// Returns the user's full unlock list as a Set of "type:id" strings —
// fast in-memory check for "have I paid for this?" without round trips.
// Web does the same (`_userUnlocks` Set) so re-renders stay client-side.
export const getUnlocks = async () => {
  const me = await requireUser().catch(() => null);
  if (!me) return new Set();
  const { data, error } = await supabase.from("unlocks").select("target_type, target_id").eq("user_id", me.id);
  if (error) {
    console.log("[wallet-supabase] getUnlocks error:", error.message);
    return new Set();
  }
  const set = new Set();
  for (const u of data || []) {
    if (u?.target_type && u?.target_id) set.add(`${u.target_type}:${u.target_id}`);
  }
  return set;
};

// Generic unlock — any content type with a per-row cost or app_config
// default. Used by chapter unlocks and any future single-shot unlocks.
// Returns the RPC's full payload so callers can read balance_after +
// already_unlocked without an extra wallet refetch.
//
// p_actor_id: server-side fallback for Appwrite-auth mobile users who
// don't have a Supabase JWT (auth.uid() returns null inside the RPC).
// We resolve via requireUser() — same path used elsewhere in this
// module — so callers don't need to plumb the id through. When Supabase
// auth IS active, the RPC ignores this param and uses auth.uid().
export const unlockContent = async ({ targetType, targetId, currency, actorId }) => {
  if (!targetType || !targetId) throw new Error("targetType and targetId required");
  if (currency !== "coin" && currency !== "star") throw new Error("currency must be 'coin' or 'star'");
  const me = actorId ? { id: actorId } : await requireUser().catch(() => null);
  const { data, error } = await supabase.rpc("unlock_content", {
    p_target_type: targetType,
    p_target_id: targetId,
    p_currency: currency,
    p_actor_id: me?.id || null,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// Video-specific time-window unlock — coin = permanent, star =
// 10-minute window past the threshold. Server enforces the window
// math via paid_through_seconds. Threshold is in seconds.
//
// Validates the video ID is a UUID before hitting the server so
// legacy Appwrite-shaped IDs surface a clear local error instead of a
// Postgres "invalid input syntax for uuid" (which would also count
// against rate limits + log noise).
export const unlockVideoThreshold = async ({ videoId, currency, thresholdSeconds }) => {
  if (!videoId || !UUID_RE.test(String(videoId))) {
    throw new Error("videoId must be a Supabase UUID");
  }
  if (currency !== "coin" && currency !== "star") throw new Error("currency must be 'coin' or 'star'");
  if (!Number.isFinite(thresholdSeconds) || thresholdSeconds <= 0) {
    throw new Error("thresholdSeconds must be a positive number");
  }
  const { data, error } = await supabase.rpc("unlock_video_threshold", {
    p_video_id: videoId,
    p_currency: currency,
    p_threshold_seconds: thresholdSeconds,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// Bulk-unlock all locked chapters of a book at a discount. Server
// computes the discount + charges the wallet atomically + creates one
// unlocks row per chapter, all in a single transaction.
//
// p_actor_id: same Appwrite-auth fallback as unlockContent above.
export const unlockBookBulk = async ({ bookId, currency, actorId }) => {
  if (!bookId) throw new Error("bookId required");
  if (currency !== "coin" && currency !== "star") throw new Error("currency must be 'coin' or 'star'");
  const me = actorId ? { id: actorId } : await requireUser().catch(() => null);
  const { data, error } = await supabase.rpc("unlock_book_bulk", {
    p_book_id: bookId,
    p_currency: currency,
    p_actor_id: me?.id || null,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// ─────────────────────────────────────────────────────────────────────────
// App config (unlock cost defaults + similar)
// ─────────────────────────────────────────────────────────────────────────

// Web's unlock dialogs read app_config to know the default unlock cost
// when a content row doesn't override it (the per-row override is
// `unlock_cost_coins` / `unlock_cost_stars` set by the creator).
// Returns a flat { key: value_int } map — easier to consume than the
// raw rows. Cached after first call since these values change rarely.
let _appConfigCache = null;
export const getAppConfig = async ({ force = false } = {}) => {
  if (_appConfigCache && !force) return _appConfigCache;
  const { data, error } = await supabase.from("app_config").select("key, value_int");
  if (error) {
    console.log("[wallet-supabase] getAppConfig error:", error.message);
    return {};
  }
  const out = {};
  for (const row of data || []) {
    if (row?.key) out[row.key] = row.value_int;
  }
  _appConfigCache = out;
  return out;
};

// Resolves the unlock cost for a target — same precedence as web's
// `resolveUnlockCost`: row override → app_config default. `row` may
// be the content row (post / video / chapter), which can carry a
// `unlock_cost_coins` / `unlock_cost_stars` field set by the author.
export const resolveUnlockCost = async ({ targetType, currency, row = {} }) => {
  if (currency !== "coin" && currency !== "star") return null;
  const fieldOverride = currency === "coin" ? row?.unlock_cost_coins : row?.unlock_cost_stars;
  if (Number.isFinite(fieldOverride) && fieldOverride > 0) return fieldOverride;
  const config = await getAppConfig();
  const key =
    targetType === "video"
      ? currency === "coin"
        ? "default_video_unlock_coins"
        : "default_video_unlock_stars"
      : currency === "coin"
        ? "default_chapter_unlock_coins"
        : "default_chapter_unlock_stars";
  return config[key] ?? (currency === "coin" ? 1 : 1);
};

// ─────────────────────────────────────────────────────────────────────────
// Video progress (paid_through_seconds tracking)
// ─────────────────────────────────────────────────────────────────────────

// Returns how far into the video the current user has paid through.
// Used to compute the next paywall threshold on resume. Returns 0 when
// nothing has been paid (every threshold is fresh) or when the video
// id is a legacy non-UUID (Appwrite imports prefixed `aw_/sb_`). The
// UUID_RE used here is the same module-level regex declared up top.
export const getPaidThroughSeconds = async ({ videoId }) => {
  if (!videoId || !UUID_RE.test(videoId)) return 0;
  const me = await requireUser().catch(() => null);
  if (!me) return 0;
  const { data, error } = await supabase
    .from("video_progress")
    .select("paid_through_seconds")
    .eq("user_id", me.id)
    .eq("video_id", videoId)
    .maybeSingle();
  if (error) {
    console.log("[wallet-supabase] getPaidThroughSeconds error:", error.message);
    return 0;
  }
  return data?.paid_through_seconds || 0;
};

// Threshold math — given paid_through, what's the next paywall mark?
// Mirrors web's `computeNext` in setupVideoMonetGate. We expose it
// here so the mobile player can call the same function shape it
// already uses from lib/video-unlocks.js (`computeNextThresholdSeconds`).
export const computeNextThresholdSeconds = (paidThroughSeconds, { initialSec = 180, recurringSec = 600 } = {}) => {
  const paid = Math.max(0, Math.floor(Number(paidThroughSeconds) || 0));
  if (paid < initialSec) return initialSec;
  return initialSec + Math.ceil((paid - initialSec + 1) / recurringSec) * recurringSec;
};

// Helper: clear the cached app_config. Call on sign-out so the next
// signed-in user doesn't inherit stale values (rare — these almost
// never change — but cheap correctness).
export const resetWalletCaches = () => {
  _appConfigCache = null;
};
