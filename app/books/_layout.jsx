import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const BooksLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "ios_from_right",
        }}
      >
        <Stack.Screen
          name="[id]"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default BooksLayout;
