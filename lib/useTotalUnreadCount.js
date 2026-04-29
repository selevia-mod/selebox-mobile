import { useEffect, useState } from "react";
import { useChatContext } from "stream-chat-expo";

export function useTotalUnreadCount() {
  const [unreadCount, setUnreadCount] = useState(0);
  const { client } = useChatContext();

  useEffect(() => {
    // Listen for unread count updates
    const handleEvent = (event) => {
      if (event.unread_channels !== undefined) {
        setUnreadCount(event.unread_channels);
      }
    };

    client.on(handleEvent);

    // Initialize with current count if user is already connected
    if (client.user) {
      setUnreadCount(client.user.unread_channels || 0);
    }

    return () => {
      client.off(handleEvent);
    };
  }, []);

  return { unreadCount };
}
