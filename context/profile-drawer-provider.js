// context/profile-drawer-provider.js
//
// Lifts the FB-style profile drawer's open/close state OUT of
// MainScreensHeader and UP to the (tabs) layout level. Why this
// matters: with the drawer state inside the per-tab header, the
// modal had to physically close (animateOut → unmount) before any
// router.push fired, then reopen (mount → animateIn) on back. That
// close/reopen round-trip was the source of the perceived "lag" on
// back / swipe-back from drawer-pushed routes (Community, Payments,
// Supporter Leaderboard, etc.).
//
// The fix is structural, not animation-tuning: keep the drawer's
// React component MOUNTED across the round-trip, with isVisible=true
// throughout. We achieve that by:
//   1. Storing open-state here (lives at (tabs) layout level, never
//      unmounts during destination push).
//   2. Rendering ProfileMenuModal once at the (tabs) layout level
//      with `coverScreen={false}` — that switches react-native-modal
//      from a top-level native overlay (which would float on top of
//      pushed destinations, looking broken) to an inline absolute
//      View bound to the (tabs) layout's render tree. When (tabs)
//      gets covered by /(community), the drawer is naturally hidden
//      with it. When the user pops back, (tabs) is visible again and
//      so is the still-open drawer — no animation, no flag, no race.
//
// Lifecycle:
//   • DrawerProvider mounts at (tabs) layout. State persists across
//     home/books/videos tab swaps, across drawer round-trips, and
//     across tab → destination → tab navigation.
//   • DrawerProvider unmounts when (tabs) layout itself unmounts
//     (e.g. on logout / app exit). State is gone, which is correct —
//     a fresh login starts with a closed drawer.
//
// Usage:
//   • Wrap (tabs)/_layout.jsx's return in <ProfileDrawerProvider>.
//   • Render <ProfileMenuModal /> once inside the provider, reading
//     `open` from the hook.
//   • In MainScreensHeader, replace `useState(false)` with
//     `useProfileDrawer()` and call `setOpen(true)` on avatar tap.
//
// Logout: the consumer (MainScreensHeader's handleLogout) should
// still call setOpen(false) before signOut() so the drawer closes
// before the redux state flips and the (tabs) layout unmounts —
// otherwise the drawer animateOut runs against a tearing-down tree.

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

const ProfileDrawerContext = createContext({
  open: false,
  setOpen: () => {},
});

export const ProfileDrawerProvider = ({ children }) => {
  const [open, setOpenState] = useState(false);

  // Stable setter so consumers don't re-render on every parent
  // re-render. The drawer's open state is hot — toggled per
  // avatar tap + per backdrop tap — and the consumer is the
  // MainScreensHeader of every active tab, so we want minimum
  // identity churn here.
  const setOpen = useCallback((next) => {
    setOpenState((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);

  return <ProfileDrawerContext.Provider value={value}>{children}</ProfileDrawerContext.Provider>;
};

export const useProfileDrawer = () => useContext(ProfileDrawerContext);
