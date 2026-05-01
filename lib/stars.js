// lib/stars.js — StarService dispatcher
//
// Routes between Supabase RPCs (lib/stars-supabase.js) and Appwrite
// Cloud Functions (lib/stars-appwrite.js) based on the
// USE_SUPABASE_STARS feature flag. Same pattern as lib/follows.js and
// lib/users.js — keeps the import path stable so consumers
// (useRewardedStars hook, store screen, profile pill) don't change.
//
// Pre-flight before flipping USE_SUPABASE_STARS=true:
//   1. Run Selebox/migration_ad_rewards.sql in production Supabase
//      to create the ad_rewards table + earn_star_via_ad RPC +
//      get_stars_summary RPC.
//   2. Verify the wallets table is populated for the user (the
//      `on_auth_user_created` trigger creates the wallet row, OR a
//      separate trigger on profile insert — verify the source).
//   3. Test on a dev build by flipping the flag locally.

import { USE_SUPABASE_STARS } from "./feature-flags";
import { StarServiceSupabase } from "./stars-supabase";
import { StarService as StarServiceAppwrite } from "./stars-appwrite";

export const StarService = USE_SUPABASE_STARS ? StarServiceSupabase : StarServiceAppwrite;
