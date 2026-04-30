import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";
import { signOut } from "../lib/appwrite";
import { clearDownloadedBooks } from "../lib/book-downloads";
// Phase D — Stream Chat import removed. Account deletion no longer needs
// to disconnect the Stream client because we don't have one.

const DELETION_STEPS = [
  { label: "Signing out", icon: "logout" },
  { label: "Deleting account data", icon: "cloud-off" },
  { label: "Clearing local data", icon: "delete-forever" },
  { label: "Complete", icon: "check-circle" },
];

const DeleteAccountModal = ({ isVisible, onClose, user, dispatch, setUser, setIsLogged, clearUserReducer, setIsLoggedReducer }) => {
  const { theme } = useAppTheme();
  const [confirmationText, setConfirmationText] = useState("");
  const [hasBlurred, setHasBlurred] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [deletionError, setDeletionError] = useState(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const isValid = confirmationText.trim() === user?.username;
  const isDeleteButtonEnabled = isValid && !isDeleting;
  const showValidationError = hasBlurred && confirmationText.trim() !== "" && !isValid;

  useEffect(() => {
    let animation;
    if (isVisible) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 800,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
            easing: Easing.inOut(Easing.ease),
          }),
        ]),
      );
      animation.start();
    } else {
      setConfirmationText("");
      setHasBlurred(false);
      setDeletionError(null);
      setCurrentStep(0);
    }

    return () => {
      if (animation) {
        animation.stop();
      }
    };
  }, [isVisible, pulseAnim]);

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    setDeletionError(null);

    try {
      // Step 1: Sign out
      setCurrentStep(0);
      await signOut();

      // Phase D — Stream client disconnect step removed. signOut() above
      // already prunes any leftover Stream tokens from AsyncStorage as a
      // one-time cleanup of legacy keys.

      // Step 2: Delete from backend
      setCurrentStep(1);
      await axios.delete(`https://67185f978296709d8c8d.appwrite.global?userId=${user?.accountId}`, { timeout: 30000 });

      // Step 3: Clear local data
      setCurrentStep(2);
      clearDownloadedBooks();

      // Step 4: Complete
      setCurrentStep(3);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Final: Update user state (triggers redirect to sign-in)
      dispatch(clearUserReducer());
      dispatch(setIsLoggedReducer(false));
      setUser(false);
      setIsLogged(false);

      // Close modal and let global provider redirect to sign-in
      onClose();
    } catch (error) {
      await handleDeletionError(error, currentStep);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeletionError = async (error, step) => {
    console.error("Deletion error:", error);

    if (step === 0) {
      // Sign-out failed - user still logged in
      setDeletionError({
        message: "Failed to sign out. Please check your internet connection and try again.",
        canRetry: true,
        signedOut: false,
      });
    } else if (step === 1) {
      // Backend deletion failed - user already signed out
      // Don't clear user state yet - wait for modal to close
      // Clear local data anyway since they initiated deletion
      try {
        clearDownloadedBooks();
        await AsyncStorage.removeItem("streamUserId");
        await AsyncStorage.removeItem("streamToken");
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }

      setDeletionError({
        message: "Account data deletion failed on the server. You have been signed out. Please contact support if needed.",
        canRetry: false,
        signedOut: true,
      });
    } else {
      // Local data clearing failed (unlikely) - user already signed out
      // Don't clear user state yet - wait for modal to close
      try {
        await AsyncStorage.removeItem("streamUserId");
        await AsyncStorage.removeItem("streamToken");
      } catch (cleanupError) {
        console.error("AsyncStorage cleanup error:", cleanupError);
      }

      setDeletionError({
        message: "An unexpected error occurred. You have been signed out. Please contact support if needed.",
        canRetry: false,
        signedOut: true,
      });
    }
  };

  const handleRetryDeletion = () => {
    setDeletionError(null);
    setCurrentStep(0);
    handleDeleteAccount();
  };

  const handleClose = () => {
    if (!isDeleting) {
      // If user was signed out (error in step 1+), clear user state before closing
      if (deletionError?.signedOut) {
        dispatch(clearUserReducer());
        dispatch(setIsLoggedReducer(false));
        setUser(false);
        setIsLogged(false);
      }
      onClose();
    }
  };

  const handleInputBlur = () => {
    setHasBlurred(true);
  };

  // Don't render modal if user is not available
  if (!user) {
    return null;
  }

  return (
    <Modal
      isVisible={isVisible}
      backdropOpacity={0.6}
      onBackdropPress={handleClose}
      onBackButtonPress={handleClose}
      animationIn="fadeIn"
      animationOut="fadeOut"
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center px-4">
          <View className="w-full max-w-md rounded-3xl p-6" style={{ backgroundColor: theme.surfaceElevated }}>
            {/* Warning Header */}
            <View className="mb-4 items-center">
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <MaterialIcons name="warning" size={64} color={theme.danger} />
              </Animated.View>
              <Text className="mt-2 text-center text-xl font-bold" style={{ color: theme.text }}>
                Delete Account
              </Text>
            </View>

            {/* Enhanced Warning Section */}
            <View className="mb-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.danger, backgroundColor: theme.dangerSoft }}>
              <Text className="mb-3 text-center font-sans text-base font-bold" style={{ color: theme.text }}>
                This action is irreversible!
              </Text>

              <View className="h-px" style={{ backgroundColor: theme.danger }} />

              <View className="mt-3 space-y-2">
                <WarningItem icon="person-remove" text="Account deleted permanently" />
                <WarningItem icon="delete-forever" text="Lose access to all videos, posts, and comments" />
                <WarningItem icon="cloud-off" text="All downloaded books cleared" />
                <WarningItem icon="lock" text="Immediate sign-out, no recovery possible" />
                <WarningItem icon="cancel" text="This action cannot be undone" />
              </View>
            </View>

            {!isDeleting && !deletionError ? (
              <>
                {/* Type-to-Confirm Input */}
                <View className="mb-4">
                  <Text className="mb-2 text-center font-sans text-xs" style={{ color: theme.textMuted }}>
                    Type your username to confirm:{" "}
                    <Text className="font-bold" style={{ color: theme.text }} accessibilityLabel={`Username: ${user?.username}`}>
                      {user?.username}
                    </Text>
                  </Text>
                  <TextInput
                    value={confirmationText}
                    onChangeText={setConfirmationText}
                    onBlur={handleInputBlur}
                    placeholder="Enter your username"
                    placeholderTextColor={theme.placeholder}
                    className={`rounded-lg px-4 py-3 font-sans text-base ${
                      showValidationError ? "border-2 border-red-500" : isValid ? "border-2 border-green-500" : "border border-gray-700"
                    }`}
                    style={{ backgroundColor: theme.inputBackground, color: theme.inputText }}
                    accessibilityLabel="Username confirmation input"
                    accessibilityHint={`Type ${user?.username} to enable delete button`}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {showValidationError && (
                    <Text className="mt-1 text-xs text-red-400" accessibilityRole="alert">
                      Username does not match
                    </Text>
                  )}
                </View>

                {/* Action Buttons */}
                <View className="flex-row space-x-3">
                  <TouchableOpacity
                    onPress={handleClose}
                    className="flex-1 rounded-xl py-3"
                    style={{ backgroundColor: theme.surfaceMuted }}
                    accessibilityLabel="Cancel deletion"
                    accessibilityRole="button"
                  >
                    <Text className="text-center font-sans text-base font-semibold" style={{ color: theme.text }}>
                      Cancel
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleDeleteAccount}
                    disabled={!isDeleteButtonEnabled}
                    className="flex-1 rounded-xl py-3"
                    style={{ backgroundColor: isDeleteButtonEnabled ? theme.danger : theme.surfaceStrong }}
                    accessibilityLabel="Confirm account deletion"
                    accessibilityRole="button"
                    accessibilityHint="Permanently deletes your account and all associated data"
                    accessibilityState={{ disabled: !isDeleteButtonEnabled }}
                  >
                    <Text
                      className="text-center font-sans text-base font-semibold"
                      style={{ color: isDeleteButtonEnabled ? theme.primaryContrast : theme.textSoft }}
                    >
                      Delete
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : deletionError ? (
              /* Error Display */
              <View className="mb-4">
                <View className="mb-4 rounded-lg p-4" style={{ backgroundColor: theme.dangerSoft }}>
                  <View className="mb-2 flex-row items-center">
                    <MaterialIcons name="error" size={24} color={theme.danger} />
                    <Text className="ml-2 font-sans text-base font-bold" style={{ color: theme.text }}>
                      Error
                    </Text>
                  </View>
                  <Text className="font-sans text-sm" style={{ color: theme.text }}>
                    {deletionError.message}
                  </Text>
                  {deletionError.signedOut && (
                    <Text className="mt-2 font-sans text-xs" style={{ color: theme.textMuted }}>
                      You have been signed out. Please contact support if needed.
                    </Text>
                  )}
                </View>

                <View className="flex-row space-x-3">
                  {deletionError.canRetry ? (
                    <>
                      <TouchableOpacity
                        onPress={handleClose}
                        className="flex-1 rounded-xl py-3"
                        style={{ backgroundColor: theme.surfaceMuted }}
                        accessibilityLabel="Close modal"
                      >
                        <Text className="text-center font-sans text-base font-semibold" style={{ color: theme.text }}>
                          Close
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={handleRetryDeletion}
                        className="flex-1 rounded-xl py-3"
                        style={{ backgroundColor: theme.primary }}
                        accessibilityLabel="Retry deletion"
                        accessibilityRole="button"
                      >
                        <Text className="text-center font-sans text-base font-semibold" style={{ color: theme.primaryContrast }}>
                          Retry
                        </Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <TouchableOpacity
                      onPress={handleClose}
                      className="flex-1 rounded-xl py-3"
                      style={{ backgroundColor: theme.surfaceMuted }}
                      accessibilityLabel="Close modal"
                      accessibilityRole="button"
                    >
                      <Text className="text-center font-sans text-base font-semibold" style={{ color: theme.text }}>
                        Close
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ) : (
              /* Progress Indicator */
              <View className="mb-4">
                {DELETION_STEPS.map((step, index) => (
                  <View key={index} className="mb-3 flex-row items-center">
                    <View className="mr-3">
                      {index < currentStep ? (
                        <MaterialIcons name="check-circle" size={24} color={theme.accentGreen} accessibilityLabel="Step completed" />
                      ) : index === currentStep ? (
                        <View accessibilityLabel="Step in progress">
                          <LoaderKit style={{ width: 24, height: 24 }} name="BallSpinFadeLoader" color={theme.primary} />
                        </View>
                      ) : (
                        <MaterialIcons name={step.icon} size={24} color={theme.textSoft} accessibilityLabel="Step pending" />
                      )}
                    </View>
                    <Text
                      className="font-sans text-base"
                      style={{
                        color: index < currentStep ? theme.accentGreen : index === currentStep ? theme.text : theme.textSoft,
                        fontWeight: index === currentStep ? "600" : "400",
                      }}
                    >
                      {step.label}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const WarningItem = ({ icon, text }) => {
  const { theme } = useAppTheme();

  return (
    <View className="flex-row items-center py-1">
      <MaterialIcons name={icon} size={20} color={theme.danger} style={{ marginRight: 8 }} />
      <Text className="flex-1 font-sans text-sm" style={{ color: theme.text }}>
        {text}
      </Text>
    </View>
  );
};

export default DeleteAccountModal;
