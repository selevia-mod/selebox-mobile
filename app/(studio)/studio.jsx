import { FontAwesome, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, TouchableOpacity, View } from "react-native";
import { CustomAlertModal, StyledKeyboardAvoidingView, StyledSafeAreaView, StyledTitle, UploadVideo } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { useModalMessage } from "../../hooks/useModalMessage";

// Clips upload entry removed — feature retired May 2026. Studio now only
// hosts video uploads. The /studio?type=clip route is no longer reachable
// from the bottom-nav popup; if anything still tries to deep-link into it,
// the type !== "video" branch falls through to a no-op render.
const Studio = () => {
  const { theme } = useAppTheme();
  const { type } = useLocalSearchParams();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const getStudioIcon = () => {
    if (type === "video") return <FontAwesome name="video-camera" size={24} color={theme.icon} />;
    return null;
  };

  const handleCloseMessage = () => {
    if (type === "video" && message === "Your video has been uploaded successfully!") {
      router.push("/creator-section");
    }
    closeMessage();
  };

  return (
    <StyledSafeAreaView>
      <StyledKeyboardAvoidingView>
        <View className="align-start flex-row items-center justify-start px-4">
          <TouchableOpacity onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
          </TouchableOpacity>
          <StyledTitle
            className="mr-auto px-2"
            title={type === "video" ? "Upload Video" : "Studio"}
            icon={getStudioIcon()}
            titleStyle={{ color: theme.text }}
          />
        </View>
        <ScrollView>
          <View className="h-full w-full">
            {type === "video" && <UploadVideo type={type} showMessage={showMessage} />}
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>

      <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={handleCloseMessage} />
    </StyledSafeAreaView>
  );
};

export default Studio;
