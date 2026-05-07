// components/StoryReplyComposer.jsx
//
// Small bottom-sheet composer that opens when the viewer taps the
// "Send message…" pill on a Moment. Routes through the existing
// Supabase DM stack:
//   1. getOrCreate1to1Conversation(toUserId) → finds or makes the DM
//   2. sendMessage({ conversationId, body }) → posts the message
//
// Doesn't yet attach the Moment as a quoted preview — that's a follow-
// up that needs a `messages.story_ref_id` column + a renderer in the
// chat bubble. For V1 the message just lands in the DM as plain text;
// the recipient sees who replied via the chat thread context.

import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import RNModal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";
import { getOrCreate1to1Conversation, sendMessage } from "../lib/messages-supabase";

export default function StoryReplyComposer({ visible, onClose, recipientId, recipientName, onSent }) {
  const { theme } = useAppTheme();
  const inputRef = useRef(null);

  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // Auto-focus the input on open. Small delay so the slide-up
  // animation finishes first — focusing too early sometimes drops
  // the first keystroke on iOS.
  useEffect(() => {
    if (!visible) {
      setBody("");
      setSending(false);
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [visible]);

  const handleSend = async () => {
    const text = body.trim();
    if (!text || !recipientId || sending) return;
    setSending(true);
    try {
      // Resolve / create the 1:1 DM channel with the moment owner.
      const { id: conversationId } = await getOrCreate1to1Conversation(recipientId);
      if (!conversationId) throw new Error("Couldn't open the conversation");
      await sendMessage({ conversationId, body: text });
      Keyboard.dismiss();
      onSent?.();
      onClose?.();
    } catch (e) {
      console.log("[story-reply] send failed:", e?.message);
      // Surface the error inline by leaving the input focused +
      // resetting sending state so the user can retry.
      setSending(false);
    }
  };

  return (
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      backdropOpacity={0.45}
      style={{ justifyContent: "flex-end", margin: 0 }}
      useNativeDriver
      hideModalContentWhileAnimating
      animationIn="slideInUp"
      animationOut="slideOutDown"
      avoidKeyboard
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View
          style={{
            backgroundColor: theme.surfaceElevated,
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            paddingHorizontal: 14,
            paddingTop: 10,
            // Comfortable breathing room above the keyboard. 10pt was
            // too cramped (input pill kissed the keyboard top), and
            // insets.bottom + 14 from the original was overshooting
            // because avoidKeyboard handles the lift. 22pt is the
            // sweet spot — clear visual separation between the input
            // and the keyboard's top edge without a white slab.
            paddingBottom: 22,
          }}
        >
          {/* Drag handle */}
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.border,
              marginBottom: 8,
            }}
          />

          <Text style={{ color: theme.textSoft, fontSize: 12, marginBottom: 6, marginLeft: 4 }}>
            Replying to {recipientName ? `@${recipientName}` : "this Moment"}
          </Text>

          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 8,
              borderRadius: 24,
              paddingLeft: 16,
              paddingRight: 6,
              paddingVertical: 6,
              backgroundColor: theme.inputBackground,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <TextInput
              ref={inputRef}
              value={body}
              onChangeText={setBody}
              placeholder="Send a message…"
              placeholderTextColor={theme.placeholder}
              multiline
              style={{
                flex: 1,
                color: theme.inputText,
                fontSize: 15,
                maxHeight: 110,
                paddingTop: Platform.OS === "ios" ? 8 : 6,
                paddingBottom: Platform.OS === "ios" ? 8 : 6,
                minHeight: Platform.OS === "ios" ? 24 : 32,
              }}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
            />
            <Pressable
              onPress={handleSend}
              disabled={sending || !body.trim()}
              hitSlop={6}
              style={({ pressed }) => [
                styles.sendBtn,
                {
                  // Always purple — the previous "grey when empty"
                  // treatment made the button visually disappear on
                  // first open. Uses opacity to communicate disabled.
                  backgroundColor: theme.accentPurple,
                  opacity: !body.trim() ? 0.45 : pressed ? 0.85 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Feather name="send" size={18} color="#fff" />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
