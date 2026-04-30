import { storage } from "../store/storage";

// Local-only history of recent search queries. Capped at MAX_RECENT entries.
// Survives app restart (MMKV is persisted), wiped only when user taps Clear all.
const RECENT_SEARCHES_KEY = "selebox:recent-searches";
const MAX_RECENT = 10;

const safeParse = (raw) => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === "string" && q.trim().length > 0) : [];
  } catch {
    return [];
  }
};

export const getRecentSearches = () => {
  return safeParse(storage.getString(RECENT_SEARCHES_KEY));
};

export const addRecentSearch = (query) => {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return;
  const existing = getRecentSearches();
  const filtered = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...filtered].slice(0, MAX_RECENT);
  storage.set(RECENT_SEARCHES_KEY, JSON.stringify(next));
};

export const removeRecentSearch = (query) => {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return;
  const existing = getRecentSearches();
  const next = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  storage.set(RECENT_SEARCHES_KEY, JSON.stringify(next));
};

export const clearRecentSearches = () => {
  storage.delete(RECENT_SEARCHES_KEY);
};
