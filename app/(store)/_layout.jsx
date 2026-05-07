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
          name="store"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="coin-history"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="star-history"
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
