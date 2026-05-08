// Supabase-flavored StarService — drop-in replacement for lib/stars.js
// during the Appwrite → Supabase migration.
//
// What this replaces:
//   The legacy Cloud Functions in lib/stars.js:
//     • EARN_STAR_API   (https://68cefb...appwrite.run)
//     • GET_STARS_API   (https://68d173f5...appwrite.run)
//     • Direct Appwrite document writes for updateStars
//
// Replaced by Supabase RPCs (see Selebox/migration_ad_rewards.sql):
//   • earn_star_via_ad()      → credits +1 star, enforces daily cap,
//                                returns { stars, ads_watched_today, ... }
//   • get_stars_summary()     → reads star balance + today's ad count
//
// Daily cap is enforced server-side (currently 10 ads/day, hardcoded
// in the SQL function). Mobile clients can't bypass it — the cap check
// is in the SECURITY DEFINER function, not in RLS.
//
// Return shape:
//   The legacy Cloud Function returned camelCase keys:
//     { stars, adsWatchedToday, lastWatchedDate }
//   The Supabase RPC returns snake_case:
//     { stars, ads_watched_today, last_watched_at }
//   This wrapper translates so existing consumers (useRewardedStars)
//   keep using the old field names without changes.

import supabase from "./supabase";

// Translate the Supabase RPC response into the Appwrite-shaped
// response that legacy consumers (useRewardedStars hook, store screen
// pill) read. Keeps the same field names so we don't have to fork the
// hook code.
const translateResponse = (rpcData) => {
  // Daily cap field naming history:
  //   Appwrite Cloud Function returned `maxAdsPerDay` (and the store
  //   screen still reads it under that name). The Supabase RPC returns
  //   `daily_cap`. Without translating BOTH names, `dailyLimit` ends
  //   up 0 in the consumer — which silently disables the rewarded-ad
  //   button at the UI layer. Emitting both keys keeps legacy
  //   consumers working unchanged AND lets new code prefer dailyCap.
  if (!rpcData || rpcData.ok === false) {
    const cap = rpcData?.daily_cap ?? 10;
    return {
      stars: 0,
      adsWatchedToday: 0,
      lastWatchedDate: null,
      dailyCap: cap,
      maxAdsPerDay: cap,
      error: rpcData?.error || null,
    };
  }
  const cap = rpcData.daily_cap ?? 10;
  return {
    stars: rpcData.stars ?? 0,
    adsWatchedToday: rpcData.ads_watched_today ?? 0,
    // The legacy field is `lastWatchedDate` (a date string) but the
    // Supabase RPC returns a timestamptz. Either is fine for the UI's
    // "watched X seconds ago" rendering — we pass through the timestamp
    // as a string since the consumer just displays it.
    lastWatchedDate: rpcData.last_watched_at || null,
    dailyCap: cap,
    maxAdsPerDay: cap,
  };
};

// Translate raw Postgres / supabase-js / network errors into copy that
// won't terrify a user. The default UI path
// (useRewardedStars → Alert.alert("Error", err.message)) shows whatever
// `.message` we set here verbatim, so every branch needs to be
// human-readable.
//
// We key off Postgres SQLSTATE codes (5-char alphanumeric, on
// `err.code`) when present, because the message strings differ between
// PG versions and aren't reliable to pattern-match. The supabase-js
// PostgrestError shape is `{ message, code, details, hint }`.
//
// The specific case that motivated this helper: the `ad_rewards`
// table has a FK on profiles(id), and migrated users (whose
// auth.users.id ≠ profiles.id) used to hit
//   23503: insert or update on table "ad_rewards" violates foreign
//          key constraint "ad_rewards_user_id_fkey"
// The SQL canonicalization migration
// (2026-05-09_stars_rpcs_canonicalize_user_id.sql) fixes the root
// cause, but if it ever regresses (or the RPC is somehow called for a
// pre-migration user before the patch is deployed), the user sees
// friendly copy instead of the raw constraint name.
const friendlyStarError = (err) => {
  const code = err?.code;
  const rawMsg = String(err?.message || "");

  // Postgres FK violation. The classic ad_rewards FK case.
  if (code === "23503" || /foreign key/i.test(rawMsg)) {
    return new Error(
      "Couldn't credit your star — your account needs a quick refresh. Please sign out and sign back in, then try again.",
    );
  }
  // RLS rejection — server policy denied the write. Usually means the
  // session expired mid-call.
  if (code === "42501" || /row-level security|permission denied/i.test(rawMsg)) {
    return new Error("Your session needs a refresh. Please sign in again and tap the ad once more.");
  }
  // Unique-constraint violation — extremely unlikely on this RPC since
  // the upsert handles it, but defensive.
  if (code === "23505") {
    return new Error("That ad already counted — try again in a few seconds.");
  }
  // Network / fetch failed (no `.code`, message often "Network request
  // failed" or "fetch failed").
  if (/network|fetch failed|failed to fetch|timeout/i.test(rawMsg)) {
    return new Error("Network hiccup — check your connection and try again.");
  }
  // Generic fallback. Don't leak the raw Postgres message.
  return new Error("Couldn't add the star — try again in a moment.");
};

export const StarServiceSupabase = {
  // earnStar — called after a rewarded interstitial ad finishes. Credits
  // +1 star to the current user's wallet, enforced by the server-side
  // daily cap. Returns the same shape the legacy Cloud Function did.
  //
  // The Appwrite version accepted a `userId` arg but ignored it (the
  // Cloud Function used the JWT). We accept it for API parity but it's
  // unused here — the RPC reads auth.uid() server-side.
  //
  // Error handling: the hook (useRewardedStars) does
  // `Alert.alert("Error", err.message)`, so any error we throw becomes
  // user-visible text. Translate raw Postgres errors (FK violations,
  // RLS rejections, etc.) into friendly copy here — never let the
  // bare `error.message` from supabase-js reach the UI. Earlier the
  // FK violation on ad_rewards surfaced as the literal string
  // "insert or update on table 'ad_rewards' violates foreign key
  // constraint 'ad_rewards_user_id_fkey'" which is incomprehensible
  // to users.
  earnStar: async (_userId) => {
    try {
      const { data, error } = await supabase.rpc("earn_star_via_ad");
      if (error) throw error;
      if (data?.ok === false) {
        // Server returned a structured failure (daily cap, not signed
        // in, etc.). Map the known codes to friendly copy.
        const msg =
          data.error === "daily_cap_reached"
            ? "You've reached today's star limit. Come back tomorrow!"
            : data.error === "not_signed_in"
              ? "Please sign in to earn stars."
              : "Couldn't add the star — try again in a moment.";
        const friendly = new Error(msg);
        friendly.code = data.error;
        throw friendly;
      }
      return translateResponse(data);
    } catch (err) {
      console.error("[stars-supabase] earnStar failed:", err?.message);
      // If we already produced a friendly error above (has a `code`
      // we set), pass it through unchanged.
      if (err?.code && typeof err.code === "string" && !/^[0-9A-Z]{5}$/.test(err.code)) {
        throw err;
      }
      // Otherwise it's a raw Postgres / network error. Translate.
      throw friendlyStarError(err);
    }
  },

  // getStars — read-only. One-call summary for the topbar pill.
  getStars: async () => {
    try {
      const { data, error } = await supabase.rpc("get_stars_summary");
      if (error) throw error;
      if (data?.ok === false) {
        // Not signed in or similar — return zeros so the pill renders
        // a deterministic 0 instead of crashing.
        return {
          stars: 0,
          adsWatchedToday: 0,
          lastWatchedDate: null,
          dailyCap: data?.daily_cap ?? 10,
        };
      }
      return translateResponse(data);
    } catch (err) {
      console.error("[stars-supabase] getStars failed:", err?.message);
      // Same translation discipline as earnStar — the topbar pill's
      // error path can surface this string. Don't leak the raw
      // Postgres / network message.
      throw friendlyStarError(err);
    }
  },

  // updateStars — admin/internal: directly set a user's star balance.
  // The legacy version did a direct Appwrite document update; the
  // Supabase version is a simple wallets.upsert. Used in places like
  // award flows where we credit stars outside the normal ad path.
  //
  // Accepts a Supabase UUID as `userStarId` (the Appwrite version took
  // an Appwrite hex ID but no caller actually does that today — the
  // calls all flow through hooks that hand us a Supabase user id).
  updateStars: async (userStarId, stars) => {
    if (!userStarId) throw new Error("updateStars requires a user id");
    try {
      const { data, error } = await supabase
        .from("wallets")
        .upsert(
          { user_id: userStarId, star_balance: stars, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        )
        .select()
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      console.error("[stars-supabase] updateStars failed:", err.message);
      throw err;
    }
  },
};
