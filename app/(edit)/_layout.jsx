import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const EditLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="edit-profile"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="delete-profile"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default EditLayout;
