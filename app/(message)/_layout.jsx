import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";
import { StreamChatLoader } from "../../components/StreamChatLoader";

const MessageLayout = () => {
  return (
    <StreamChatLoader>
      <Stack
        screenOptions={{
          animation: "ios_from_right",
        }}
      >
        <Stack.Screen
          name="chats"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="new-chat"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="messages"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="message-settings"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen name="channel-list" options={{ headerShown: false }} />
        <Stack.Screen name="channel" options={{ headerShown: false }} />
        <Stack.Screen name="thread" options={{ headerShown: false }} />
        <Stack.Screen name="channel-settings" options={{ headerShown: false }} />
      </Stack>

      <ThemedStatusBar />
    </StreamChatLoader>
  );
};

export default MessageLayout;
