import { FontAwesome, FontAwesome6 } from "@expo/vector-icons";
import { useCallback, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";

const CustomAlertModal = ({ message, iconName = "hammer", icon, messageOpen, closeMessage, iconColor, onSuccessClose }) => {
  const { theme } = useAppTheme();
  const bounceValue = useRef(new Animated.Value(0)).current;
  const loopRef = useRef(null);

  const stopBounce = useCallback(() => {
    if (loopRef.current) {
      loopRef.current.stop();
      loopRef.current = null;
    }
    bounceValue.setValue(0);
  }, []);

  useEffect(() => {
    if (!messageOpen) {
      stopBounce();
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceValue, {
          toValue: -20,
          duration: 400,
          useNativeDriver: true,
          easing: Easing.out(Easing.quad),
        }),
        Animated.timing(bounceValue, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
          easing: Easing.in(Easing.quad),
        }),
      ]),
    );
    loopRef.current = loop;
    loop.start();

    return () => stopBounce();
  }, [messageOpen]);

  return (
    <Modal
      isVisible={messageOpen}
      backdropOpacity={0.6}
      onBackdropPress={closeMessage}
      onBackButtonPress={closeMessage}
      useNativeDriver
      animationIn="fadeIn"
      animationOut="fadeOut"
      animationOutTiming={200}
      hideModalContentWhileAnimating
      onModalWillHide={stopBounce}
    >
      <View className="flex-1 items-center justify-center px-6">
        <View
          className="relative w-full max-w-[320px] items-center overflow-hidden rounded-[28px] px-6 pb-6 pt-8"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
        >
          <View pointerEvents="none" style={[styles.topGlow, { backgroundColor: theme.accentPurpleSoft }]} />
          <View pointerEvents="none" style={[styles.iconHalo, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]} />

          <Animated.View style={[styles.iconWrapper, { transform: [{ translateY: bounceValue }] }]}>
            {icon ? icon : <FontAwesome6 name={iconName} size={68} color={iconColor ? iconColor : theme.icon} />}
          </Animated.View>

          <Text style={[styles.messageText, { color: theme.textMuted }]}>{message}</Text>

          <TouchableOpacity
            onPress={closeMessage}
            className="mt-6 w-full flex-row items-center justify-center rounded-full py-3"
            style={{ backgroundColor: theme.primary }}
          >
            <Text className="mr-2 text-[14px] font-semibold" style={{ color: theme.primaryContrast }}>
              Okay
            </Text>
            <FontAwesome name="thumbs-up" size={18} color={theme.primaryContrast} />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  iconWrapper: {
    marginTop: 2,
    marginBottom: 6,
  },
  messageText: {
    marginTop: 6,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 21,
  },
  topGlow: {
    position: "absolute",
    top: -70,
    width: 220,
    height: 140,
    borderRadius: 120,
  },
  iconHalo: {
    position: "absolute",
    top: 26,
    width: 110,
    height: 110,
    borderRadius: 999,
    borderWidth: 1,
  },
});

export default CustomAlertModal;
