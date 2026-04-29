import crashlytics from "@react-native-firebase/crashlytics";

let hasInitializedCrashlytics = false;

const normalizeError = (error) => {
  if (error instanceof Error) return error;

  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown crashlytics error");
  }
};

export const initializeCrashlytics = async () => {
  if (hasInitializedCrashlytics) return;
  hasInitializedCrashlytics = true;

  try {
    await crashlytics().setCrashlyticsCollectionEnabled(true);
    crashlytics().log(`Crashlytics initialized (${__DEV__ ? "debug" : "release"})`);
  } catch (error) {
    console.warn("Crashlytics initialization failed:", error?.message || error);
  }
};

export const setCrashlyticsUser = async (user) => {
  try {
    if (!user?.$id) {
      await crashlytics().setUserId("");
      await crashlytics().setAttribute("auth_state", "signed_out");
      return;
    }

    await crashlytics().setUserId(String(user.$id));
    await crashlytics().setAttributes({
      auth_state: "signed_in",
      has_email: user.email ? "true" : "false",
    });
  } catch (error) {
    console.warn("Crashlytics user sync failed:", error?.message || error);
  }
};

export const recordCrashlyticsError = (error, context) => {
  try {
    const normalizedError = normalizeError(error);

    if (context) {
      crashlytics().log(String(context));
    }

    crashlytics().recordError(normalizedError);
  } catch (recordingError) {
    console.warn("Crashlytics recordError failed:", recordingError?.message || recordingError);
  }
};

export const triggerCrashlyticsTestCrash = () => {
  crashlytics().log("Triggering Crashlytics test crash");
  crashlytics().crash();
};
