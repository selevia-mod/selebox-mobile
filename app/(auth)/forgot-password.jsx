import { AntDesign, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import images from "../../assets/images";
import {
  CustomAlertModal,
  StyledButton,
  StyledFormField,
  StyledKeyboardAvoidingView,
  StyledSafeAreaView,
  SubmitLoadingOverlay,
} from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { createRecoveryEmail } from "../../lib/appwrite";
import { USE_SUPABASE_AUTH } from "../../lib/feature-flags";
import { sendPasswordResetEmail as supabaseSendPasswordResetEmail } from "../../lib/supabase-auth";
import { useModalMessage } from "../../hooks/useModalMessage";

// Translate raw backend errors into messages a user can act on.
// "email rate limit exceeded" is Supabase's default 4-emails-per-hour
// guard — without this mapping the user sees the raw string and has no
// idea whether to retry, contact support, or wait. See forgot-password
// rate-limit notes in lib/feature-flags.js comment block.
const friendlyErrorMessage = (error) => {
  const raw = String(error?.message || error || "").toLowerCase();
  if (raw.includes("rate limit") || raw.includes("too many request") || raw.includes("over_email_send")) {
    return {
      title: "Too many attempts",
      body:
        "We've sent too many reset emails recently. Please wait about an hour and try again, or contact support if the problem persists.",
    };
  }
  if (raw.includes("invalid") && raw.includes("email")) {
    return { title: "Invalid email", body: "Please double-check the email address you entered." };
  }
  if (raw.includes("network") || raw.includes("fetch")) {
    return { title: "Connection problem", body: "Please check your internet connection and try again." };
  }
  return { title: "Couldn't send reset link", body: error?.message || "Please try again in a moment." };
};

// Cooldown so a user can't tap the button 30 times in 10 seconds and
// burn through the per-IP rate budget for everyone on their network.
// Server-side limit is the real defense; this is just a friendly local
// guard against accidental spam-tapping.
const COOLDOWN_MS = 30 * 1000;

const ForgotPassword = () => {
  const { theme } = useAppTheme();
  const [isSubmitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: "",
  });
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  // Tracks the last-sent timestamp (per email). If the user retries
  // within COOLDOWN_MS we short-circuit BEFORE hitting the network so
  // they see clear "try again in N seconds" feedback instead of a
  // server rate-limit error.
  const lastSentRef = useRef({ email: "", ts: 0 });

  const submit = async () => {
    const trimmedEmail = (form.email || "").trim().toLowerCase();
    if (!trimmedEmail) {
      Alert.alert("Email required", "Please enter the email address you signed up with.");
      return;
    }

    const sinceLast = Date.now() - lastSentRef.current.ts;
    if (lastSentRef.current.email === trimmedEmail && sinceLast < COOLDOWN_MS) {
      const secondsLeft = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
      Alert.alert(
        "Please wait",
        `We just sent a reset link. Try again in ${secondsLeft}s if it hasn't arrived (also check spam).`,
      );
      return;
    }

    setSubmitting(true);
    try {
      // Phase B.3 — gated by USE_SUPABASE_AUTH. Both providers send a
      // recovery email pointing back at the same WEBSITE host, which
      // already handles the deep link into (auth)/link-verification.
      if (USE_SUPABASE_AUTH) {
        await supabaseSendPasswordResetEmail(trimmedEmail);
      } else {
        await createRecoveryEmail(trimmedEmail);
      }
      lastSentRef.current = { email: trimmedEmail, ts: Date.now() };
      showMessage("Please check your email for the password reset link.", 300, () => {
        router.dismissTo("/sign-in");
      });
    } catch (error) {
      const { title, body } = friendlyErrorMessage(error);
      Alert.alert(title, body);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StyledSafeAreaView>
      <StyledKeyboardAvoidingView>
        <ScrollView className="h-full w-full">
          <View className="mx-auto h-full w-full max-w-xl px-6">
            <Image source={images.logo} resizeMode="contain" className="mt-8 h-[180px] w-full" />

            <Text className="mt-2 text-center font-pbold text-2xl" style={{ color: theme.accentAmber }}>
              Reset Password
            </Text>
            <Text className="mt-1 text-center font-pregular text-sm" style={{ color: theme.textSoft }}>
              We'll send a recovery link to your email
            </Text>

            <View className="mt-8">
              <StyledFormField
                icon={<MaterialIcons name="email" size={22} color={theme.iconMuted} />}
                title="Email"
                placeholder="Your Email"
                value={form.email}
                handleChangeText={(e) => setForm({ ...form, email: e })}
              />
            </View>

            <StyledButton
              icon={<AntDesign name="mail" size={16} color={theme.primaryContrast} />}
              title="Send Reset Link"
              handlePress={submit}
              isLoading={isSubmitting}
              className="mt-8 w-full"
              buttonColor={theme.accentAmber}
              labelColor={theme.primaryContrast}
              loaderColor={theme.primaryContrast}
            />

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.dismissTo("/sign-in")}
              className="mt-6 flex w-full items-center justify-center"
            >
              <Text className="font-psemibold text-sm underline" style={{ color: theme.primary }}>
                Back to Sign In
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>
      <SubmitLoadingOverlay visible={isSubmitting} message="Sending reset link..." />
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} iconName="envelope" iconColor={theme.accentGreen} />
    </StyledSafeAreaView>
  );
};

export default ForgotPassword;
