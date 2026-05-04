// Total unread chat-messages count across all of the current user's
// conversations, used by the bottom-tab chat icon's red-number badge and
// any other "you have unread" surfaces.
//
// Implementation: on auth-resolved mount we fetch the conversations
// list (which now carries per-conversation unread + muted/archived
// flags), sum across non-muted / non-archived rows, and subscribe to
// the inbox INSERT stream for live updates. Each incoming message from
// somebody else triggers a debounced refetch — debounced because a
// burst of messages (e.g., a group chat going active) shouldn't fire
// N round-trips when one is enough to land the same final number.
//
// We deliberately don't try to maintain the count locally by listening
// to UPDATE events on `messages.read_at`. Postgres realtime emits one
// event per row updated, and `markConversationRead` is a bulk RPC that
// touches every unread message at once — listening would create a
// thundering-herd of UPDATE events on every conversation open. The
// debounced refetch on inbox INSERTs (and on tab focus, via
// useFocusEffect in any consumer that wants it) gives us correct
// numbers with predictable cost.
//
// Returns { unreadCount } so destructured consumers stay stable across
// the migration. When the user is signed out (chatUserId === null), the
// count stays 0.

import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalContext } from "../context/global-provider";
import { chatEvents, loadConversations, subscribeToInbox } from "../lib/messages-supabase";

// How long to wait after the most recent inbox event before refetching.
// Long enough to coalesce a burst (group chat going active), short enough
// that the badge updates feel near-realtime.
const REFETCH_DEBOUNCE_MS = 1500;

export function useTotalUnreadCount() {
  const { chatUserId } = useGlobalContext();
  const [unreadCount, setUnreadCount] = useState(0);
  // Tracked in a ref so the inbox callback closure doesn't re-bind on
  // every state change.
  const debounceRef = useRef(null);
  // Cancellation flag for in-flight fetches when the user changes /
  // unmount happens — without this a slow fetch could land setState on
  // an unmounted hook (React warning).
  const cancelledRef = useRef(false);

  const compute = useCallback(async () => {
    if (!chatUserId) {
      setUnreadCount(0);
      return;
    }
    cancelledRef.current = false;
    try {
      const list = await loadConversations();
      if (cancelledRef.current) return;
      let total = 0;
      for (const c of list || []) {
        // Archived / muted conversations don't contribute to the visible
        // badge — same rule the web uses for its bell-icon counter.
        if (c.archived || c.muted) continue;
        // Secret conversations are stealth: their unread messages should
        // never appear in the global badge. The user discovers them by
        // opening the Secret tab; the rest of the app stays quiet.
        if (c.is_secret) continue;
        total += c.unread || 0;
      }
      setUnreadCount(total);
    } catch (e) {
      // Swallow — badge wrongness is way better than a thrown error
      // bubbling up through the tab bar.
      console.log("[useTotalUnreadCount] compute failed:", e?.message);
    }
  }, [chatUserId]);

  // Initial compute, plus refresh whenever the active user changes.
  useEffect(() => {
    cancelledRef.current = false;
    compute();
    return () => {
      cancelledRef.current = true;
    };
  }, [compute]);

  // Live updates — debounced refetch on each inbox INSERT from someone
  // other than us. Skipping our own messages is correct because they
  // don't increment unread (we're the sender).
  useEffect(() => {
    if (!chatUserId) return undefined;
    const unsubscribe = subscribeToInbox((newMessage) => {
      if (!newMessage || newMessage.sender_id === chatUserId) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        compute();
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      unsubscribe();
    };
  }, [chatUserId, compute]);

  // Listen for "I just marked a conversation read" events from
  // markConversationRead. Without this, the badge waits for the next
  // focus event (i.e., the user has to fully exit chat back to a main
  // tab) — manifests as the user-reported "purple number doesn't clear
  // until I exit the whole message screen" bug. Recompute immediately so
  // the badge drops the moment the user enters the thread.
  useEffect(() => {
    if (!chatUserId) return undefined;
    const handler = () => {
      // No debounce here — read events are user-initiated (one per thread
      // open), not bursty. Immediate recompute is what the user expects.
      compute();
    };
    chatEvents.on("read", handler);
    return () => {
      chatEvents.off("read", handler);
    };
  }, [chatUserId, compute]);

  // Expose a manual refresh so screens that mark messages as read can
  // refresh the badge immediately rather than waiting for the next
  // debounce window. The thread screen calls this after
  // markConversationRead so the badge drops without lag.
  const refresh = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    compute();
  }, [compute]);

  return { unreadCount, refresh };
}

export default useTotalUnreadCount;
