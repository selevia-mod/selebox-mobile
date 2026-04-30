import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Alert, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { useModalMessage } from "../hooks/useModalMessage";
import CustomAlertModal from "./CustomAlertModal";

const MessageInputSection = ({ message, setMessage, messageAttachments, setMessageAttachments, sendMessage }) => {
  const { globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const { message: modalMessage, messageOpen, showMessage, closeMessage } = useModalMessage();
  const maxAttachments = globalSettings["MESSAGES_MAX_ATTACHMENTS_COUNT"];
  const sizeLimitImageUpload = globalSettings["MESSAGES_MAX_IMAGE_UPLOAD_SIZE"] * 1024 * 1024;
  const sizeLimitVideoUpload = globalSettings["MESSAGES_MAX_VIDEO_UPLOAD_SIZE"] * 1024 * 1024;

  const handleAttachImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        allowsMultipleSelection: true,
        selectionLimit: Math.floor(Number(maxAttachments) - messageAttachments.length, 0),
      });

      if (!result.canceled) {
        handleImagesUpload(result.assets);
      }
    } finally {
    }
  };

  const handleReplaceImage = async (indexToReplace) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      allowsMultipleSelection: false,
    });

    if (!result.canceled && result.assets.length > 0) {
      const newImage = result.assets[0];

      if (newImage.fileSize > sizeLimitImageUpload) {
        const mbLimit = (sizeLimitImageUpload / 1024 / 1024).toFixed(1);
        showMessage(`Image too large. Max size is ${mbLimit}MB.`, 500);
        return;
      }

      setMessageAttachments((prev) => {
        const updated = [...prev];
        updated[indexToReplace] = newImage;
        return updated;
      });
    }
  };

  const handleImagesUpload = (images) => {
    const validImages = [];
    const oversizedImages = [];

    images.forEach((image) => {
      if (image && image.fileSize > sizeLimitImageUpload) {
        oversizedImages.push(image);
      } else {
        validImages.push(image);
      }
    });

    if (oversizedImages.length > 0) {
      const mbLimit = (sizeLimitImageUpload / 1024 / 1024).toFixed(1);
      showMessage(`Some images were too large. Max size is ${mbLimit}MB.`, 500);
    }

    if (validImages.length > 0) {
      setMessageAttachments((prev) => [...prev, ...validImages]);
    }
  };

  const renderItem = ({ item, index }) => {
    return (
      <TouchableOpacity onPress={() => handleReplaceImage(index)} className="relative mr-2 h-40 w-40">
        <FastImage source={{ uri: item.uri }} style={{ height: "100%", width: "100%", borderRadius: 8 }} resizeMode={FastImage.resizeMode.cover} />
        <TouchableOpacity
          onPress={() => setMessageAttachments((prev) => prev.filter((_, i) => i !== index))}
          className="absolute right-1 top-1 h-[25px] w-[25px] items-center justify-center rounded-[50px]"
          style={{ backgroundColor: theme.danger }}
        >
          <Ionicons name="close" size={14} color={theme.primaryContrast} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <View className="flex border-t px-2.5 py-3" style={{ borderTopColor: theme.border, backgroundColor: theme.background }}>
      {messageAttachments.length > 0 && (
        <FlatList
          horizontal
          data={messageAttachments}
          keyExtractor={(item, index) => item?.uri || index.toString()}
          renderItem={renderItem}
          showsHorizontalScrollIndicator={false}
          className="max-h-60 pb-2"
        />
      )}
      <View className="flex-row">
        <TouchableOpacity
          style={{
            backgroundColor: Number(maxAttachments) === messageAttachments.length ? theme.surfaceStrong : theme.primary,
            paddingHorizontal: 10,
            borderRadius: 20,
            marginRight: 5,
            alignItems: "center",
            justifyContent: "center",
          }}
          onPress={handleAttachImage}
          disabled={Number(maxAttachments) === messageAttachments.length}
        >
          <Ionicons name="add" size={20} color={theme.primaryContrast} />
        </TouchableOpacity>
        <TextInput
          style={{
            flex: 1,
            backgroundColor: theme.inputBackground,
            borderRadius: 20,
            paddingVertical: 10,
            paddingHorizontal: 16,
            color: theme.inputText,
            fontSize: 16,
            marginRight: 10,
          }}
          placeholder="Type a message..."
          placeholderTextColor={theme.placeholder}
          value={message}
          onChangeText={setMessage}
        />

        <TouchableOpacity
          onPress={sendMessage}
          style={{
            backgroundColor: !message.trim() && messageAttachments.length === 0 ? theme.surfaceStrong : theme.primary,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 20,
          }}
          disabled={!message.trim() && messageAttachments.length === 0}
        >
          <Ionicons name="send" size={18} color={theme.primaryContrast} />
        </TouchableOpacity>
      </View>
      <CustomAlertModal message={modalMessage} messageOpen={messageOpen} closeMessage={closeMessage} />
    </View>
  );
};

export default MessageInputSection;
