// Stack layout for the (community) route group.
// Phase 1 ships only the index screen (Your Community). Future phases
// add post-detail / comment-thread / community-profile screens behind
// this same layout.
import { Stack } from "expo-router";

export default function CommunityLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
