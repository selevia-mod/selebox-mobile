// Stubbed out while Stream Chat is disabled. Returns 0 so the unread badge
// stays empty without crashing on the missing Chat provider.
// Will be replaced when Phase 7 ports DMs to Supabase Realtime — at that
// point this hook should subscribe to the unread count from the messages
// table or a dedicated counter.

export function useTotalUnreadCount() {
  return 0;
}

export default useTotalUnreadCount;
