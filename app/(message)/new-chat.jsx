// Phase D — Supabase-only new-chat. Stream Chat + Appwrite chats removed.
//
// Used to be a hybrid screen with Stream's user search + group-creation
// flow. Per the user's request we've stopped maintaining the legacy path
// — the only new-chat renderer now is SupabaseNewChat, which searches
// `profiles` by username and uses getOrCreate1to1Conversation to start
// a 1:1 thread.
//
// Group conversation creation is intentionally not in the v1 of this
// screen. It can be added later by surfacing a multi-select toggle that
// inserts a `is_group: true` row + populates `conversation_participants`.

import SupabaseNewChat from "../../components/SupabaseNewChat";
import { useGlobalContext } from "../../context/global-provider";

const NewChat = () => {
  const { user } = useGlobalContext();
  return <SupabaseNewChat currentUserId={user?.id || user?.$id} />;
};

export default NewChat;
