// Stubbed out while Stream Chat is disabled. Returns the same SHAPE the
// real hook will return when Phase 7 ports DMs to Supabase Realtime, so
// consumers can keep destructuring `const { unreadCount } = useTotalUnreadCount()`
// without flipping to undefined. Until the real subscription lands, the
// count stays at 0.
//
// Previous version returned the literal number `0`, which silently broke
// every destructured consumer (MainScreensHeader's chat badge, etc.) —
// `const { unreadCount } = 0` produced `undefined`, and the badge logic
// reading `unreadCount > 0` always evaluated false (which happened to be
// the desired behavior, masking the bug). Future-proofing now so the
// migration doesn't surface the misalignment.

export function useTotalUnreadCount() {
  return { unreadCount: 0 };
}

export default useTotalUnreadCount;
