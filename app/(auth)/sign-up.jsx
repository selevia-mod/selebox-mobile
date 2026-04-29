import { AntDesign, FontAwesome, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useDispatch } from "react-redux";
import images from "../../assets/images";
import { StyledButton, StyledFormField, StyledKeyboardAvoidingView, StyledSafeAreaView, SubmitLoadingOverlay } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { createUser } from "../../lib/appwrite";
import { setIsLoggedReducer, setUserReducer } from "../../store/reducers/auth";

const SignUp = () => {
  const { setUser, setIsLogged } = useGlobalContext();
  const { theme } = useAppTheme();
  const dispatch = useDispatch();

  const [isSubmitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
  });

  const submit = async () => {
    if (form.username === "" || form.email === "" || form.password === "") {
      Alert.alert("Invalid", "Some required fields are missing.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await createUser(form.email, form.password, form.username);
      dispatch(setUserReducer(result));
      dispatch(setIsLoggedReducer(true));
      setUser(result);
      setIsLogged(true);
    } catch (error) {
      Alert.alert("Sign-Up Error", error.message);
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

            <Text className="mt-2 text-center font-pbold text-2xl" style={{ color: theme.accentGreen }}>
              Create Account
            </Text>
            <Text className="mt-1 text-center font-pregular text-sm" style={{ color: theme.textSoft }}>
              Join the Selebox community
            </Text>

            <View className="mt-8 w-full space-y-4">
              <StyledFormField
                icon={<FontAwesome name="user" size={22} color={theme.iconMuted} />}
                title="Username"
                placeholder="Your Username"
                value={form.username}
                handleChangeText={(e) => setForm({ ...form, username: e })}
              />

              <StyledFormField
                icon={<MaterialIcons name="email" size={22} color={theme.iconMuted} />}
                title="Email"
                placeholder="Your Email"
                value={form.email}
                handleChangeText={(e) => setForm({ ...form, email: e })}
              />

              <StyledFormField
                icon={<MaterialCommunityIcons name="form-textbox-password" size={22} color={theme.iconMuted} />}
                title="Password"
                placeholder="Your Password"
                value={form.password}
                handleChangeText={(e) => setForm({ ...form, password: e })}
              />
            </View>

            <StyledButton
              icon={<AntDesign name="adduser" size={16} color={theme.primaryContrast} />}
              title="Sign Up"
              handlePress={submit}
              className="mt-8 w-full"
              isLoading={isSubmitting}
              buttonColor={theme.accentGreen}
              labelColor={theme.primaryContrast}
              loaderColor={theme.primaryContrast}
            />

            <View className="mb-8 mt-8 w-full flex-row justify-center space-x-2">
              <Text className="font-pregular text-sm" style={{ color: theme.textSoft }}>
                Have an account already?
              </Text>
              <TouchableOpacity activeOpacity={0.7} onPress={() => router.dismissTo("/sign-in")}>
                <Text className="font-psemibold text-sm underline" style={{ color: theme.primary }}>
                  SIGN IN
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>
      <SubmitLoadingOverlay visible={isSubmitting} message="Creating your account..." />
    </StyledSafeAreaView>
  );
};

export default SignUp;
