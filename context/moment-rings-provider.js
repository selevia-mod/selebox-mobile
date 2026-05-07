// context/moment-rings-provider.js
//
// Tracks which users — that the SIGNED-IN viewer follows — currently
// have an active (24h) Moment. Surfaces a hook used by avatar
// renderers to apply the Instagram/FB-style purple "story ring"
// around the avatar.
//
// Visibility rule (per user requirement, May 2026):
//   • Viewer follows User X AND User X has an active Moment
//     → User X's avatar shows the ring everywhere it renders.
//   • Viewer does NOT follow User X (even if X has a Moment)
//     → no ring. Their Moment is still discoverable through the
//       home strip's discover section but their avatar elsewhere
//       (post cards, notifications, profile pages, etc.) stays
//       unringed.
//
// We also include the signed-in user's own ID in the ring set when
// they have an active Moment — natural so your own avatar everywhere
// in the app reflects your active-story state.
//
// Population:
//   StoryBar.jsx is the single writer. After each successful load
//   (which already fetches followings + own active stories), it calls
//   setMomentRings([...followingUserIds, ownUserIdIfActive]). That's
//   the same data + same TTL cache as the home strip, so the ring is
//   always in sync with the strip without a second network round-trip.
//
// Reads:
//   useMomentRing(userId): boolean — tells avatars whether to ring.
//   Pure O(1) Set lookup, safe to call from any render.

import { createContext, useCallback, useContext, useMemo, useState } from "react";

const MomentRingsContext = createContext({
  ringedUserIds: new Set(),
  setMomentRings: () => {},
});

export const MomentRingsProvider = ({ children }) => {
  const [ringedUserIds, setRingedUserIdsState] = useState(() => new Set());

  // Accepts an array (or iterable) of user IDs. Internally stored as
  // a Set for O(1) `has` lookups during avatar renders. Identity
  // change of the Set via `new Set(...)` triggers consumers; passing
  // the same IDs as the existing set is a no-op (we shallow-compare).
  const setMomentRings = useCallback((ids) => {
    const next = new Set();
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) next.add(id);
      }
    } else if (ids && typeof ids[Symbol.iterator] === "function") {
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) next.add(id);
      }
    }
    setRingedUserIdsState((prev) => {
      // Bail if the set is identical — avoids cascading re-renders
      // on every StoryBar refresh when nothing actually changed.
      if (prev.size === next.size) {
        let same = true;
        for (const id of next) {
          if (!prev.has(id)) { same = false; break; }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ ringedUserIds, setMomentRings }),
    [ringedUserIds, setMomentRings],
  );

  return <MomentRingsContext.Provider value={value}>{children}</MomentRingsContext.Provider>;
};

// Read hook for avatar renderers. Returns true when the given userId
// is in the ringed set, false otherwise (including when userId is
// falsy or the provider isn't mounted).
export const useMomentRing = (userId) => {
  const ctx = useContext(MomentRingsContext);
  if (!userId || !ctx?.ringedUserIds) return false;
  return ctx.ringedUserIds.has(userId);
};

// Write hook used by StoryBar (and any other surface that wants to
// repopulate the set, e.g. realtime story-shared events).
export const useSetMomentRings = () => useContext(MomentRingsContext).setMomentRings;
