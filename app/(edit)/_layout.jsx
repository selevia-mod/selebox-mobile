import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const EditLayout = () => {
  return (
    <>
      {/* Use the iOS push animation here instead of the previous "none" so
          tapping Settings from the profile screen slides in cleanly instead
          of hard-cutting. The hard cut was the dominant cause of the
          flicker the user reported: with no animation, expo-router can
          briefly show the underlying app background between the two stacks
          before edit-profile.jsx finishes painting, which reads as a flash
          even when the screen is otherwise stable. Matches the (book) and
          (message) layouts that already use ios_from_right. */}
      {/* Only edit-profile lives here. The previous declaration also listed
          a `delete-profile` screen, but that file was never added — the
          delete flow runs through `DeleteAccountModal` mounted inside
          edit-profile.jsx. expo-router was warning about the extraneous
          screen ("Too many screens defined. Route 'delete-profile' is
          extraneous."), so it's removed. */}
      <Stack
        screenOptions={{
          animation: "ios_from_right",
        }}
      >
        <Stack.Screen
          name="edit-profile"
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
