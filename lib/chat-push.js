// Chat push notifications — fires an Expo push when a 1:1 message is sent.
//
// Architecture: client-side push (sender's phone POSTs to Expo's API right
// after the message INSERT succeeds). We don't need a server because:
//   - The recipient's Expo push token is stored on profiles.expo_push_token
//     (mirror of the Appwrite user-doc field; see global-provider's
//     auth-bootstrap path).
//   - Expo's API is public and accepts unauthenticated POSTs.
//   - At Selebox's scale, the sender's network is reachable when the
//     INSERT succeeds, so the push almost always lands.
//
// If the recipient doesn't have a token (web-only user, never opened the
// app, or denied permission), this is a no-op — they'll see the message
// next time they open the app. No error surfaces to the sender.
//
// One thing this module deliberately does NOT do: dedupe pushes for users
// who currently have the conversation open. That'd require shared state
// between sender and recipient devices, which we don't have. Instead the
// recipient app, on the chat screen, can call
// `Notifications.setNotificationHandler` to swallow incoming pushes for
// the active conversation — that's a recipient-side responsibility.

import supabase from "./supabase";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// Sends a push to the OTHER party of a 1:1 conversation. Caller passes
// the canonical sender id, the conversation row, and a preview body.
// No-op for groups (groups need fanout — to be added with group support).
export const sendChatPushNotification = async ({
  conversation,
  senderId,
  senderUsername,
  body,
  imageUrl,
}) => {
  try {
    if (!conversation || conversation.is_group) return; // group push later
    if (!senderId || !conversation.id) return;

    // Pick the recipient's UUID — whichever side isn't the sender.
    const recipientId =
      conversation.user_a === senderId ? conversation.user_b : conversation.user_a;
    if (!recipientId || recipientId === senderId) return;

    // Look up recipient's Expo push token + display preferences. The
    // token may be NULL if they're web-only or have never opened the app
    // since this column was added — that's fine, we just skip.
    const { data: recipient, error } = await supabase
      .from("profiles")
      .select("id, expo_push_token, username")
      .eq("id", recipientId)
      .maybeSingle();
    if (error) {
      console.log("[chat-push] recipient lookup failed:", error.message);
      return;
    }
    if (!recipient?.expo_push_token) return;

    // Build the notification body. Image-only messages show "📷 Photo",
    // GIFs are also image_url so they'd show the same — fine for v1.
    const previewBody = body?.trim()
      ? body.length > 120 ? `${body.slice(0, 120)}…` : body
      : imageUrl ? "📷 Photo" : "New message";

    const payload = {
      to: recipient.expo_push_token,
      sound: "default",
      title: senderUsername ? senderUsername : "New message",
      body: previewBody,
      data: {
        type: "chat",
        conversationId: conversation.id,
        senderId,
      },
      // Android channel — register-push-notifications.js sets up "messages"
      // with MAX importance so the notification surfaces immediately.
      channelId: "messages",
    };

    const res = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.log("[chat-push] expo push failed:", res.status);
    }
  } catch (e) {
    // Swallow — push failures should never break the message send flow.
    console.log("[chat-push] exception:", e?.message);
  }
};
