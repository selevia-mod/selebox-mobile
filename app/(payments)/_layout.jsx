import { Stack } from "expo-router";
import { ThemedStatusBar } from "../../components";

const PaymentsLayout = () => {
  return (
    <>
      <Stack
        screenOptions={{
          animation: "none",
        }}
      >
        <Stack.Screen
          name="payments"
          options={{
            headerShown: false,
          }}
        />
      </Stack>

      <ThemedStatusBar />
    </>
  );
};

export default PaymentsLayout;
