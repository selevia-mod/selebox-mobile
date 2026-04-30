import { FontAwesome, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, TouchableOpacity, View } from "react-native";
import { ClipsIcon } from "../../assets/svgs";
import { CustomAlertModal, StyledKeyboardAvoidingView, StyledSafeAreaView, StyledTitle, UploadClip, UploadVideo } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { useModalMessage } from "../../hooks/useModalMessage";

const Studio = () => {
  const { theme } = useAppTheme();
  const { type } = useLocalSearchParams();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const getStudioIcon = () => {
    if (type === "video") return <FontAwesome name="video-camera" size={24} color={theme.icon} />;
    if (type === "clip") return <ClipsIcon width={24} height={24} color={theme.icon} />;
  };

  const handleCloseMessage = () => {
    if (type === "clip") {
      closeMessage();
      return;
    }
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
            title={`Upload ${type === "video" ? "Video" : "Clip"}`}
            icon={getStudioIcon()}
            titleStyle={{ color: theme.text }}
          />
        </View>
        <ScrollView>
          <View className="h-full w-full">
            {type === "video" && <UploadVideo type={type} showMessage={showMessage} />}
            {type === "clip" && <UploadClip type={type} showMessage={showMessage} />}
          </View>
        </ScrollView>
      </StyledKeyboardAvoidingView>

      <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={handleCloseMessage} />
    </StyledSafeAreaView>
  );
};

export default Studio;
