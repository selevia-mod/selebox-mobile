import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const CreatorProfileLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="profile"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="creator-profile"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="user-connections"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default CreatorProfileLayout;
