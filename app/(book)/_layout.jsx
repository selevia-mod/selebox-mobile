import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const BookLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "ios_from_right",
        }}
      >
        <Stack.Screen
          name="catalog"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="book-editor"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="book-introduction-editor"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="chapter-editor"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="book-reading"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="book-info"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default BookLayout;
