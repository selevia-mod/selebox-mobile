import { AntDesign, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
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
import { useModalMessage } from "../../hooks/useModalMessage";

const ForgotPassword = () => {
  const { theme } = useAppTheme();
  const [isSubmitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: "",
  });
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const submit = async () => {
    if (form.email === "") {
      Alert.alert("Invalid", "Some required fields are missing.");
      return;
    }
    setSubmitting(true);
    try {
      await createRecoveryEmail(form.email);
      showMessage("Please check your email for the password reset link.", 300, () => {
        router.dismissTo("/sign-in");
      });
    } catch (error) {
      Alert.alert("Create Recovery Error", error.message);
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
