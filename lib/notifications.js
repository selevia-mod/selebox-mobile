// lib/notifications.js — NotificationService + helpers dispatcher
//
// Routes the NotificationService class between Supabase
// (lib/notifications-supabase.js → NotificationServiceSupabase) and
// Appwrite (lib/notifications-appwrite.js → NotificationService) based
// on the USE_SUPABASE_NOTIFICATIONS feature flag.
//
// The pure helpers — parse*ResourceId and build*Params — are
// backend-agnostic (string transforms over a notification's resourceId
// field), so we re-export them from the legacy module unconditionally.
// They work identically regardless of which backend is active.
//
// Pre-flight before flipping USE_SUPABASE_NOTIFICATIONS=true:
//   1. Run Selebox/migration_notifications_unified.sql to add the
//      submit_notification + mark_*_viewed RPCs and the is_viewed
//      column.
//   2. Resource hydration is implemented in
//      notifications-supabase.js → hydrateResources (Phase 2). Bell
//      cards render thumbnails + titles + routing fields end-to-end.
//      Missing resources fall through to a generic card.
//   3. Test on dev build by flipping the flag locally — exercise post
//      like / comment, video like / comment, book / chapter comment +
//      reply, follow, dm_message in the bell panel and verify each
//      navigates to the right screen.

import { USE_SUPABASE_NOTIFICATIONS } from "./feature-flags";
import { NotificationServiceSupabase } from "./notifications-supabase";
import {
  NotificationService as NotificationServiceAppwrite,
  parseVideoNotificationResourceId,
  parsePostNotificationResourceId,
  parseBookNotificationResourceId,
  parseBookChapterNotificationResourceId,
  buildVideoNotificationNavigationParams,
  buildVideoNotificationResourceId,
  buildPostNotificationNavigationParams,
  buildPostNotificationResourceId,
  buildBookNotificationNavigationParams,
  buildBookNotificationResourceId,
  buildBookChapterNotificationNavigationParams,
  buildBookChapterNotificationResourceId,
} from "./notifications-appwrite";

// Active service implementation, swappable via the flag.
export const NotificationService = USE_SUPABASE_NOTIFICATIONS
  ? NotificationServiceSupabase
  : NotificationServiceAppwrite;

// Pure helpers — backend-agnostic. Re-exported as-is.
export {
  parseVideoNotificationResourceId,
  parsePostNotificationResourceId,
  parseBookNotificationResourceId,
  parseBookChapterNotificationResourceId,
  buildVideoNotificationNavigationParams,
  buildVideoNotificationResourceId,
  buildPostNotificationNavigationParams,
  buildPostNotificationResourceId,
  buildBookNotificationNavigationParams,
  buildBookNotificationResourceId,
  buildBookChapterNotificationNavigationParams,
  buildBookChapterNotificationResourceId,
};
