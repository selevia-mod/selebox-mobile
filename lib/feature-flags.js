// Feature flags — toggle in-progress migrations safely.
//
// Pattern:
//   - Each flag defaults to FALSE so existing behavior is preserved.
//   - Code paths for both old + new live in the bundle simultaneously.
//   - Flipping a flag from false → true is a one-line OTA push.
//   - Rollback is also one OTA push if the new path misbehaves.
//   - Once a flag has been TRUE in production for a release or two, the
//     old path can be deleted in a cleanup OTA and the flag retired.
//
// Why this beats env-var or remote-config flags for a migration:
//   - No extra dependency or fetch on app boot (no waiting on a remote
//     toggle to settle before sign-in renders).
//   - Source-controlled — the flag's state is part of git history, easy
//     to bisect when something breaks.
//   - Cheap to ship — a one-line diff via `eas update --branch main`.
//
// Conventions:
//   - SCREAMING_SNAKE_CASE constants
//   - One-line jsdoc explaining the flag and what flipping it does
//   - When you delete a flag, search the codebase for its name and
//     remove every gated branch + this constant in the same commit.

/**
 * USE_SUPABASE_AUTH
 *
 * When TRUE, the sign-in / sign-up / forgot-password / reset-password screens
 * AND global-provider's session bootstrap all run against Supabase Auth
 * (lib/supabase-auth.js). When FALSE, they use Appwrite (lib/appwrite.js)
 * exactly as before.
 *
 * Status (after B.2 + B.3 + B.4): code paths exist, flag is FALSE in
 * production. Before flipping to TRUE you must:
 *   1. Run scripts/migrate-auth-users.js against production with the
 *      Appwrite users export so existing users can sign in with their
 *      existing passwords.
 *   2. Verify the chat (USE_SUPABASE_CHAT) story — when this flag is on,
 *      the user object's `$id` is a Supabase UUID, which the Stream Chat
 *      code path doesn't recognize. Either flip USE_SUPABASE_CHAT on at
 *      the same time (recommended) or accept that DMs are broken for
 *      users on the new auth path until the chat UI port lands.
 *   3. Smoke-test on a dev build by flipping locally + signing in as a
 *      few migrated users (email/password + Google + Apple).
 *
 * Flip is a one-line OTA. Rollback is also a one-line OTA.
 */
export const USE_SUPABASE_AUTH = false;

/**
 * USE_SUPABASE_POSTS
 *
 * When TRUE, ALL post-feed reads (Discover, Following, For-You, profile
 * Posts tab) AND interactive likes / comments / reposts route through
 * Supabase via `lib/posts-supabase.js`, `lib/reactions-supabase.js`, and
 * `lib/comments-supabase.js`. When FALSE, posts read + write through
 * Appwrite as before. The shape adapter maps Supabase rows into the
 * Appwrite-shaped objects existing PostCard / PostInformation /
 * PostCommentModal expect, so the UI doesn't have to fork.
 *
 * Status (Phase C.10 — production cross-platform):
 *   - Discover tab read + pagination: ✅ Supabase
 *   - Following tab read + pagination: ✅ Supabase (filtered by follows)
 *   - For-You tab: ✅ Supabase (recency-ordered global feed; the
 *     personalization recommender will be re-introduced server-side)
 *   - Profile Posts tab: ✅ Supabase (via fetchPostsByUser)
 *   - Repost rendering + creating: ✅ Supabase (RepostModal + PostCard
 *     dual-section render)
 *   - Interactive likes (toggle + emoji change): ✅ Supabase reactions
 *     (PostInformation + comment likes both wired)
 *   - Interactive comments (load, post, reply, delete): ✅ Supabase
 *     comments (PostCommentModal branched)
 *   - Realtime feed updates: ❌ still focus / pull-to-refresh only
 *   - Push notifications for post-comments / mentions: ❌ skipped on
 *     Supabase posts (mobile's NotificationService writes to Appwrite;
 *     web's Supabase notification stack is the next phase)
 *
 * What this flip means for cross-platform parity:
 *   - A post created on web is visible to mobile users (and vice versa)
 *     across Discover / Following / profile views.
 *   - A like or comment on either platform shows up on the other.
 *   - A repost on either platform threads back to the original.
 *
 * Rollback: flipping back to FALSE is safe — the Appwrite code paths
 * are still in place; users who interacted with Supabase posts would
 * lose those interactions visually until the flag is flipped back on
 * (data isn't lost, just hidden behind the legacy reader).
 */
export const USE_SUPABASE_POSTS = true;

/**
 * USE_SUPABASE_WALLET
 *
 * When TRUE, mobile reads/writes the user's coin + star balance
 * through Supabase's `wallets` table (lib/wallet-supabase.js) and
 * routes content unlocks through the `unlock_content` /
 * `unlock_video_threshold` / `unlock_book_bulk` RPCs. Author
 * earnings + withdrawals route through Supabase's
 * `author_earnings` / `author_withdrawals` tables.
 *
 * When FALSE, the legacy paths run:
 *   - coins via Appwrite `coins` collection
 *   - stars via two Appwrite Cloud Functions (earnStar / getStars)
 *   - unlocks via the `unlockVideo` Cloud Function +
 *     `unlockedVideos` Appwrite collection
 *   - earnings/withdrawals via Appwrite collections
 *
 * Code wiring status (Phase F.1–F.8 + audit fixes):
 *   ✅ lib/wallet-supabase.js + lib/earnings-supabase.js
 *   ✅ global-provider snapshot + realtime subscription (INSERT + UPDATE)
 *   ✅ video unlock paths (useAutoUnlock branched, RPC errors surface)
 *   ✅ chapter unlock modal (UUID-shape gated, falls back when books
 *      are still on Appwrite IDs)
 *   ✅ useEarnings hook (server-authoritative balance via
 *      author_balance_for + adds back paid withdrawals; integer-cent
 *      math throughout)
 *   ✅ store IAP gated (Appwrite write skipped under Supabase mode)
 *
 * BACKEND PRE-FLIGHT — required before flipping to TRUE:
 *   1. Supabase RPCs deployed and accessible to authenticated users:
 *        unlock_content, unlock_video_threshold, unlock_book_bulk,
 *        author_balance_for, request_author_withdrawal, submit_author_kyc.
 *   2. `wallets` row trigger fires on profile insert (so new users
 *      get a row before their first read).
 *   3. iOS StoreKit + Android Play Billing webhook credits
 *      `wallets.coin_balance` server-side (the IAP path skips the
 *      legacy Appwrite write under this flag).
 *   4. Android HitPay webhook endpoint migrated from
 *      `673a3a1162eb53830d78.appwrite.global` to a Supabase Edge
 *      Function (or HitPay flow disabled — store.jsx surfaces a
 *      "coming soon" alert in the meantime).
 *   5. `app_config` table populated with default unlock costs
 *      (default_video_unlock_coins / _stars,
 *      default_chapter_unlock_coins / _stars, plus the author_*
 *      hold + min payout keys).
 *
 * Known soft constraint:
 *   Books (and their chapters) haven't been migrated to Supabase yet
 *   — they still have Appwrite-shape 24-char hex IDs. The chapter
 *   unlock modal detects this at runtime and falls back to the
 *   legacy Appwrite path so users can still unlock chapters when
 *   the wallet flag is flipped on. Once books migrate to Supabase,
 *   that fallback becomes dead code and can be removed.
 *
 * Flipping this flag in production with all wiring + pre-flight
 * complete gives us:
 *   - cross-platform balance parity (web + mobile read the same row)
 *   - server-authoritative unlocks (no client-side billing math)
 *   - realtime balance updates (one Postgres CHANGE event = both
 *     platforms re-render)
 *   - integer-cent earnings totals (no floating-point drift)
 *
 * The `useEffect` dep array in global-provider includes this flag
 * so an OTA bundle that flips it re-mounts the realtime subscription
 * on the next bundle reload — already-signed-in users get a seamless
 * upgrade without needing to sign out.
 *
 * Rollback is one-line — both code paths stay in place.
 */
export const USE_SUPABASE_WALLET = false;

/**
 * USE_SUPABASE_CHAT
 *
 * The chat tab is now Supabase-native. Stream Chat is gone — this flag is
 * left in place as a kill-switch in case we need to curtain chat off again
 * during a future incident, but defaults to TRUE so the chat tab is always
 * functional.
 *
 * Behavior when TRUE (default):
 *   - The chat tab routes through SupabaseConversationsList / SupabaseThread /
 *     SupabaseNewChat, all reading from lib/messages-supabase.js.
 *   - Users with a Supabase session see their conversations + can chat in
 *     real-time with web users on the same `conversations` / `messages`
 *     tables.
 *   - Users without a Supabase session yet (still on Appwrite auth) see a
 *     friendly "Chat is now on the new system — sign in to use it" empty
 *     state. No crash, no maintenance mode.
 *
 * Behavior when FALSE:
 *   - Falls back to whatever the (message) screens render outside the
 *     Supabase branch. Currently that's Stream Chat code paths, which are
 *     mostly dead. Flipping false is a temporary curtain, not a permanent
 *     state.
 */
export const USE_SUPABASE_CHAT = true;
