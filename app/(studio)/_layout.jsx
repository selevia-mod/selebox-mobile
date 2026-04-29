import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const StudioLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="studio"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default StudioLayout;
