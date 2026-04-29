import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";

const AuthLayout = () => {
  const { theme } = useAppTheme();

  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
          contentStyle: {
            backgroundColor: theme.background,
          },
        }}
        initialRouteName="sign-in"
      >
        <Stack.Screen
          name="sign-in"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="sign-up"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="forgot-password"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="link-verification"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="reset-password"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default AuthLayout;
