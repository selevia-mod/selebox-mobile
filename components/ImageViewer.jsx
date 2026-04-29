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
        {/* Close Button */}
        <TouchableOpacity
          onPress={handleClose}
          style={{
            position: "absolute",
            top: insets.top,
            zIndex: 10,
            backgroundColor: "rgba(0,0,0,0.5)",
            borderRadius: 20,
            height: 40,
            padding: 10,
            right: 0,
          }}
        >
          <Ionicons name="close" size={28} color="white" />
        </TouchableOpacity>

        {/* Page Indicator */}
        <View
          style={{
            position: "absolute",
            top: insets.top,
            left: 0,
            zIndex: 10,
            backgroundColor: "rgba(0,0,0,0.5)",
            borderRadius: 20,
            padding: 10,
            height: 40,
          }}
        >
          <Text style={{ color: "white", fontSize: 16 }}>
            {currentIndex + 1} / {imageArray.length}
          </Text>
        </View>

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
