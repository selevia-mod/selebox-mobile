import { AntDesign, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { makeRedirectUri } from "expo-auth-session";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Image, Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { OAuthProvider } from "react-native-appwrite";
import { useDispatch } from "react-redux";
import images from "../../assets/images";
import { StyledButton, StyledFormField, StyledKeyboardAvoidingView, StyledSafeAreaView, SubmitLoadingOverlay } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { account, getCurrentUserWithoutStream, signIn } from "../../lib/appwrite";
import { version } from "../../package.json";
import secrets from "../../private/secrets";
import { setIsLoggedReducer, setUserReducer } from "../../store/reducers/auth";

const SignIn = () => {
  const { setUser, setIsLogged } = useGlobalContext();
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const [isSubmitting, setSubmitting] = useState(false);
  const [isGoogleSubmitting, setGoogleSubmitting] = useState(false);
  const [isAppleSubmitting, setAppleSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: "",
    password: "",
  });

  const [oauthCooldownEnd, setOauthCooldownEnd] = useState(0);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const cooldownTimerRef = useRef(null);

  const COOLDOWN_MS = 60_000; // 1 minute cooldown

  const startCooldown = useCallback(() => {
    const end = Date.now() + COOLDOWN_MS;
    setOauthCooldownEnd(end);
    setCooldownSeconds(Math.ceil(COOLDOWN_MS / 1000));

    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((end - Date.now()) / 1000);
      if (remaining <= 0) {
        setCooldownSeconds(0);
        setOauthCooldownEnd(0);
        clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      } else {
        setCooldownSeconds(remaining);
      }
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const isRateLimitError = (error) => {
    const msg = error?.message?.toLowerCase() || "";
    const code = error?.code || error?.status || error?.type || "";
    return msg.includes("rate limit") || msg.includes("429") || String(code).includes("429") || String(code).includes("rate_limit");
  };

  const isAnySubmitting = isSubmitting || isGoogleSubmitting || isAppleSubmitting;

  useEffect(() => {
    GoogleSignin.configure({
      iosClientId: secrets.IOS_CLIENT_ID,
      webClientId: secrets.WEB_CLIENT_ID,
    });
  }, []);

  const submit = async () => {
    if (form.email === "" || form.password === "") {
      Alert.alert("Invalid", "Some required fields are missing.");
      return;
    }
    setSubmitting(true);
    try {
      await handleSignInUser(form.email, form.password);
    } catch (error) {
      Alert.alert("Sign-In Error", error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignInUser = async (email, password) => {
    const result = await signIn(email, password);
    dispatch(setUserReducer(result));
    dispatch(setIsLoggedReducer(true));
    setUser(result);
    setIsLogged(true);
  };

  const handleGoogleSignIn = async () => {
    if (Date.now() < oauthCooldownEnd) {
      Alert.alert("Please Wait", `Too many sign-in attempts. Please wait ${cooldownSeconds} seconds before trying again.`);
      return;
    }

    setGoogleSubmitting(true);
    try {
      // Create deep link that works across Expo environments
      // Ensure localhost is used for the hostname to validation error for success/failure URLs
      const deepLink = new URL(makeRedirectUri({ preferLocalhost: true }));
      const scheme = `${deepLink.protocol}//`;

      const oauthUrl = await account.createOAuth2Token(OAuthProvider.Google, `${deepLink}sign-in`, `${deepLink}sign-in`);
      const loginUrl = oauthUrl?.href ?? oauthUrl; // Appwrite returns a URL object

      // Open loginUrl and listen for the scheme redirect
      const result = await WebBrowser.openAuthSessionAsync(`${loginUrl}`, scheme);

      // User closed/cancelled the Google sheet before completing auth
      if (result.type !== "success" || !result.url) {
        console.log("Google login cancelled or dismissed:", result.type);
        return;
      }

      const redirectUrl = result.url;

      // Get everything after "?" to isolate query params
      const queryString = redirectUrl.split("?")[1]?.split("#")[0];

      if (queryString) {
        const params = new URLSearchParams(queryString);
        const secret = params.get("secret");
        const userId = params.get("userId");

        console.log("Secret:", secret);
        console.log("User ID:", userId);

        if (secret && userId) {
          try {
            await account.createSession(userId, secret);
          } catch (sessionError) {
            if (!sessionError?.message?.toLowerCase().includes("session is prohibited when a session is active")) throw sessionError;
            console.log("Google OAuth: session already active, using existing session");
          }
          const result = await getCurrentUserWithoutStream();
          dispatch(setUserReducer(result));
          dispatch(setIsLoggedReducer(true));
          setUser(result);
          setIsLogged(true);
          console.log("Session created!");
        } else {
          console.error("Missing OAuth credentials in redirect URL");
        }
      } else {
        console.error("Invalid redirect URL:", redirectUrl);
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        startCooldown();
        Alert.alert("Too Many Requests", "You've been rate limited. Please wait 1 minute before trying to sign in with Google again.");
      } else {
        Alert.alert("Google Sign-In Error", error.message);
      }
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const base64UrlDecode = (base64Url) => {
    let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) {
      base64 += "=";
    }
    return decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`)
        .join(""),
    );
  };

  const handleAppleSignIn = async () => {
    if (Date.now() < oauthCooldownEnd) {
      Alert.alert("Please Wait", `Too many sign-in attempts. Please wait ${cooldownSeconds} seconds before trying again.`);
      return;
    }

    setAppleSubmitting(true);
    try {
      const deepLink = new URL(makeRedirectUri({ preferLocalhost: true }));
      const scheme = `${deepLink.protocol}//`;

      // ✅ Use .href so it's a plain string
      const loginUrl = account.createOAuth2Token(OAuthProvider.Apple, `${deepLink}sign-in`, `${deepLink}sign-in`).href;

      // Open in the web browser
      const result = await WebBrowser.openAuthSessionAsync(loginUrl, scheme);
      const redirectUrl = result.url;

      if (!redirectUrl) return console.log("Apple login cancelled or failed");

      const queryString = redirectUrl.split("?")[1]?.split("#")[0];
      if (!queryString) {
        console.error("Invalid redirect URL:", redirectUrl);
        return;
      }

      const params = new URLSearchParams(queryString);
      const secret = params.get("secret");
      const userId = params.get("userId");

      if (secret && userId) {
        try {
          await account.createSession(userId, secret);
        } catch (sessionError) {
          if (!sessionError?.message?.toLowerCase().includes("session is prohibited when a session is active")) throw sessionError;
          console.log("Apple OAuth: session already active, using existing session");
        }
        const result = await getCurrentUserWithoutStream();
        dispatch(setUserReducer(result));
        dispatch(setIsLoggedReducer(true));
        setUser(result);
        setIsLogged(true);
      } else {
        Alert.alert("Apple Sign-In Error", "Missing credentials in redirect URL");
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        startCooldown();
        Alert.alert("Too Many Requests", "You've been rate limited. Please wait 1 minute before trying to sign in with Apple again.");
      } else {
        console.error("Apple Sign-In Error:", error);
        Alert.alert("Apple Sign-In Error", error.message);
      }
    } finally {
      setAppleSubmitting(false);
    }
  };

  return (
    <StyledSafeAreaView>
      <StyledKeyboardAvoidingView>
        <ScrollView className="h-full w-full">
          <View className="mx-auto h-full w-full max-w-xl px-6">
            <Image source={images.logo} resizeMode="contain" className="mt-8 h-[180px] w-full" />

            <Text className="mt-2 text-center font-pbold text-2xl" style={{ color: theme.text }}>
              Welcome Back!
            </Text>
            <Text className="mt-1 text-center font-pregular text-sm" style={{ color: theme.textSoft }}>
              Sign in to continue to SeLeBox
            </Text>

            <View className="mt-8 w-full space-y-4">
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
              icon={<AntDesign name="login" size={16} color={theme.primaryContrast} />}
              title="Sign In"
              handlePress={submit}
              isLoading={isSubmitting}
              className="mt-8 w-full"
              labelColor={theme.primaryContrast}
              loaderColor={theme.primaryContrast}
            />

            {cooldownSeconds > 0 && (
              <View
                className="mt-3 w-full rounded-lg px-4 py-3"
                style={{ backgroundColor: theme.accentAmberSoft, borderWidth: 1, borderColor: theme.accentAmber }}
              >
                <Text className="text-center font-psemibold text-sm" style={{ color: theme.accentAmber }}>
                  Too many attempts. Please wait {cooldownSeconds}s before trying again.
                </Text>
              </View>
            )}

            <StyledButton
              icon={<Image source={images.google} className="h-[16px] w-[16px]" />}
              title={cooldownSeconds > 0 ? `Wait ${cooldownSeconds}s...` : "Sign in with Google"}
              handlePress={handleGoogleSignIn}
              isLoading={isGoogleSubmitting}
              disabled={cooldownSeconds > 0}
              className={`mt-3 w-full ${cooldownSeconds > 0 ? "opacity-50" : ""}`}
              buttonColor={theme.searchBackground}
              labelColor={theme.searchText}
              loaderColor={theme.searchText}
              style={{ borderWidth: 1, borderColor: theme.border }}
            />

            {Platform.OS === "ios" && (
              <StyledButton
                icon={<MaterialCommunityIcons name="apple" size={20} color={theme.primaryContrast} />}
                title="Sign in with Apple"
                handlePress={handleAppleSignIn}
                isLoading={isAppleSubmitting}
                className="mt-3 w-full"
                buttonColor={theme.mediaBackground}
                labelColor={theme.primaryContrast}
                loaderColor={theme.primaryContrast}
              />
            )}

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.push("/forgot-password")}
              className="mt-6 flex w-full items-center justify-center"
            >
              <Text className="font-psemibold text-sm underline" style={{ color: theme.primary }}>
                Forgot Password?
              </Text>
            </TouchableOpacity>

            <View className="my-6 w-full flex-row items-center space-x-3">
              <View className="h-px flex-1" style={{ backgroundColor: theme.divider }} />
              <Text className="font-pregular text-xs" style={{ color: theme.textSubtle }}>
                OR
              </Text>
              <View className="h-px flex-1" style={{ backgroundColor: theme.divider }} />
            </View>

            <View className="mb-8 w-full flex-row justify-center space-x-2">
              <Text className="font-pregular text-sm" style={{ color: theme.textSoft }}>
                Don't have an account?
              </Text>
              <TouchableOpacity activeOpacity={0.7} onPress={() => router.push("/sign-up")}>
                <Text className="font-psemibold text-sm underline" style={{ color: theme.primary }}>
                  SIGN UP
                </Text>
              </TouchableOpacity>
            </View>

            <View className="mb-4 w-full items-center">
              <Text className="font-pregular text-xs" style={{ color: theme.textSubtle }}>
                Version {version}
              </Text>
            </View>
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>
      <SubmitLoadingOverlay
        visible={isAnySubmitting}
        message={isGoogleSubmitting ? "Signing in with Google..." : isAppleSubmitting ? "Signing in with Apple..." : "Signing in..."}
      />
    </StyledSafeAreaView>
  );
};

export default SignIn;
