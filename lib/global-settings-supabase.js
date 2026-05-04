// lib/global-settings-supabase.js — global settings reader (Supabase).
//
// Replaces the Appwrite globalSettings collection bootstrap with a single
// read against public.app_config. Returns the SAME shape the legacy
// `getGlobalSettings()` returned (array of { name, value } objects)
// so global-provider.js's loadGlobalSettings doesn't need to change.
//
// Why this exists
// ───────────────
// Mobile bootstraps a `globalSettings` dict on session start. Every
// consumer (chapter unlock costs, withdrawal min, ad intervals, etc.)
// reads from the dict via `globalSettings[KEY]`. Until now that dict
// was sourced from Appwrite — meaning when an admin edited a value
// in the new Settings UI (which writes to Supabase app_config), mobile
// users couldn't see the change without sign-out / sign-in.
//
// With this file in place, mobile reads the same source-of-truth the
// admin UI writes to. A rate change on Settings tab → next mobile
// session bootstrap picks it up. No more silent drift between web
// admin and mobile reads.
//
// Value shape
// ───────────
// Every row's `value` column is stored as text in app_config (e.g.
// "0.2", "20", "[\"Romance\"]"). Consumers already parse with
// `Number(globalSettings["KEY"])` / `JSON.parse(...)` at the call site,
// matching what they did when the source was Appwrite. So returning
// the raw text value here keeps every consumer working without changes.
//
// Defensive fallback: if a row's `value` is null/empty but `value_int`
// is populated (rare — only happens on hand-edited rows that bypassed
// the dual-write logic in admin.js saveSettingValue), we cast
// value_int to string so the dict still surfaces a usable value
// instead of an empty string the consumer would parse as NaN.

import supabase from "./supabase";

// Legacy-key aliases. Mobile code reads these names (the original
// Appwrite-shape keys), but the canonical Supabase app_config rows live
// under different names because we deliberately consolidated to ONE
// source of truth during the May 2026 earnings overhaul. Mapping these
// aliases here means:
//   • app_config has a single canonical row per concept (no dual-write
//     burden on admin edits)
//   • mobile reads under its expected key still resolve to the correct
//     value without code changes
//   • the alias is one-directional — admin edits the canonical key, the
//     legacy alias is auto-derived on every getGlobalSettings call
//
// When mobile is fully ported off the legacy names (all reads switched
// to `default_chapter_unlock_coins` etc.), this alias map can be deleted.
const LEGACY_ALIASES = {
  // Chapter unlock costs — canonical names live with the wallet schema
  BOOKS_CHAPTER_COIN_PRICE: "default_chapter_unlock_coins",
  BOOKS_CHAPTER_STAR_PRICE: "default_chapter_unlock_stars",
  // Profile bio limit — hotfix migration backfilled the lowercase name
  PROFILE_BIO_MAX_CHARACTERS: "max_bio_characters",
};

export const getGlobalSettings = async () => {
  const { data, error } = await supabase
    .from("app_config")
    .select("key, value, value_int, value_type");
  if (error) throw error;

  const rows = (data || []).map((row) => {
    const isNumber = row.value_type === "number";
    const textIsEmpty = row.value == null || row.value === "";
    const value =
      isNumber && textIsEmpty && row.value_int != null
        ? String(row.value_int)
        : row.value ?? "";
    return { name: row.key, value };
  });

  // Build a lookup so we can derive legacy-name values from the canonical
  // rows. Aliases are only added when the canonical row exists AND the
  // legacy name isn't already in the data (admin could in theory create
  // a row under the legacy name later — we don't want to overwrite that).
  const byKey = new Map(rows.map((r) => [r.name, r.value]));
  for (const [legacyName, canonicalName] of Object.entries(LEGACY_ALIASES)) {
    if (!byKey.has(legacyName) && byKey.has(canonicalName)) {
      rows.push({ name: legacyName, value: byKey.get(canonicalName) });
    }
  }

  return rows;
};
