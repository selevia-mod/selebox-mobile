import { ActivityIndicator, Modal, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
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

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View className="flex-1 items-center justify-end" style={{ backgroundColor: theme.backdrop }}>
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
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export default BooksSavePromptModal;
