import { FontAwesome, Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, FlatList, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useDispatch } from "react-redux";
import { CustomAlertModal, LinkPreviewCard, SectionDot, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { createNewPost, initialPostForm, updatePost, uploadImageToStorage } from "../../lib/posts";
import { useModalMessage } from "../../hooks/useModalMessage";
import { addPendingPost, removePendingPost, resolvePendingPost } from "../../store/reducers/post";

const CreatePost = () => {
  const { post } = useLocalSearchParams();
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const [postForm, setPostForm] = useState(initialPostForm);
  const [formLoading, setFormLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [linkUrl, setLinkUrl] = useState(null);
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const sizeLimitImageUpload = globalSettings["POST_UPLOAD_SIZE_MB"] * 1024 * 1024;
  const sizeLimitPostChars = globalSettings["POST_LIMIT_SIZE_CHARS"];
  const sizeLimitPostAttachments = globalSettings["POST_UPLOAD_MAX"];

  useFocusEffect(
    useCallback(() => {
      fetchPost();
    }, [post]),
  );

  const fetchPost = () => {
    if (post) {
      const editPostData = JSON.parse(post);
      setPostForm({
        id: editPostData?.$id,
        post: editPostData?.post || "",
        postUrls: editPostData?.postUrls?.map((url) => ({ uri: url })) || [],
      });
    }
  };

  const handleValidateData = () => {
    if (postForm?.post?.length > sizeLimitPostChars) {
      showMessage(`Please ensure your post char size is under ${sizeLimitPostChars}.`);
      return true;
    }

    if (!postForm?.post && postForm?.postUrls?.length <= 0) {
      showMessage("Please post something or attach an image.");
      return true;
    }

    if (postForm?.postUrls?.length > sizeLimitPostAttachments) {
      showMessage(`Please limit your attachments to ${sizeLimitPostAttachments} images.`);
      return true;
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
      setPostForm((prev) => ({
        ...prev,
        postUrls: [...prev.postUrls, ...validImages],
      }));
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

      setPostForm((prev) => {
        const updated = [...prev.postUrls];
        updated[indexToReplace] = newImage;
        return { ...prev, postUrls: updated };
      });
    }
  };

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
        selectionLimit: parseInt(sizeLimitPostAttachments),
      });

      if (!result.canceled) {
        handleImagesUpload(result.assets);
      }
    } finally {
    }
  };

  const toPostUrl = (entry) => {
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    return entry.uri;
  };

  const buildOptimisticPost = (clientId) => {
    const postUrls = (postForm.postUrls || []).map(toPostUrl).filter(Boolean);
    return {
      $id: null,
      $createdAt: new Date().toISOString(),
      post: postForm.post || "",
      postUrls,
      postOwner: {
        $id: user?.$id,
        username: user?.username,
        avatar: user?.avatar,
      },
      postLikes: 0,
      postComments: 0,
      clientId,
      clientStatus: "pending",
    };
  };

  const handlePost = async () => {
    let clientId = null;
    let isEditing = false;
    try {
      if (handleValidateData()) return;
      isEditing = Boolean(postForm?.id);
      clientId = isEditing ? null : `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (!isEditing) {
        const optimisticPost = buildOptimisticPost(clientId);
        dispatch(addPendingPost({ clientId, data: optimisticPost }));
        router.replace("/home");
      } else {
        setFormLoading(true);
        setProgress(0);
      }

      let uploadedUrls = postForm.postUrls;

      // Only upload new images (those with fileSize property)
      const needsUpload = postForm.postUrls.some((item) => item.fileSize);
      if (needsUpload) {
        if (isEditing) setProgress(10);
        uploadedUrls = await Promise.all(
          postForm.postUrls.map(async (img, i) => {
            if (img.fileSize) {
              const url = await uploadImageToStorage(img);
              if (isEditing) setProgress((prev) => prev + 15);
              return url;
            }
            return img.uri;
          }),
        );
      } else {
        uploadedUrls = postForm.postUrls.map((i) => i.uri);
      }

      if (isEditing) {
        await updatePost({
          ID: postForm.id,
          post: postForm.post,
          postUrls: uploadedUrls,
        });
      } else {
        const createdPost = await createNewPost({
          post: postForm.post,
          postUrls: uploadedUrls,
          postOwner: user?.$id,
        });
        dispatch(
          resolvePendingPost({
            clientId,
            data: {
              $id: createdPost?.$id,
              $createdAt: createdPost?.$createdAt,
              postUrls: uploadedUrls,
            },
          }),
        );
      }

      if (isEditing) {
        setProgress(100);
        setPostForm(initialPostForm);
        setFormLoading(false);
        showMessage("Your post has been updated!", 500);
      }
    } catch (error) {
      console.log("handlePost: error", error);
      if (isEditing) {
        setFormLoading(false);
        setProgress(0);
        showMessage("Uploading your post was unsuccessful :(", 500);
      } else {
        if (clientId) dispatch(removePendingPost({ clientId }));
        Alert.alert("Post", "Uploading your post was unsuccessful :(");
      }
    }
  };

  const renderItem = ({ item, index }) => {
    return (
      <TouchableOpacity
        onPress={() => handleReplaceImage(index)}
        className="relative mr-3 h-36 w-36 overflow-hidden rounded-2xl"
        style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
      >
        <FastImage source={{ uri: item.uri }} style={{ height: "100%", width: "100%" }} resizeMode={FastImage.resizeMode.cover} />
        <TouchableOpacity
          onPress={() =>
            setPostForm((prev) => ({
              ...prev,
              postUrls: prev.postUrls.filter((_, i) => i !== index),
            }))
          }
          className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.mediaOverlayStrong }}
        >
          <Text className="text-xs" style={{ color: theme.primaryContrast }}>
            ✕
          </Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  // Type chooser — current screen is "post"; tapping Video/Book navigates
  // to the existing creation flows, mirroring the BottomNavPopup routes.
  // router.replace is used so the user fully switches creation type rather
  // than stacking a new screen on top of the post composer.
  const isEditing = Boolean(postForm?.id);
  const handleSwitchToVideo = () => {
    if (isEditing) return;
    router.replace({ pathname: "/studio", params: { type: "video" } });
  };
  const handleSwitchToBook = () => {
    if (isEditing) return;
    router.replace("/book-editor");
  };

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full" style={{ backgroundColor: theme.background }}>
        <View className="align-start flex-row items-center justify-start px-4">
          <TouchableOpacity onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
          </TouchableOpacity>
          <StyledTitle
            className="mr-auto px-2"
            title={post ? "Edit Post" : "Create Post"}
            icon={<FontAwesome name="pencil" size={20} color={theme.icon} />}
          />
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
          <View className="px-4 pb-8">
            {/* Hero — premium violet-tinted intro card. Same shape as
                UploadVideo / book-editor heroes so the three creation
                flows read as one family. Hidden in edit mode where the
                user already knows what they're doing. */}
            {!isEditing && (
              <View className="mt-3 flex-row items-center">
                <View
                  className="mr-3 h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: theme.primarySoft,
                    borderWidth: 1,
                    borderColor: theme.primary,
                  }}
                >
                  <Ionicons name="create-outline" size={20} color={theme.primary} />
                </View>
                <View className="flex-1">
                  <Text className="text-lg font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                    Share something
                  </Text>
                  <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
                    Post a thought, upload a video, or start a new book.
                  </Text>
                </View>
              </View>
            )}

            {/* Type chooser — Post / Video / Book. Active = Post (this
                screen). Tapping Video or Book replaces the current route
                with the corresponding creation flow. Suppressed in edit
                mode since switching types mid-edit doesn't make sense. */}
            {!isEditing && (
              <View className="mt-4 flex-row" style={{ gap: 8 }}>
                {[
                  { key: "post", label: "Post", icon: "chatbubble-ellipses", active: true, onPress: () => {} },
                  { key: "video", label: "Video", icon: "videocam", active: false, onPress: handleSwitchToVideo },
                  { key: "book", label: "Book", icon: "book", active: false, onPress: handleSwitchToBook },
                ].map((tab) => (
                  <TouchableOpacity
                    key={tab.key}
                    onPress={tab.onPress}
                    activeOpacity={0.85}
                    accessibilityLabel={`Switch to create ${tab.label.toLowerCase()}`}
                    className="flex-1 flex-row items-center justify-center rounded-full"
                    style={{
                      paddingVertical: 9,
                      paddingHorizontal: 8,
                      backgroundColor: tab.active ? theme.primary : theme.surfaceMuted,
                      borderWidth: tab.active ? 0 : 1,
                      borderColor: tab.active ? "transparent" : theme.border,
                      shadowColor: theme.primary,
                      shadowOffset: { width: 0, height: 4 },
                      shadowOpacity: tab.active ? 0.28 : 0,
                      shadowRadius: 10,
                      elevation: tab.active ? 4 : 0,
                    }}
                  >
                    <Ionicons
                      name={tab.icon}
                      size={14}
                      color={tab.active ? theme.primaryContrast : theme.iconMuted}
                      style={{ marginRight: 6 }}
                    />
                    <Text
                      className="font-sans"
                      style={{
                        fontSize: 13,
                        fontWeight: tab.active ? "700" : "600",
                        letterSpacing: 0.3,
                        color: tab.active ? theme.primaryContrast : theme.textMuted,
                      }}
                    >
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View className="mt-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              <View className="flex-row items-center">
                <FastImage source={{ uri: user?.avatar }} style={{ height: 46, width: 46, borderRadius: 23 }} />
                <View className="ml-3 flex-1">
                  <Text className="text-base font-bold" style={{ color: theme.text, letterSpacing: 0.2 }} numberOfLines={1}>
                    {user?.username}
                  </Text>
                  <Text className="text-xs" style={{ color: theme.textSoft, letterSpacing: 0.1 }}>
                    Share something with your audience
                  </Text>
                </View>
              </View>

              <View className="mt-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <SectionDot color={theme.primary} />
                    <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                      Post
                    </Text>
                  </View>
                  <Text
                    className="text-[10px] font-medium"
                    style={{ color: theme.textSoft }}
                  >{`${postForm?.post?.length || 0}/${sizeLimitPostChars}`}</Text>
                </View>
                <TextInput
                  value={postForm?.post}
                  onChangeText={(text) => {
                    setPostForm((prev) => ({ ...prev, post: text }));
                    const urlRegex = /(https?:\/\/[^\s]+)/g;
                    const foundUrls = text.match(urlRegex);
                    setLinkUrl(foundUrls && foundUrls.length > 0 ? foundUrls[0] : null);
                  }}
                  multiline
                  textAlignVertical="top"
                  placeholder="What's on your mind?"
                  placeholderTextColor={theme.placeholder}
                  className="mt-3 h-[200px] w-full rounded-xl p-3 text-[14px]"
                  style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground, color: theme.inputText }}
                  maxLength={Number(sizeLimitPostChars)}
                />
              </View>

              {linkUrl && (
                <View className="mt-4">
                  <LinkPreviewCard url={linkUrl} />
                </View>
              )}

              <View className="mt-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <SectionDot color={theme.primary} />
                    <Text className="text-sm font-semibold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                      Attachments
                    </Text>
                  </View>
                  <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitPostAttachments}`}</Text>
                </View>
                <FlatList
                  horizontal
                  data={postForm?.postUrls}
                  keyExtractor={(item, index) => item?.uri || index.toString()}
                  renderItem={renderItem}
                  showsHorizontalScrollIndicator={false}
                  className="my-3 max-h-60"
                />
              </View>

              <View className="mt-4 flex-row" style={{ gap: 10 }}>
                <TouchableOpacity
                  onPress={handleAttachImage}
                  activeOpacity={0.85}
                  className="flex-1 flex-row items-center justify-center rounded-full px-4 py-3"
                  style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
                >
                  <Ionicons name="image-outline" size={17} color={theme.iconMuted} />
                  <Text className="ml-2 text-[13px] font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                    Attach
                  </Text>
                </TouchableOpacity>
                {/* Primary CTA — violet pill with the strongest shadow lift
                    on the page. Replaces the previous green pill so this
                    flow shares the language used by Save Book / Publish
                    Video. */}
                <TouchableOpacity
                  onPress={handlePost}
                  activeOpacity={0.9}
                  className="flex-1 flex-row items-center justify-center rounded-full px-4 py-3.5"
                  style={{
                    backgroundColor: theme.primary,
                    shadowColor: theme.primary,
                    shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: 0.32,
                    shadowRadius: 14,
                    elevation: 6,
                  }}
                >
                  <Ionicons name={postForm?.id ? "save-outline" : "send"} size={16} color={theme.primaryContrast} />
                  <Text className="ml-2 text-[13px] font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.3 }}>
                    {postForm?.id ? "Update" : "Post"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>

      <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={closeMessage} />

      <Modal
        isVisible={formLoading}
        backdropOpacity={0.5}
        animationIn="fadeIn"
        animationOut="fadeOut"
        backdropTransitionOutTiming={0}
        style={{ margin: 0, justifyContent: "center", alignItems: "center" }}
      >
        <View className="relative h-full w-full items-center justify-center">
          <View
            className="relative mx-5 flex w-full max-w-[320px] flex-col items-center justify-center rounded-3xl p-6"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
          >
            <LoaderKit style={{ width: 75, height: 75 }} name={"LineScalePulseOutRapid"} color={theme.primary} />
            <Text className="my-2 text-lg font-semibold" style={{ color: theme.text }}>
              {postForm?.id ? "Updating Post" : "Publishing Post"}
            </Text>
            <View className="h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceStrong }}>
              <View
                className="h-full rounded-full"
                style={{
                  width: `${progress}%`,
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.4,
                  shadowRadius: 4,
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </StyledSafeAreaView>
  );
};

export default CreatePost;
