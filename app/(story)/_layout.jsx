import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const StoreLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="story-viewer"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="story-preview"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default StoreLayout;
