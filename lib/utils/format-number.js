/**
 * Formats a number for display: 1234567 → "1.2M", 1234 → "1.2K", 999 → "999".
 * Tolerant of undefined / null / NaN / non-numeric input — returns "0" rather
 * than crashing. Several callers (BookLibraryCard, BookInfoStats,
 * BookChapterStats) pass values that come from async fetches which can
 * legitimately be undefined while loading or on error; without this guard,
 * the call to .toString() on undefined would throw and crash the entire
 * FlatList cell.
 */
export default function FormatNumber(num) {
  // Coerce to a finite number; bail to "0" for anything else (undefined, null,
  // NaN, "abc", boolean, etc.). Using Number() here so legitimate numeric
  // strings ("123") still format correctly.
  const n = Number(num);
  if (!Number.isFinite(n)) return "0";

  if (n >= 1_000_000_000) {
    return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  } else if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  } else if (n >= 1_000) {
    return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return n.toString();
}
