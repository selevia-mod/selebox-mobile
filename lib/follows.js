// lib/follows.js — FollowService dispatcher
//
// This file routes the FollowService API to either the Supabase-backed
// implementation (lib/follows-supabase.js) or the legacy Appwrite-backed
// implementation (lib/follows-appwrite.js), based on the
// USE_SUPABASE_FOLLOWS feature flag.
//
// Why a dispatcher and not just-rename-the-file:
//   ~9 consumers across the app import FollowService from "./follows".
//   Touching all of them at once is a coordinated risk we don't need to
//   take. Instead we keep the import path stable and swap the impl at
//   the leaf, so the migration ships in two stages:
//     1. Land the Supabase impl + dispatcher (this file). No behavior
//        change because the flag is false.
//     2. Flip the flag → consumers transparently switch backends.
//   Rollback is the same one-line OTA.
//
// What stays the same regardless of which impl is active:
//   • `FollowService` class with the same static methods
//   • `getUserId(value)` helper export
//   • Return shapes (Appwrite-shaped legacy aliases on every row)

import { USE_SUPABASE_FOLLOWS } from "./feature-flags";
import {
  FollowServiceSupabase,
  getUserId as getUserIdSupabase,
} from "./follows-supabase";
import {
  FollowService as FollowServiceAppwrite,
} from "./follows-appwrite";

export const FollowService = USE_SUPABASE_FOLLOWS
  ? FollowServiceSupabase
  : FollowServiceAppwrite;

// `getUserId` exists in both impls — they're functionally identical
// shape extractors, so we just re-export the Supabase one (it's
// behaviorally the same as the Appwrite one).
export { getUserIdSupabase as getUserId };
