// lib/story-service.js — StoryService dispatcher
//
// Routes between Supabase (lib/story-service-supabase.js) and Appwrite
// (lib/story-service-appwrite.js) based on USE_SUPABASE_STORIES.
// Same pattern as the rest of the migration dispatchers — keeps the
// import path stable so consumers don't change.
//
// Pre-flight before flipping USE_SUPABASE_STORIES=true:
//   1. Run Selebox/migration_stories.sql in production Supabase to
//      create stories / story_views / story_likes / story_stats /
//      story_music tables + the count-tracking triggers.
//   2. Verify the bunny storage paths still resolve — story media is
//      uploaded to Bunny CDN regardless of which metadata backend is
//      active (no Bunny migration needed).
//   3. (Optional) Migrate existing story rows from Appwrite. Stories
//      are 24-hour ephemeral, so the cleanest path is to let old
//      stories expire naturally and start fresh on Supabase. New
//      stories created after the flag flip land on Supabase only.
//   4. Test on dev build by flipping the flag locally.

import { USE_SUPABASE_STORIES } from "./feature-flags";
import { StoryServiceSupabase } from "./story-service-supabase";
import { StoryService as StoryServiceAppwrite } from "./story-service-appwrite";

export const StoryService = USE_SUPABASE_STORIES ? StoryServiceSupabase : StoryServiceAppwrite;
