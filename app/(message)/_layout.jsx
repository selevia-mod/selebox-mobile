import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

// Phase D — Stream Chat removed. The chat tab is fully Supabase-native;
// no overlay provider or Stream client wiring is needed at the layout
// level. The legacy `StreamChatLoader` component still exists in
// `components/` for now but isn't imported by any active screen, so it
// can be deleted alongside the `stream-chat-expo` dependency at the next
// native rebuild.
const MessageLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "ios_from_right",
        }}
      >
        <Stack.Screen name="channel-list" options={{ headerShown: false }} />
        <Stack.Screen name="channel" options={{ headerShown: false }} />
        <Stack.Screen name="new-chat" options={{ headerShown: false }} />
        <Stack.Screen name="new-group" options={{ headerShown: false }} />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default MessageLayout;
