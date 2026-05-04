import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";

const BooksSavePromptModal = ({
  visible,
  loadingLocalDraft,
  loadingServerDraft,
  loadingPublish,
  onClose,
  onSaveLocalDraft,
  onSaveServerDraft,
  onPublish,
  showLocalDraftOption = true,
  showServerDraftOption = true,
  showPublishOption = true,
}) => {
  const { theme } = useAppTheme();
  const isAnyLoading = loadingLocalDraft || loadingServerDraft || loadingPublish;

  // Switched from RN's built-in <Modal> to react-native-modal so this
  // sheet shares the same JS overlay layer as BookChapterPublishSuccessModal.
  // The native iOS UIViewController-based <Modal> stacks above the JS view
  // tree — when the success modal tries to slide up while this one is
  // dismissing, the native layer either blocks the JS modal entirely or
  // gets stuck open (the "Publishing..." freeze symptom). With both modals
  // on the same JS overlay layer, transitions are clean.
  return (
    <Modal
      isVisible={visible}
      onBackdropPress={isAnyLoading ? undefined : onClose}
      onBackButtonPress={isAnyLoading ? undefined : onClose}
      backdropOpacity={0.6}
      animationIn="fadeIn"
      animationOut="fadeOut"
      animationInTiming={220}
      animationOutTiming={220}
      useNativeDriverForBackdrop
      hideModalContentWhileAnimating
      style={{ margin: 0, justifyContent: "flex-end" }}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <View
          className="w-full space-y-4 rounded-t-2xl p-5"
          style={{ borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
        >
            <Text className="text-center text-lg font-bold" style={{ color: theme.text }}>
              Save Options
            </Text>

            {showLocalDraftOption ? (
              <TouchableOpacity
                onPress={onSaveLocalDraft}
                disabled={isAnyLoading}
                className="w-full items-center rounded-2xl py-3"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: loadingLocalDraft ? theme.surfaceStrong : theme.surfaceMuted }}
              >
                {loadingLocalDraft ? (
                  <View className="flex-row items-center space-x-2">
                    <ActivityIndicator size="small" color={theme.primary} />
                    <Text className="text-base font-medium" style={{ color: theme.text }}>
                      Saving Draft Offline...
                    </Text>
                  </View>
                ) : (
                  <Text className="text-base font-medium" style={{ color: theme.text }}>
                    Save Draft Offline
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}

            {showServerDraftOption ? (
              <TouchableOpacity
                onPress={onSaveServerDraft}
                disabled={isAnyLoading}
                className="w-full items-center rounded-2xl py-3"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: loadingServerDraft ? theme.surfaceStrong : theme.surfaceMuted }}
              >
                {loadingServerDraft ? (
                  <View className="flex-row items-center space-x-2">
                    <ActivityIndicator size="small" color={theme.primary} />
                    <Text className="text-base font-medium" style={{ color: theme.text }}>
                      Saving Draft Online...
                    </Text>
                  </View>
                ) : (
                  <Text className="text-base font-medium" style={{ color: theme.text }}>
                    Save Draft Online
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}

            {showPublishOption ? (
              <TouchableOpacity
                onPress={onPublish}
                disabled={isAnyLoading}
                className="w-full items-center rounded-2xl py-3"
                style={{ backgroundColor: loadingPublish ? theme.accentPurple : theme.primary }}
              >
                {loadingPublish ? (
                  <View className="flex-row items-center space-x-2">
                    <ActivityIndicator size="small" color={theme.primaryContrast} />
                    <Text className="text-base font-medium" style={{ color: theme.primaryContrast }}>
                      Publishing...
                    </Text>
                  </View>
                ) : (
                  <Text className="text-base font-medium" style={{ color: theme.primaryContrast }}>
                    Publish Book
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}

            {/* Cancel */}
            <TouchableOpacity
              onPress={onClose}
              disabled={isAnyLoading}
              className="w-full items-center rounded-2xl py-3"
              style={{ backgroundColor: theme.danger }}
            >
              <Text className="text-base font-medium" style={{ color: theme.primaryContrast }}>
                Cancel
              </Text>
            </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

export default BooksSavePromptModal;
