import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const PlayerLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="video-player"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="category"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="creator-section"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="download-settings"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default PlayerLayout;
