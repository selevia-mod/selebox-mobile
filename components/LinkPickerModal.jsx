// LinkPickerModal — bottom sheet for attaching a URL to a Moment.
//
// V1 supports any pasted URL. Selebox book / video URLs get auto-classified
// (resource_type + resource_id parsed from the path) so the viewer can
// deep-link in-app on swipe-up. External URLs are stored as-is and the
// viewer falls back to expo-web-browser.
//
// Future v2: an in-app picker that lists the current user's books +
// videos so they don't have to copy/paste. For now this is the simplest
// thing that works — pasting a `https://selebox.com/books/<uuid>` URL
// from the share sheet of any Selebox surface gets you full deep-link
// behavior.
//
// The classifier (parseLinkInput) is exported so the editor + viewer
// can use the same logic — single source of truth for what counts as
// a Selebox book / video.

import { Feather, Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BlurView } from "expo-blur";
import RNModal from "react-native-modal";

// Patterns we recognize as in-app deep links. Anything that doesn't
// match one of these falls into "external" and opens in the browser
// on swipe-up.
//
// Shapes accepted:
//   https://selebox.com/books/<uuid|legacy-id>
//   https://selebox.com/videos/<uuid|legacy-id>
//   selebox://books/<uuid>          (custom scheme — for share-sheet links)
//   selebox://videos/<uuid>
//   talesofsiren://books/<uuid>     (the actual app scheme registered in app.json)
//   talesofsiren://videos/<uuid>
//
// `id` is the trailing path segment — the viewer pushes router.push with
// the appropriate route + the id as a param.
const LINK_PATTERNS = [
  { type: "book",  re: /(?:selebox\.com|selebox|talesofsiren):\/\/?(?:.*\/)?books\/([^/?#]+)/i },
  { type: "video", re: /(?:selebox\.com|selebox|talesofsiren):\/\/?(?:.*\/)?videos\/([^/?#]+)/i },
];

// Returns { url, resourceType, resourceId } when the input is a valid
// URL; null when the input is empty / obviously malformed.
//
// `resourceType` is one of 'book' | 'video' | 'external'.
// `resourceId` is the Selebox resource id when resourceType is book/video,
// null for external.
export const parseLinkInput = (raw) => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  // Auto-add https:// if the user pasted a bare domain. Saves them a
  // step on mobile where the URL keyboard doesn't always pop up.
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  // Cheap sanity check — at least one dot for a domain. Catches typos
  // like "selebox" without a TLD.
  if (!/\.[a-z]{2,}/i.test(withScheme) && !/^[a-z]+:\/\//i.test(trimmed)) {
    return null;
  }

  for (const { type, re } of LINK_PATTERNS) {
    const match = withScheme.match(re);
    if (match?.[1]) {
      return { url: withScheme, resourceType: type, resourceId: match[1] };
    }
  }
  return { url: withScheme, resourceType: "external", resourceId: null };
};

const GLASS_INTENSITY = 60;
const GLASS_TINT = "dark";

const LinkPickerModal = ({ visible, onClose, onSubmit, initialValue = "", theme }) => {
  const [text, setText] = useState(initialValue);
  const [error, setError] = useState(null);

  // Reset the input each time the modal opens — users almost always
  // want to enter a new URL rather than edit a previous one.
  useEffect(() => {
    if (visible) {
      setText(initialValue || "");
      setError(null);
    }
  }, [visible, initialValue]);

  const submit = () => {
    const parsed = parseLinkInput(text);
    if (!parsed) {
      setError("Please enter a valid URL");
      return;
    }
    onSubmit?.(parsed);
    onClose?.();
  };

  // Live preview of the classification helps the user understand that
  // pasting a Selebox URL gets in-app deep-link treatment vs. an
  // external URL opens the browser. Lights up the relevant chip when
  // the input matches the corresponding pattern.
  const preview = parseLinkInput(text);

  return (
    // react-native-modal with avoidKeyboard handles iOS keyboard
    // avoidance natively — the vanilla RN Modal + KeyboardAvoidingView
    // combo had the sheet rendering BELOW the keyboard so the user
    // never saw it. RNModal is already used elsewhere in the app
    // (chat composer, GIF picker) so we get the same battle-tested
    // behavior. swipeDirection lets the user dismiss with a downward
    // swipe — standard sheet UX.
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      style={{ margin: 0, justifyContent: "flex-end" }}
      avoidKeyboard
      useNativeDriverForBackdrop
      backdropOpacity={0.55}
      animationIn="slideInUp"
      animationOut="slideOutDown"
      animationInTiming={260}
      animationOutTiming={220}
    >
      <View style={styles.sheet}>
        <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
        <View>
          {/* Drag handle for that "this is a sheet" reading */}
          <View style={styles.handle} />

          <View style={styles.headerRow}>
                <View style={styles.headerIcon}>
                  <Feather name="link" size={18} color="#fff" />
                </View>
                <Text style={styles.title}>Add a link</Text>
                <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
                  <Ionicons name="close" size={18} color="#fff" />
                </Pressable>
              </View>

              <Text style={styles.hint}>
                Paste a Selebox book or video URL — viewers can swipe up to open it. Any other URL works too.
              </Text>

              <View style={styles.inputWrap}>
                <Feather name="globe" size={16} color="rgba(255,255,255,0.7)" style={{ marginLeft: 12 }} />
                <TextInput
                  style={styles.input}
                  value={text}
                  onChangeText={(v) => {
                    setText(v);
                    if (error) setError(null);
                  }}
                  placeholder="https://selebox.com/books/..."
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  selectionColor={theme?.primary || "#7975D4"}
                  autoFocus
                />
                {text ? (
                  <Pressable onPress={() => setText("")} hitSlop={6} style={styles.clearBtn}>
                    <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.55)" />
                  </Pressable>
                ) : null}
              </View>

              {/* Classification chip + error message live in the same
                  vertical slot so the layout doesn't jump when the user
                  starts typing. */}
              <View style={styles.metaRow}>
                {error ? (
                  <Text style={styles.error}>{error}</Text>
                ) : preview ? (
                  <View style={styles.previewChips}>
                    <View
                      style={[
                        styles.chip,
                        preview.resourceType === "book" && { backgroundColor: theme?.primary || "#7975D4" },
                      ]}
                    >
                      <Ionicons
                        name="book"
                        size={11}
                        color={preview.resourceType === "book" ? "#fff" : "rgba(255,255,255,0.55)"}
                      />
                      <Text
                        style={[
                          styles.chipText,
                          preview.resourceType === "book" && { color: "#fff", fontWeight: "700" },
                        ]}
                      >
                        Book
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.chip,
                        preview.resourceType === "video" && { backgroundColor: theme?.primary || "#7975D4" },
                      ]}
                    >
                      <Ionicons
                        name="play"
                        size={11}
                        color={preview.resourceType === "video" ? "#fff" : "rgba(255,255,255,0.55)"}
                      />
                      <Text
                        style={[
                          styles.chipText,
                          preview.resourceType === "video" && { color: "#fff", fontWeight: "700" },
                        ]}
                      >
                        Video
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.chip,
                        preview.resourceType === "external" && { backgroundColor: "rgba(255,255,255,0.18)" },
                      ]}
                    >
                      <Feather
                        name="external-link"
                        size={11}
                        color={preview.resourceType === "external" ? "#fff" : "rgba(255,255,255,0.55)"}
                      />
                      <Text
                        style={[
                          styles.chipText,
                          preview.resourceType === "external" && { color: "#fff", fontWeight: "700" },
                        ]}
                      >
                        External
                      </Text>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.hintMuted}>Selebox URLs deep-link inside the app.</Text>
                )}
              </View>

          <Pressable
            onPress={submit}
            disabled={!text.trim()}
            style={({ pressed }) => [
              styles.submitBtn,
              { backgroundColor: theme?.primary || "#7975D4" },
              !text.trim() && { opacity: 0.5 },
              pressed && text.trim() && { transform: [{ scale: 0.97 }], opacity: 0.9 },
            ]}
          >
            <Text style={styles.submitText}>Attach link</Text>
            <Feather name="check" size={16} color="#fff" />
          </Pressable>
        </View>
      </View>
    </RNModal>
  );
};

const styles = StyleSheet.create({
  // Backdrop is handled by RNModal's `backdropOpacity` prop now (was a
  // manual flex:1 + rgba background when this used vanilla Modal). The
  // modal also handles slide-in / slide-out animations via
  // animationIn/animationOut props, so the Animated.View transform from
  // the original implementation is gone too.
  sheet: {
    overflow: "hidden",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.35)",
    marginTop: 10,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    gap: 10,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.2)",
  },
  title: {
    flex: 1,
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  hint: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    lineHeight: 17,
  },
  hintMuted: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
  },
  inputWrap: {
    marginHorizontal: 20,
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
  },
  input: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 14,
    color: "#fff",
    fontSize: 15,
  },
  clearBtn: {
    padding: 10,
  },
  metaRow: {
    paddingHorizontal: 20,
    marginTop: 10,
    minHeight: 22,
    justifyContent: "center",
  },
  error: {
    color: "#ff6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  previewChips: {
    flexDirection: "row",
    gap: 6,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chipText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  submitBtn: {
    marginTop: 16,
    marginHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 22,
  },
  submitText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
    letterSpacing: 0.3,
  },
});

export default LinkPickerModal;
