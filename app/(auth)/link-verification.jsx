import { AntDesign, Entypo } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import images from "../../assets/images";
import { StyledButton, StyledFormField, StyledKeyboardAvoidingView, StyledSafeAreaView, SubmitLoadingOverlay } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";

const LinkVerification = () => {
  const { theme } = useAppTheme();
  const [isSubmitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    link: "",
  });

  const submit = async () => {
    if (form.link === "") {
      Alert.alert("Invalid", "Some required fields are missing.");
      return;
    }
    setSubmitting(true);
    try {
      const parsedUrl = new URL(form.link);
      const params = new URLSearchParams(parsedUrl.search);
      const userId = params.get("userId");
      const secret = params.get("secret");
      router.replace({
        pathname: "/reset-password",
        params: { userId: userId, secret: secret },
      });
    } catch (error) {
      Alert.alert("URL Params Error", error.message);
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

            <Text className="mt-2 text-center font-pbold text-2xl" style={{ color: theme.accentBlue }}>
              Confirm Link
            </Text>
            <Text className="mt-1 text-center font-pregular text-sm" style={{ color: theme.textSoft }}>
              Paste the verification link from your email
            </Text>

            <View className="mt-8">
              <StyledFormField
                icon={<Entypo name="link" size={22} color={theme.iconMuted} />}
                title="Verification Link"
                placeholder="Paste Verification Link from Email"
                value={form.link}
                handleChangeText={(e) => setForm({ ...form, link: e })}
              />
            </View>

            <StyledButton
              icon={<AntDesign name="checkcircleo" size={16} color={theme.primaryContrast} />}
              title="Confirm Reset Link"
              handlePress={submit}
              isLoading={isSubmitting}
              className="mt-8 w-full"
              buttonColor={theme.accentBlue}
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
      <SubmitLoadingOverlay visible={isSubmitting} message="Verifying link..." />
    </StyledSafeAreaView>
  );
};

export default LinkVerification;
