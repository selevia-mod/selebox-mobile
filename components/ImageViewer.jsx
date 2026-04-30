import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, FlatList, Modal, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import PostCommentModal from "./PostCommentModal";
import PostInformation from "./PostInformation";
import PostLikesModal from "./PostLikesModal";

const { width, height } = Dimensions.get("window");

const ImageViewer = ({ images = [], visible, onClose, initialIndex = 0, postItem = null, handleSharePress, onLikeChange, onCommentChange }) => {
  const insets = useSafeAreaInsets();
  const imageArray = Array.isArray(images) ? images : [images];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [isLikesModalVisible, setLikesModalVisible] = useState(false);
  const flatListRef = useRef(null);
  const normalizedInitialIndex = Math.max(0, Math.min(initialIndex, Math.max(imageArray.length - 1, 0)));

  useEffect(() => {
    if (!visible) return;

    setCurrentIndex(normalizedInitialIndex);

    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({
        offset: normalizedInitialIndex * width,
        animated: false,
      });
    });
  }, [normalizedInitialIndex, visible]);

  const handleScroll = (event) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / width);
    setCurrentIndex(index);
  };

  const handleClose = useCallback(() => {
    setCommentModalVisible(false);
    setLikesModalVisible(false);
    onClose?.();
    setCurrentIndex(0);
  }, [onClose]);

  useEffect(() => {
    if (!visible) {
      setCommentModalVisible(false);
      setLikesModalVisible(false);
    }
  }, [visible]);

  useEffect(() => {
    setCommentModalVisible(false);
    setLikesModalVisible(false);
  }, [postItem?.$id]);

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={handleClose}>
      <View style={{ flex: 1, backgroundColor: "black" }}>
        {/* Page indicator — premium glass pill in the top-left corner. Only
            shown when there's more than one image (a single-image lightbox
            doesn't need a counter). Uppercase letter-spaced count reads as a
            quiet badge rather than competing with the image; the white-rim
            border matches the close button so the two corners feel like a
            single navigation chrome. */}
        {imageArray.length > 1 && (
          <View
            style={{
              position: "absolute",
              top: insets.top + 10,
              left: 14,
              zIndex: 10,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              borderWidth: 1,
              borderColor: "rgba(255, 255, 255, 0.22)",
              flexDirection: "row",
              alignItems: "center",
              shadowColor: "#000000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.4,
              shadowRadius: 8,
              elevation: 4,
            }}
          >
            <Text
              style={{
                color: "#FFFFFF",
                fontSize: 12,
                fontWeight: "700",
                letterSpacing: 1.2,
              }}
            >
              {currentIndex + 1}
            </Text>
            <Text
              style={{
                color: "rgba(255, 255, 255, 0.55)",
                fontSize: 12,
                fontWeight: "600",
                letterSpacing: 1.2,
                marginHorizontal: 4,
              }}
            >
              /
            </Text>
            <Text
              style={{
                color: "rgba(255, 255, 255, 0.78)",
                fontSize: 12,
                fontWeight: "700",
                letterSpacing: 1.2,
              }}
            >
              {imageArray.length}
            </Text>
          </View>
        )}

        {/* Close button — glass-tinted disc with white-rim border, same
            visual language as the profile kebab trigger so corner controls
            feel consistent across the app. Generous hitSlop so accidental
            taps near the edge still register. */}
        <TouchableOpacity
          onPress={handleClose}
          accessibilityLabel="Close image viewer"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.85}
          style={{
            position: "absolute",
            top: insets.top + 10,
            right: 14,
            zIndex: 10,
            height: 36,
            width: 36,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            borderWidth: 1,
            borderColor: "rgba(255, 255, 255, 0.22)",
            shadowColor: "#000000",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.4,
            shadowRadius: 8,
            elevation: 4,
          }}
        >
          <Ionicons name="close" size={20} color="#FFFFFF" />
        </TouchableOpacity>

        {/* Image FlatList */}
        <FlatList
          ref={flatListRef}
          data={imageArray}
          keyExtractor={(item, index) => `${item}-${index}`}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          renderItem={({ item }) => (
            <View
              style={{
                width,
                height,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <FastImage source={{ uri: item }} style={{ width, height }} resizeMode={FastImage.resizeMode.contain} />
            </View>
          )}
        />

        {postItem?.$id && (
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              backgroundColor: "rgba(0,0,0,0.78)",
            }}
          >
            <PostInformation
              item={postItem}
              handleLikesPress={() => setLikesModalVisible(true)}
              handleCommentPress={() => setCommentModalVisible(true)}
              handleSharePress={handleSharePress}
              onLikeChange={onLikeChange}
              onDarkSurface
            />
          </View>
        )}

        <PostLikesModal item={postItem} isVisible={isLikesModalVisible} onClose={() => setLikesModalVisible(false)} coverScreen={false} />

        <PostCommentModal
          item={postItem}
          isVisible={isCommentModalVisible}
          onClose={() => setCommentModalVisible(false)}
          onCommentPosted={(newCount) => {
            if (!postItem?.$id) return;
            onCommentChange?.(postItem.$id, newCount);
          }}
          coverScreen={false}
        />
      </View>
    </Modal>
  );
};

export default ImageViewer;
