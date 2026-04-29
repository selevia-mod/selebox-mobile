import { Ionicons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import StyledDivider from "./StyledDivider";

const MessageSettingModal = ({ message, isVisible, onClose, deleteMessage }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      isVisible={isVisible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      swipeDirection="down"
      onSwipeComplete={onClose}
      style={{ justifyContent: "flex-end", margin: 0 }}
      backdropOpacity={0.3}
      propagateSwipe
    >
      <View
        style={{
          paddingBottom: insets.bottom + 16,
        }}
      >
        <View activeOpacity={0.8} className="m-3 items-center rounded-2xl" style={{ backgroundColor: theme.surfaceElevated }}>
          {message?.senderId?.$id === user?.$id && (
            <TouchableOpacity onPress={() => deleteMessage(true)} className="w-full flex-row items-center justify-center p-3">
              <Ionicons name="trash-outline" size={18} color={theme.danger} style={{ marginRight: 6 }} />
              <Text className="text-base" style={{ color: theme.danger }}>
                Delete for everyone
              </Text>
            </TouchableOpacity>
          )}
          {message?.senderId?.$id === user?.$id && <StyledDivider color={theme.divider} />}
          <TouchableOpacity onPress={() => deleteMessage(false)} className="w-full flex-row items-center justify-center p-3">
            <Ionicons name="eye-off-outline" size={18} color={theme.danger} style={{ marginRight: 6 }} />
            <Text className="text-base" style={{ color: theme.danger }}>
              Delete for you
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={onClose}
          activeOpacity={0.9}
          className="mx-3 items-center rounded-2xl p-3"
          style={{ backgroundColor: theme.background }}
        >
          <Text className="text-base font-medium" style={{ color: theme.text }}>
            Cancel
          </Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
};

export default MessageSettingModal;
