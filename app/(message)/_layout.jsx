import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

// Chat is Supabase-native. No overlay provider or third-party client
// wiring needed at the layout level.
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
        <Stack.Screen name="group-info" options={{ headerShown: false }} />
        <Stack.Screen name="group-add-members" options={{ headerShown: false }} />
        <Stack.Screen name="new-secret-chat" options={{ headerShown: false }} />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default MessageLayout;
