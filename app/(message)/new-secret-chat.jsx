// New Secret 1:1 chat — wraps SupabaseNewChat with mode="secret" so the
// search results filter to mutual followers and the conversation is
// created with is_secret=true via getOrCreateSecretConversation.
//
// Why a separate screen and not just a query param on new-chat: keeps
// deep-linking unambiguous (`/(message)/new-secret-chat` vs
// `/(message)/new-chat?mode=secret`) and lets us iterate on the Secret
// flow's copy / empty state independently without touching the
// regular chat creation path.

import SupabaseNewChat from "../../components/SupabaseNewChat";
import { useGlobalContext } from "../../context/global-provider";

const NewSecretChat = () => {
  const { chatUserId } = useGlobalContext();
  return <SupabaseNewChat currentUserId={chatUserId} mode="secret" />;
};

export default NewSecretChat;
