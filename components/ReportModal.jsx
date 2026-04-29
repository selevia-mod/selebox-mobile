import { FontAwesome } from "@expo/vector-icons";
import { Alert, Dimensions, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

const ReportModal = ({ isVisible, type, onClose, reportDetail, setReportDetail, handleSubmitReport, reportLoading }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const SCREEN_HEIGHT = Dimensions.get("window").height;

  const submitReport = async () => {
    if (!reportDetail.trim()) {
      Alert.alert("Report Submission Error", "Please enter report details");
      return;
    }
    await handleSubmitReport(reportDetail);
  };

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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          minHeight: SCREEN_HEIGHT * 0.36,
          maxHeight: SCREEN_HEIGHT * 0.7,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingBottom: insets.bottom + 16,
          paddingTop: 12,
          paddingHorizontal: 12,
          backgroundColor: theme.surfaceElevated,
          borderTopWidth: 1,
          borderTopColor: theme.border,
        }}
      >
        <View className="flex-row justify-between">
          <Text className="text-lg font-bold" style={{ color: theme.text }}>{`Report ${type}`}</Text>
          <TouchableOpacity onPress={onClose}>
            <FontAwesome name="close" color={theme.icon} size={20} />
          </TouchableOpacity>
        </View>
        <Text className="mt-2 text-xs font-medium" style={{ color: theme.textSoft }}>
          Please provide the reason for reporting this specific video.
        </Text>
        <TextInput
          editable={!reportLoading}
          value={reportDetail}
          onChangeText={setReportDetail}
          multiline
          textAlignVertical="top"
          placeholder="Describe in detail the reason for reporting this video."
          placeholderTextColor={theme.placeholder}
          selectionColor={theme.primary}
          className="my-2 h-[150px] w-full justify-start rounded-md p-3"
          style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
        />
        <TouchableOpacity onPress={submitReport} className="items-center self-end rounded-xl p-3" style={{ backgroundColor: theme.primary }}>
          {reportLoading ? (
            <LoaderKit style={{ width: 24, height: 24 }} name={"LineScalePulseOutRapid"} color={theme.primaryContrast} />
          ) : (
            <Text className="font-medium" style={{ color: theme.primaryContrast }}>
              Submit Report
            </Text>
          )}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default ReportModal;
