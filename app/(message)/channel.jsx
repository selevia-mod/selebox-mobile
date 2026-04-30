// Phase D — Supabase-only chat thread. Stream Chat removed.
//
// This screen used to host a Stream Chat <Channel> with <MessageList> +
// <MessageInput>. Per the user's request we've stopped maintaining the
// Stream path — the only thread renderer now is SupabaseThread, which
// reads from lib/messages-supabase.js.
//
// The route still accepts both `conversationId` (Supabase UUID) and the
// legacy `channelId` param so existing nav links keep resolving while
// the rest of the app catches up to the new param name.

import { useLocalSearchParams } from "expo-router";
import SupabaseThread from "../../components/SupabaseThread";
import { useGlobalContext } from "../../context/global-provider";

const ChannelScreen = () => {
  const params = useLocalSearchParams();
  // chatUserId is the resolved Supabase UUID — required for sender_id
  // comparisons inside SupabaseThread (own-vs-other bubble alignment,
  // realtime markRead skip-self, presence track, etc.).
  const { chatUserId } = useGlobalContext();
  const conversationId = params.conversationId || params.channelId;
  return <SupabaseThread conversationId={conversationId} currentUserId={chatUserId} />;
};

export default ChannelScreen;
