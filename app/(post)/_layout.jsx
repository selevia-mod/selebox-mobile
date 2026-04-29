import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const CreatePostLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="create-post"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="post-item"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default CreatePostLayout;
