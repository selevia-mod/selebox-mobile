// lib/profile-drawer-state.js
//
// Module-level "should reopen profile drawer on next tab focus" flag.
// Used by ProfileMenuModal.go() so a user can: open drawer → tap menu
// item (Supporter Leaderboard, Payments, Community, …) → land on the
// destination → tap back → land on the original tab WITH the drawer
// re-opened. Mirrors FB Lite / Lemon8 drawer-as-shelf UX, where the
// drawer feels like a persistent shelf the user is "pulling things
// off of" rather than a one-shot menu that disappears on first tap.
//
// Implemented as a singleton module variable rather than React state
// because the drawer's `profileMenuOpen` lives inside MainScreensHeader,
// which is mounted *per tab* (home / videos / books each render their
// own MainScreensHeader). There is no shared parent that could hold a
// React state crossing the navigation boundary, and this flag is only
// ever read once per round-trip — `consumeReopenFlag` clears it on
// read so a stale flag from a previous interaction can't accidentally
// re-trigger a reopen later.
//
// Lifetime: in-memory only. We deliberately do NOT persist across app
// launches — the drawer should only reopen when the user is actively
// in the same navigation flow (drawer-tap → screen → back), not days
// later when they relaunch the app.

let shouldReopen = false;

// Set when the user taps a drawer menu item. Pairs with a one-shot
// router.navigate to the destination. The next MainScreensHeader to
// regain focus will read & clear the flag and reopen its drawer.
export const markReopenOnReturn = () => {
  shouldReopen = true;
};

// Read-and-clear. Returns true exactly once per markReopenOnReturn
// call, so only the first focused header reopens its drawer (avoiding
// duplicate reopens if the user rapidly switches tabs after coming
// back from a destination screen).
export const consumeReopenFlag = () => {
  const v = shouldReopen;
  shouldReopen = false;
  return v;
};

// Test helper / hard reset — not used in production, but useful for
// component tests that want a known starting state.
export const resetReopenFlag = () => {
  shouldReopen = false;
};
