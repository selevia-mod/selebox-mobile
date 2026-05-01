// Supabase-flavored book content fetcher — drop-in for lib/book-content.js.
// The legacy file just exposes a tiny helper for reading chapter content
// (the actual story text). This wraps a chapters table read.

import supabase from "./supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns the full text content of a chapter. Used by the reader screen.
export const fetchBookChapterContent = async ({ chapterId }) => {
  if (!chapterId) return null;
  const isUuid = UUID_RE.test(chapterId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data, error } = await supabase
    .from("chapters")
    .select("content, word_count, is_locked, unlock_cost_coins, unlock_cost_stars")
    .eq(column, chapterId)
    .maybeSingle();
  if (error) throw error;
  return data;
};
