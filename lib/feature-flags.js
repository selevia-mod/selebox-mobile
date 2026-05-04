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
 *
 * Flipped TRUE (May 2026) after pre-flight verified:
 *   • provision-supabase-auth.js created auth.users rows for all 79k+
 *     migrated profiles
 *   • supabase-auth.js code paths (signInWithPassword, signInWithIdToken
 *     for Google/Apple, recovery flow) shipped via App Store / Play Store
 *   • lib/global-settings-supabase.js replaced the Appwrite globalSettings
 *     reader so admin Settings edits propagate to mobile
 *   • RPCs accept p_actor_id fallback so even Appwrite-auth holdovers on
 *     old bundles still resolve auth.uid() via the parameter
 * Rollback: change to false and re-publish the bundle. Keep the flip on
 * Metro/localhost first to smoke-test end-to-end; only OTA after that.
 */
export const USE_SUPABASE_AUTH = true;

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
// Flipped TRUE (May 2026) as part of the all-flags cutover. Pre-flight
// per the long doc above: RPCs deployed, wallet trigger fires on profile
// insert, IAP webhook credits server-side, app_config seeded with default
// unlock costs. Testing on Metro before OTA — watch for IAP credit flow
// (skipped on Supabase mode) and HitPay webhook (Edge Function or
// "coming soon" in store screen).
export const USE_SUPABASE_WALLET = true;

/**
 * USE_SUPABASE_BOOKS
 *
 * The big one. When TRUE, the entire books stack routes through
 * Supabase — books / chapters / book_likes / book_bookmarks /
 * book_reads / book_comments / chapter_comments / chapter_inline_*
 * tables, plus the wallet `unlocks` table for paywalled content. When
 * FALSE, Appwrite remains the source of truth for all 10 book*.js
 * service files.
 *
 * Pre-flight: run Selebox/migration_books_engagement.sql to create the
 * 9 new engagement tables (book_comments, book_comment_likes,
 * chapter_comment_likes, chapter_inline_comments + threads + likes,
 * book_ratings, book_downloads, book_ranking_history) plus the count-
 * tracking triggers. The core (books, chapters, book_likes,
 * book_bookmarks, book_reads, chapter_comments) is already migrated.
 *
 * Data migration: existing comments / ratings / inline-comments live
 * on Appwrite. Flipping the flag without backfilling means historical
 * engagement is invisible (only viewable when flag is off). For a soft
 * launch this is acceptable — new engagement lands on Supabase, old
 * data fades. A formal backfill script ports historical rows when
 * needed (separate session).
 *
 * Books are 95% of Selebox content. This is the highest-risk single
 * flag flip. Test extensively on dev build with multiple test accounts
 * (read flow, write flow, comment flow, like flow, paywall flow,
 * downloads flow) before any production rollout.
 *
 * Rollback: flip back to FALSE — both code paths stay in place. New
 * comments written to Supabase between the flip and rollback would
 * become invisible until the flag flips on again. (No data loss; just
 * read-side gating.)
 */
export const USE_SUPABASE_BOOKS = true;

/**
 * USE_SUPABASE_VIDEOS
 *
 * When TRUE, VideosService methods (fetchVideos, getVideo, viewVideo,
 * etc.) and helpers (createNewVideo, createVideoLike, deleteVideoLike,
 * etc.) route through Supabase via lib/video-supabase.js. When FALSE,
 * they hit Appwrite via lib/video-appwrite.js.
 *
 * Bunny CDN: video upload/delete/transcoding paths are unchanged. The
 * Supabase wrapper proxies the Bunny methods through to the legacy
 * impl so the file storage layer is fully decoupled from the metadata
 * backend.
 *
 * Schema expectations (Supabase):
 *   videos             — id, uploader_id, title, description,
 *                        video_url, thumbnail_url, status, tags[],
 *                        duration, likes_count, views_count,
 *                        comments_count, created_at, legacy_appwrite_id
 *   video_likes        — composite PK (video_id, user_id)
 *   video_views        — composite PK (video_id, viewer_id)
 *   video_comments     — id, video_id, user_id, comment, parent_id
 *   video_comment_likes — composite PK (comment_id, user_id)
 *
 * Phase 2 work (deferred): comment threading, reply paths, comment
 * like counts, full search, and pagination cursor edge cases. The
 * scaffold returns an empty result for unimplemented helpers so the
 * UI degrades gracefully without crashing.
 *
 * Rollback: flip back to FALSE — both code paths stay in place.
 */
// Flipped TRUE (May 2026) as part of the all-flags Metro test cutover.
// Phase 1 (read + view + like) is fully wired; Phase 2 features
// (comment threading, reply paths, comment likes, search edge cases)
// return empty results gracefully — UI degrades without crashing per
// the doc above. Watch for those during smoke testing; if any are
// blocking, complete that Phase 2 wiring before OTA.
export const USE_SUPABASE_VIDEOS = true;

/**
 * USE_SUPABASE_NOTIFICATIONS
 *
 * When TRUE, NotificationService methods (fetchNotifications,
 * getUnreadCount, markAllAsRead, markAsRead, markAsViewed,
 * markAllAsViewed, notifyUser, notifyFollowers) route through Supabase
 * via lib/notifications-supabase.js. When FALSE, they hit the legacy
 * Appwrite notificationCollection via lib/notifications-appwrite.js.
 *
 * Pre-flight (already shipped):
 *   • migration_notifications_unified.sql — submit_notification RPC,
 *     mark_*_viewed RPCs, is_viewed column.
 *   • Phase 2 hydration in lib/notifications-supabase.js — actor profiles,
 *     conversations, AND target resources (post / video / book /
 *     chapter) hydrated in parallel so bell cards render thumbnails +
 *     titles + routing fields end-to-end.
 *   • migration_notifications_triggers.sql — Postgres triggers on
 *     reactions / comments / follows that auto-fire submit_notification.
 *     Both platforms generate notifications now without app code calls.
 *   • Mobile dual-write in lib/notifications-appwrite.js — every
 *     notifyUser / notifyFollowers also writes to Supabase, so even
 *     during the rollout phase no notifications get lost.
 *
 * Source-of-truth: with this flag TRUE, mobile reads Supabase
 * notifications. The Appwrite collection still receives writes from
 * the dual-write but stops being read; it's now a dead-letter store
 * we can decommission once we've soaked this in production for a
 * release cycle.
 *
 * The dm_message (chat) path is fully functional under either flag —
 * it has its own dedicated RPCs already.
 *
 * Rollback: flip back to FALSE — both code paths stay in place. Web
 * is unaffected (always reads Supabase). Mobile re-reads Appwrite which
 * the dual-write has been keeping current the whole time.
 */
export const USE_SUPABASE_NOTIFICATIONS = true;

/**
 * USE_SUPABASE_STORIES
 *
 * When TRUE, StoryService methods (fetchStories, fetchStoriesGrouped,
 * createStory, deleteStory, createView, likeStory, unlikeStory, etc.)
 * route through Supabase via lib/story-service-supabase.js. When FALSE,
 * they hit the legacy Appwrite collections (stories /
 * storiesViewsCollectionId / storiesLikesCollectionId /
 * storiesStatsCollectionId / storyMusicCollectionId) via
 * lib/story-service-appwrite.js.
 *
 * Pre-flight: run Selebox/migration_stories.sql in Supabase first.
 *
 * Stories are 24-hour ephemeral — no historical data migration is
 * required. Letting old stories expire on Appwrite while new ones land
 * on Supabase is the cleanest cutover.
 *
 * Bunny CDN: story media (image/video) continues to upload to Bunny
 * regardless of metadata backend.
 *
 * Rollback: flip back to FALSE — both code paths stay in place.
 */
// Flipped TRUE (May 2026) as part of the all-flags Metro cutover.
// migration_stories.sql deployed. Stories are 24-hour ephemeral so
// no historical migration is required — old Appwrite stories will
// expire naturally while new ones land on Supabase.
export const USE_SUPABASE_STORIES = true;

/**
 * USE_SUPABASE_STARS
 *
 * When TRUE, the StarService methods (earnStar, getStars, updateStars)
 * route through Supabase RPCs (earn_star_via_ad, get_stars_summary)
 * via lib/stars-supabase.js. When FALSE, they hit the legacy Appwrite
 * Cloud Functions via lib/stars-appwrite.js.
 *
 * Pre-flight: run Selebox/migration_ad_rewards.sql before flipping. It
 * creates the ad_rewards table + the two RPCs the Supabase impl calls.
 *
 * Anti-abuse: the daily ad cap (10/day) is enforced server-side in
 * earn_star_via_ad — clients can't bypass it.
 *
 * Rollback: flip back to FALSE — both code paths stay in place. The
 * Appwrite Cloud Functions keep running and can credit stars in
 * parallel (same wallet table) if you ever need to dual-write.
 */
// Flipped TRUE (May 2026). migration_ad_rewards.sql deployed,
// earn_star_via_ad + get_stars_summary RPCs in place. The 10/day cap
// is enforced server-side in earn_star_via_ad — no client bypass.
// Watch for the JWT path: account.createJWT (Appwrite) is no longer
// called when this is true — earn_star_via_ad uses auth.uid()
// directly via the standard Supabase auth header.
export const USE_SUPABASE_STARS = true;

/**
 * USE_SUPABASE_USERS
 *
 * When TRUE, user-profile lookups (getUserByID, searchUsers,
 * FetchAllCreators, pingUserActive) route through Supabase's
 * `profiles` table via lib/users-supabase.js. When FALSE, they hit
 * Appwrite's userCollection via lib/users.js's original implementation.
 *
 * Compatible with USE_SUPABASE_AUTH=false (today's default) — the
 * Supabase reader accepts either Appwrite hex IDs or Supabase UUIDs
 * and queries the right column (id or legacy_appwrite_id).
 *
 * Heads-up: uses profiles.last_active_at for the pingUserActive call.
 * If that column doesn't exist on profiles, the ping silently no-ops
 * (logged warning, not load-bearing). Add the column with:
 *   alter table profiles add column if not exists last_active_at timestamptz;
 *
 * Rollback: flip back to FALSE — both code paths stay in place. No
 * data loss either way.
 */
// Flipped TRUE after pre-flight verified:
//   • 78,994 profiles (matches user base)
//   • 610 web-native signups (0.77%) lack legacy_appwrite_id — fine, they
//     have profile rows so mobile-via-Supabase still surfaces them
//   • profiles.location + profiles.website columns exist (verified)
//   • profiles.last_active_at column added (presence ping target)
// Rollback: change to false and re-publish the bundle. Both code paths
// stay in place under either value.
export const USE_SUPABASE_USERS = true;

/**
 * USE_SUPABASE_FOLLOWS
 *
 * When TRUE, the FollowService methods (followUser, unfollowUser,
 * isFollowing, getFollowRelations, getFollowers, getFollowing,
 * getFollowersCount, getFollowingCount, getMutualFollows) route through
 * Supabase's `follows` table via lib/follows-supabase.js. When FALSE,
 * they hit Appwrite's followsCollection via lib/follows.js.
 *
 * The Supabase `follows` table is already populated by the migration
 * tool (Selebox/migrate.html) and used by the feed_for_you /
 * feed_discover RPCs. Both surfaces converge on the same row whichever
 * way we flip this.
 *
 * ID resolution:
 *   Under USE_SUPABASE_AUTH=false (today's default), user.$id is an
 *   Appwrite hex. follows-supabase.js calls resolveSupabaseUserId() to
 *   look up profiles.legacy_appwrite_id and convert hex → UUID before
 *   touching the follows table.
 *
 *   Under USE_SUPABASE_AUTH=true, user.$id IS already the UUID, so the
 *   resolver fast-paths.
 *
 * Rollback: flip back to FALSE — both code paths stay in place. No
 * data loss either way; both backends hold the same set of follows.
 */
// Flipped TRUE (May 2026). The Supabase follows table is the source
// of truth used by feed_for_you / feed_discover RPCs already; the data
// is replicated. Under USE_SUPABASE_AUTH=true (now the case),
// user.$id is the Supabase UUID directly, so resolveSupabaseUserId()
// fast-paths and the legacy hex → UUID lookup is bypassed.
export const USE_SUPABASE_FOLLOWS = true;

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
