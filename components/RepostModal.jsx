// RepostModal — Phase C.2 of the Appwrite → Supabase migration.
//
// What it does:
//   Bottom-sheet modal that previews the original post + collects an
//   optional caption + writes a new post into Supabase with `reposted_from`
//   set. Mirrors web's repostModal UX (Selebox/app.js around line 1224).
//
// Visual language:
//   Premium violet primary system, matching the rest of the app's modals
//   (BooksSavePromptModal, VideosDownloadQualityModal, ProfileActionsMenu).
//   Dark drag handle, soft hairline border, primary-violet "Repost" CTA
//   with shadow lift.
//
// Lifecycle:
//   - Props: `visible`, `onClose`, `originalPost` (the post being reposted),
//     `currentUser` (for the avatar in the input row).
//   - Submit: calls `createRepost`, fires `onClose(repost)` with the
//     inserted row so the caller can react (e.g., toast, optimistic feed
//     prepend).
//
// Keyboard handling: the caption field auto-focuses on open with a small
// delay so the modal animation completes first (matches web's focus delay).
//
// Edge cases handled:
//   - originalPost.original (i.e., re-reposting a repost): we resolve to
//     the *root* original by following one level of `original` if present.
//     Web has the same behavior — you can't nest reposts of reposts; the
//     `reposted_from` always points at the leaf content.
//   - Send button is disabled while submitting + when originalPost is null.
//   - Errors surface as Alerts; caller stays open so the user can retry.

import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";
import { createRepost, resolveSupabasePostId } from "../lib/posts-supabase";
import TimeAgo from "../lib/utils/time-ago";

const RepostModal = ({ visible, onClose, originalPost, currentUser }) => {
  const { theme } = useAppTheme();
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  // Resolve the "root" original — if the post being reposted is itself a
  // repost (`originalPost.reposted_from` is set + `originalPost.original`
  // is hydrated), point at that leaf so we don't build chains. Mirrors
  // web's behavior.
  const root = originalPost?.reposted_from && originalPost?.original ? originalPost.original : originalPost;
  // Either Supabase `id` or Appwrite `$id` qualifies a post for reposting.
  // The id resolution to Supabase happens at submit time.
  const rootHasId = Boolean(root?.id || root?.$id);

  // Dual-shape preview reads — `root` may be a raw Supabase row (when it
  // came from `originalPost.original`), an adapted Supabase post (when
  // the home feed passed in an item with `_supabase`), or a legacy
  // Appwrite post. Read each field with a Supabase-first / Appwrite-
  // fallback chain so the preview renders correctly in all three cases.
  const rawSupabase = root?._supabase || (root?.id && !root?.$id ? root : null);
  const rootBody = rawSupabase?.body ?? root?.body ?? root?.post ?? "";
  const rootImage = rawSupabase?.image_url ?? root?.image_url ?? root?.postUrls?.[0] ?? null;
  const rootCreatedAt = rawSupabase?.created_at ?? root?.created_at ?? root?.$createdAt ?? null;
  const rootProfile = rawSupabase?.profiles ?? root?.profiles ?? null;
  const rootOwner = root?.postOwner ?? null;
  const authorName = rootProfile?.username || rootOwner?.username || "Unknown";
  const authorAvatar = rootProfile?.avatar_url || rootOwner?.avatar || rootOwner?.avatar_url || null;

  // Reset caption + focus input when the modal opens.
  useEffect(() => {
    if (!visible) {
      setCaption("");
      return;
    }
    const timer = setTimeout(() => inputRef.current?.focus?.(), 220);
    return () => clearTimeout(timer);
  }, [visible]);

  const handleSubmit = async () => {
    // Accept either Supabase shape (`id` is UUID) or Appwrite shape
    // (`$id` is 24-char hex). resolveSupabasePostId is a no-op for
    // UUIDs and a `legacy_appwrite_id` lookup for Appwrite ids — the
    // latter only matters when USE_SUPABASE_POSTS is off and the
    // Following / For-You fallback paths are still serving Appwrite
    // posts.
    const rawId = root?.id || root?.$id;
    if (!rawId || submitting) return;
    setSubmitting(true);
    try {
      const supabaseId = await resolveSupabasePostId(rawId);
      if (!supabaseId) {
        Alert.alert("Couldn't repost", "This post hasn't been migrated yet. Try a more recent post or check back soon.");
        setSubmitting(false);
        return;
      }
      const repost = await createRepost({ originalPostId: supabaseId, caption });
      onClose?.(repost);
    } catch (error) {
      console.log("[RepostModal] createRepost error:", error?.message);
      Alert.alert("Couldn't repost", error?.message || "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    onClose?.();
  };

  const meAvatar = currentUser?.avatar_url || currentUser?.avatar;

  return (
    <Modal
      isVisible={visible}
      onBackdropPress={handleCancel}
      onBackButtonPress={handleCancel}
      swipeDirection="down"
      onSwipeComplete={handleCancel}
      style={{ justifyContent: "flex-end", margin: 0 }}
      backdropOpacity={0.55}
      useNativeDriver
      propagateSwipe
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View
          className="rounded-t-3xl px-5 pb-7 pt-4"
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.border,
            backgroundColor: theme.surfaceElevated,
          }}
        >
          {/* Drag handle */}
          <View className="mb-3 h-1.5 w-10 self-center rounded-full" style={{ backgroundColor: theme.handle }} />

          {/* Header */}
          <View className="mb-4 flex-row items-center">
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.primarySoft,
                borderWidth: 1,
                borderColor: theme.primary,
                marginRight: 12,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.35,
                shadowRadius: 8,
                elevation: 3,
              }}
            >
              <MaterialIcons name="repeat" size={20} color={theme.primary} />
            </View>
            <View className="flex-1">
              <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.4, textTransform: "uppercase" }}>
                Repost
              </Text>
              <Text className="mt-0.5" style={{ color: theme.textSoft, fontSize: 12, lineHeight: 16 }}>
                Add a thought, or repost without a caption.
              </Text>
            </View>
          </View>

          {/* Caption input row — small avatar + multiline input */}
          <View
            className="mb-4 flex-row items-start rounded-2xl px-3 py-3"
            style={{ backgroundColor: theme.inputBackground, borderWidth: 1, borderColor: theme.inputBorder }}
          >
            {meAvatar ? (
              <FastImage source={{ uri: meAvatar }} style={{ width: 32, height: 32, borderRadius: 999, backgroundColor: theme.surfaceMuted }} />
            ) : (
              <View
                className="items-center justify-center"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  backgroundColor: theme.primarySoft,
                  borderWidth: 1,
                  borderColor: theme.primary,
                }}
              >
                <Text className="font-pbold" style={{ color: theme.primary, fontSize: 12 }}>
                  {(currentUser?.username || "?").slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            <TextInput
              ref={inputRef}
              className="ml-3 flex-1 text-sm"
              placeholder="Add a caption (optional)"
              placeholderTextColor={theme.placeholder}
              style={{ color: theme.inputText, minHeight: 60, maxHeight: 140, lineHeight: 20 }}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={500}
              autoCorrect
              autoCapitalize="sentences"
            />
          </View>

          {/* Original post preview */}
          {root ? (
            <View
              className="mb-4 rounded-2xl p-3"
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
              }}
            >
              <View className="flex-row items-center">
                {authorAvatar ? (
                  <FastImage
                    source={{ uri: authorAvatar }}
                    style={{ width: 32, height: 32, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
                  />
                ) : (
                  <View
                    className="items-center justify-center"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 999,
                      backgroundColor: theme.primarySoft,
                      borderWidth: 1,
                      borderColor: theme.primary,
                    }}
                  >
                    <Text className="font-pbold" style={{ color: theme.primary, fontSize: 12 }}>
                      {authorName.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View className="ml-2.5 flex-1">
                  <Text className="font-pbold text-sm" style={{ color: theme.text }} numberOfLines={1}>
                    {authorName}
                  </Text>
                  {rootCreatedAt ? (
                    <Text className="text-[10px]" style={{ color: theme.textSoft }}>
                      {TimeAgo(rootCreatedAt)}
                    </Text>
                  ) : null}
                </View>
              </View>
              {rootBody ? (
                <Text className="mt-2 text-sm" style={{ color: theme.text, lineHeight: 20 }} numberOfLines={4}>
                  {rootBody}
                </Text>
              ) : null}
              {rootImage ? (
                <FastImage
                  source={{ uri: rootImage }}
                  style={{ width: "100%", height: 160, borderRadius: 12, marginTop: 8, backgroundColor: theme.surfaceStrong }}
                  resizeMode={FastImage.resizeMode.cover}
                />
              ) : null}
            </View>
          ) : null}

          {/* Action buttons */}
          <View className="flex-row" style={{ gap: 10 }}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleCancel}
              disabled={submitting}
              className="flex-1 items-center justify-center rounded-2xl px-4 py-3"
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                opacity: submitting ? 0.6 : 1,
              }}
            >
              <Text className="font-psemibold" style={{ color: theme.textSoft, fontSize: 13, letterSpacing: 0.2 }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleSubmit}
              disabled={!rootHasId || submitting}
              className="flex-1 flex-row items-center justify-center rounded-2xl px-4 py-3"
              style={{
                backgroundColor: theme.primary,
                borderWidth: 1,
                borderColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: !rootHasId || submitting ? 0 : 0.4,
                shadowRadius: 10,
                elevation: !rootHasId || submitting ? 0 : 4,
                opacity: !rootHasId || submitting ? 0.6 : 1,
              }}
            >
              <Ionicons name="repeat" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
              <Text className="font-psemibold" style={{ color: "#FFFFFF", fontSize: 13, letterSpacing: 0.4, textTransform: "uppercase" }}>
                {submitting ? "Posting…" : "Repost"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default RepostModal;
