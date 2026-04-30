import { AntDesign, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Image, Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import images from "../../assets/images";
import { StyledButton, StyledFormField, StyledKeyboardAvoidingView, StyledSafeAreaView, SubmitLoadingOverlay } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { updateRecoveryUser } from "../../lib/appwrite";
import { USE_SUPABASE_AUTH } from "../../lib/feature-flags";
import { updatePasswordFromRecovery as supabaseUpdatePasswordFromRecovery } from "../../lib/supabase-auth";

const normalizeRouteParam = (value) => {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
};

const ResetPassword = () => {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams();
  const userId = normalizeRouteParam(params.userId);
  const secret = normalizeRouteParam(params.secret);
  const hasValidRecoveryParams = Boolean(userId && secret);
  const [isSubmitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });

  const submit = async () => {
    if (!hasValidRecoveryParams) {
      Alert.alert("Invalid Link", "This password reset link is incomplete or has already expired.");
      return;
    }
    if (form.newPassword === "" || form.confirmPassword === "") {
      Alert.alert("Invalid", "Some required fields are missing.");
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      Alert.alert("Invalid", "Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      // Phase B.3 — gated by USE_SUPABASE_AUTH.
      //
      // Path difference between the two providers:
      //   Appwrite — the recovery URL embeds userId + secret query params,
      //   the screen reads them, and updateRecoveryUser submits both back
      //   to Appwrite to verify the link before applying the new password.
      //
      //   Supabase — the recovery email link, when opened on a device with
      //   the app installed, lands the user in a brief "recovery" auth
      //   session (token in the URL fragment, exchanged automatically by
      //   the supabase-js client). updatePasswordFromRecovery then writes
      //   the new password against that session via supabase.auth.updateUser
      //   — no userId/secret needed because the session itself is the proof.
      //   The link-verification.jsx deep-link handler is responsible for
      //   feeding the recovery token into supabase.auth.setSession before
      //   this screen mounts. (Phase B handles that wiring.)
      if (USE_SUPABASE_AUTH) {
        await supabaseUpdatePasswordFromRecovery(form.newPassword);
      } else {
        await updateRecoveryUser(userId, secret, form.newPassword, form.confirmPassword);
      }
      Alert.alert("Success", "Your password has been reset");
      router.replace("/sign-in");
    } catch (error) {
      // Typed Supabase error means the recovery session expired. Bounce
      // the user to the forgot-password screen so they can request a fresh
      // link rather than getting stuck on a generic "auth error" Alert.
      if (error?.name === "RECOVERY_SESSION_MISSING") {
        Alert.alert("Reset link expired", error.message, [
          { text: "Cancel", style: "cancel" },
          { text: "Request new link", onPress: () => router.replace("/forgot-password") },
        ]);
        return;
      }
      Alert.alert("Recovery Error", error.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StyledSafeAreaView>
      <StyledKeyboardAvoidingView>
        <ScrollView
          className="w-full"
          style={{ backgroundColor: theme.background }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
        >
          <View className="mx-auto flex-1 w-full max-w-xl px-6 pb-10" style={{ backgroundColor: theme.background }}>
            <Image source={images.logo} resizeMode="contain" className="mt-8 h-[180px] w-full" />

            <Text className="mt-2 text-center font-pbold text-2xl" style={{ color: theme.like }}>
              New Password
            </Text>
            <Text className="mt-1 text-center font-pregular text-sm" style={{ color: theme.textSoft }}>
              {hasValidRecoveryParams
                ? "Choose a strong password for your account"
                : "This reset link is no longer valid. Request a new reset link to continue."}
            </Text>

            {hasValidRecoveryParams && (
              <View className="mt-8 w-full space-y-4">
                <StyledFormField
                  icon={<MaterialCommunityIcons name="form-textbox-password" size={22} color={theme.iconMuted} />}
                  title="New Password"
                  placeholder="Your New Password"
                  value={form.newPassword}
                  handleChangeText={(e) => setForm({ ...form, newPassword: e })}
                />
                <StyledFormField
                  icon={<MaterialCommunityIcons name="form-textbox-password" size={22} color={theme.iconMuted} />}
                  title="Confirm Password"
                  placeholder="Confirm Your Password"
                  value={form.confirmPassword}
                  handleChangeText={(e) => setForm({ ...form, confirmPassword: e })}
                />
              </View>
            )}

            {hasValidRecoveryParams ? (
              <StyledButton
                icon={<AntDesign name="lock1" size={16} color={theme.primaryContrast} />}
                title="Reset Password"
                handlePress={submit}
                isLoading={isSubmitting}
                className="mt-8 w-full"
                buttonColor={theme.like}
                labelColor={theme.primaryContrast}
                loaderColor={theme.primaryContrast}
              />
            ) : (
              <StyledButton
                icon={<AntDesign name="mail" size={16} color={theme.primaryContrast} />}
                title="Request New Reset Link"
                handlePress={() => router.replace("/forgot-password")}
                className="mt-8 w-full"
                buttonColor={theme.accentAmber}
                labelColor={theme.primaryContrast}
              />
            )}

            <TouchableOpacity activeOpacity={0.7} onPress={() => router.replace("/sign-in")} className="mt-6 flex w-full items-center justify-center">
              <Text className="font-psemibold text-sm underline" style={{ color: theme.primary }}>
                Back to Sign In
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>
      <SubmitLoadingOverlay visible={isSubmitting} message="Resetting password..." />
    </StyledSafeAreaView>
  );
};

export default ResetPassword;
