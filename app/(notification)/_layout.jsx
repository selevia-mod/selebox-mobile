import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const NotificationLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="notification"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default NotificationLayout;
