// components/BalanceRecoveryBanner.jsx
//
// Self-contained recovery entry point. Renders the amber banner on
// Payments + Store screens. Drives a modal form for filing a request
// covering missing coins / stars / earnings / account access.
//
// Banner has four visual states:
//   • Default          — "Missing coins, stars, earnings, or account?"
//                        with primary CTA → opens the form modal.
//   • Pending review   — clock icon, disabled-style with "We're
//                        reviewing your report" + submitted-when label.
//   • Approved (≤7d)   — green check, "Your balance has been restored"
//                        / "Account access restored" depending on kind.
//   • Rejected (≤7d)   — red dot, "We couldn't verify this report" +
//                        admin's note + "Contact support" CTA.
//
// Designed as a drop-in. Both /(payments)/earnings.jsx and /(store)/
// store.jsx can render <BalanceRecoveryBanner /> at the spot they
// want it; component handles its own state, fetch, and refresh.

import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import RNModal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import { getActiveRecoveryRequest, submitRecoveryRequest } from "../lib/balance-recovery";
import { getMessagesUserId } from "../lib/messages-supabase";
import supabase from "../lib/supabase";
import { convertToWebP } from "../lib/utils/image-utils";

// Kind options shown in the picker. Order chosen to put the most
// frequently-reported issue (missing coins) first.
const KINDS = [
  { key: "coin",     label: "Missing coins",     icon: "logo-bitcoin",         needsAmount: true },
  { key: "star",     label: "Missing stars",     icon: "star-outline",         needsAmount: true },
  { key: "earnings", label: "Missing earnings",  icon: "cash-outline",         needsAmount: true },
  { key: "account",  label: "Account recovery",  icon: "person-circle-outline", needsAmount: false },
];

// Friendlier labels for the banner's status states.
const KIND_NOUN = {
  coin: "coins",
  star: "stars",
  earnings: "earnings",
  account: "account access",
};

const formatRelative = (iso) => {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
};

export default function BalanceRecoveryBanner() {
  const { theme } = useAppTheme();
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = async () => {
    try {
      const row = await getActiveRecoveryRequest();
      setActive(row);
    } catch (e) {
      // Best-effort — banner falls back to default state on error.
      setActive(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // ── State branches ─────────────────────────────────────────────
  // 1. Loading — render a thin placeholder that won't flash content.
  if (loading) {
    return <View style={{ height: 64 }} />;
  }

  // 2. Pending / needs_info — show review status, no CTA.
  if (active && (active.status === "pending" || active.status === "needs_info")) {
    return (
      <View style={[styles.bannerBase(theme), { backgroundColor: theme.accentAmberSoft, borderColor: theme.accentAmber }]}>
        <View style={[styles.iconBubble, { backgroundColor: theme.accentAmber }]}>
          <MaterialCommunityIcons name="clock-outline" size={16} color="#412402" />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700", marginBottom: 2 }}>
            We're reviewing your report
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 11, lineHeight: 16 }}>
            Submitted {formatRelative(active.created_at)} · {KIND_NOUN[active.kind] || "issue"}
            {active.status === "needs_info" ? " · We'll reach out for more info" : ""}
          </Text>
        </View>
      </View>
    );
  }

  // 3. Approved within 7 days — confirmation state.
  if (active && active.status === "approved") {
    return (
      <View style={[styles.bannerBase(theme), { backgroundColor: theme.accentGreenSoft, borderColor: theme.accentGreen }]}>
        <View style={[styles.iconBubble, { backgroundColor: theme.accentGreen }]}>
          <Feather name="check" size={16} color="#fff" />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700", marginBottom: 2 }}>
            {active.kind === "account" ? "Account access restored" : `Your ${KIND_NOUN[active.kind]} have been restored`}
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 11, lineHeight: 16 }}>
            Resolved {formatRelative(active.reviewed_at || active.created_at)}
            {active.approved_amount && active.kind !== "account"
              ? ` · ${active.approved_amount} ${active.kind === "earnings" ? "credited" : KIND_NOUN[active.kind]}`
              : ""}
          </Text>
        </View>
      </View>
    );
  }

  // 4. Rejected within 7 days — show admin note + contact-support CTA.
  if (active && active.status === "rejected") {
    return (
      <View style={[styles.bannerBase(theme), { backgroundColor: theme.dangerSoft || "#fceaea", borderColor: theme.danger }]}>
        <View style={[styles.iconBubble, { backgroundColor: theme.danger }]}>
          <Feather name="x" size={16} color="#fff" />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700", marginBottom: 2 }}>
            We couldn't verify this report
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 11, lineHeight: 16 }}>
            {active.admin_notes || "Please contact support for more details."}
          </Text>
        </View>
      </View>
    );
  }

  // 5. Default — open invitation to file a report.
  // Wrapped in a single outer View so parent layout containers (the
  // Store's `space-y-3` group, Payments' flex-column flow) can apply
  // margins reliably. A Fragment here was causing the banner to
  // visually overlap the card above on the Store screen because
  // NativeWind's `space-y-3` can't target Fragment children.
  return (
    <View>
      <Pressable
        onPress={() => setModalOpen(true)}
        style={({ pressed }) => [
          styles.bannerBase(theme),
          {
            backgroundColor: theme.accentAmberSoft,
            borderColor: theme.accentAmber,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Report a balance or account issue"
      >
        <View style={[styles.iconBubble, { backgroundColor: theme.accentAmber }]}>
          <Feather name="alert-circle" size={16} color="#412402" />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700", marginBottom: 2 }}>
            Missing coins, stars, earnings, or account?
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 11, lineHeight: 16 }}>
            Tell us — we'll review your report within 24-48 hours.
          </Text>
        </View>
        <View style={[styles.ctaPill, { backgroundColor: theme.accentAmber }]}>
          <Feather name="chevron-right" size={14} color="#fff" />
        </View>
      </Pressable>

      <RecoveryRequestModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmitted={() => {
          setModalOpen(false);
          refresh();
        }}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Screenshot upload helper
// ─────────────────────────────────────────────────────────────────────
// Resolves the user's id (Supabase UUID first, Appwrite-resolved messages
// id as fallback). The recovery-screenshots bucket's RLS allows either:
//   • path[1] === auth.uid()::text  (native Supabase auth path), or
//   • path[1] is a UUID and the session is authenticated (Appwrite-auth
//     fallback for users still on the legacy auth bridge).
// We always namespace by user id so admins can audit a user's history.
const resolveUserId = async () => {
  try {
    const cached = getMessagesUserId?.();
    if (cached) return cached;
  } catch (_) {}
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user?.id) return data.user.id;
  } catch (_) {}
  return null;
};

// Upload a local image URI (from expo-image-picker) into the
// `recovery-screenshots` Supabase Storage bucket. Returns the public URL
// stored on the request row's context.screenshot_url. Compresses to WebP
// to keep upload fast on a flaky mobile connection — admins only need a
// readable thumbnail to confirm balance, not a full-res photo.
const uploadRecoveryScreenshot = async (localUri) => {
  if (!localUri) throw new Error("localUri is required");
  const userId = await resolveUserId();
  if (!userId) throw new Error("Not signed in");

  const { uri: compressedUri } = await convertToWebP(localUri, {
    compress: 0.72,
    maxWidth: 1400,
  });

  const response = await fetch(compressedUri);
  if (!response.ok) throw new Error(`Failed to read local image: ${response.status}`);
  const blob = await response.blob();
  const arrayBuffer = await new Response(blob).arrayBuffer();

  const isWebP = compressedUri !== localUri;
  const ext = isWebP
    ? "webp"
    : (localUri.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";

  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const filename = `${userId}/${rand}.${ext}`;

  const { error } = await supabase.storage.from("recovery-screenshots").upload(filename, arrayBuffer, {
    contentType: isWebP ? "image/webp" : (blob.type || `image/${ext}`),
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from("recovery-screenshots").getPublicUrl(filename);
  if (!data?.publicUrl) throw new Error("Could not resolve public URL for screenshot");
  return data.publicUrl;
};

// ─────────────────────────────────────────────────────────────────────
// Modal form
// ─────────────────────────────────────────────────────────────────────
const RecoveryRequestModal = ({ visible, onClose, onSubmitted }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState("coin");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Screenshot state. localUri is the picked file shown as a thumbnail
  // while uploading; remoteUrl is the public Storage URL we stamp onto
  // the request's context.screenshot_url. Tracking both lets us show a
  // preview the moment the user picks vs. only after the upload finishes.
  const [screenshotLocalUri, setScreenshotLocalUri] = useState(null);
  const [screenshotUrl, setScreenshotUrl] = useState(null);
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  const reasonInputRef = useRef(null);

  useEffect(() => {
    if (!visible) {
      setKind("coin");
      setAmount("");
      setReason("");
      setSubmitting(false);
      setError("");
      setScreenshotLocalUri(null);
      setScreenshotUrl(null);
      setUploadingScreenshot(false);
    }
  }, [visible]);

  const activeKind = KINDS.find((k) => k.key === kind) || KINDS[0];
  const needsAmount = activeKind.needsAmount;
  // Submit is gated on:
  //   • not currently submitting
  //   • not currently uploading a screenshot (would race the URL stamp)
  //   • kind-specific validity (account = 5+ char reason; others = amount > 0)
  const canSubmit = !submitting && !uploadingScreenshot && (
    kind === "account"
      ? reason.trim().length >= 5
      : Number(amount) > 0
  );

  // Picker → upload pipeline. Permission prompt first; if the user
  // cancels mid-pick we silently bail. Upload errors surface as an
  // Alert so the user can retry without losing their already-typed
  // amount/reason — we don't fail the whole modal on a flaky network.
  const handlePickScreenshot = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Allow photo access to attach a screenshot.");
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        allowsEditing: false,
      });
      if (picked.canceled || !picked.assets?.[0]?.uri) return;

      const localUri = picked.assets[0].uri;
      setScreenshotLocalUri(localUri);
      setScreenshotUrl(null);
      setUploadingScreenshot(true);
      try {
        const url = await uploadRecoveryScreenshot(localUri);
        setScreenshotUrl(url);
      } catch (e) {
        setScreenshotLocalUri(null);
        Alert.alert("Upload failed", e?.message || "Couldn't upload the screenshot. Try again.");
      } finally {
        setUploadingScreenshot(false);
      }
    } catch (e) {
      setUploadingScreenshot(false);
      Alert.alert("Couldn't open photos", e?.message || "Try again.");
    }
  };

  const handleRemoveScreenshot = () => {
    setScreenshotLocalUri(null);
    setScreenshotUrl(null);
    setUploadingScreenshot(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      // Only include screenshot_url if the upload actually completed —
      // we don't want to send a half-uploaded reference. The submit
      // button is already disabled while uploadingScreenshot is true,
      // so by the time we land here the URL (if present) is final.
      const context = screenshotUrl ? { screenshot_url: screenshotUrl } : undefined;
      const result = await submitRecoveryRequest({
        kind,
        amount: needsAmount ? Number(amount) : 1,
        reason: reason.trim() || null,
        context,
      });
      if (!result?.ok) {
        if (result?.error === "duplicate_pending") {
          setError("You already have a pending report for this. We'll review it soon.");
        } else if (result?.error === "amount_too_large") {
          setError("That amount looks too large. Please double-check.");
        } else {
          setError("Something went wrong. Please try again.");
        }
        setSubmitting(false);
        return;
      }
      onSubmitted?.();
    } catch (e) {
      setError(e?.message || "Couldn't submit. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
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
            backgroundColor: theme.surfaceElevated || theme.background,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingHorizontal: 18,
            paddingTop: 12,
            paddingBottom: insets.bottom + 22,
          }}
        >
          {/* Drag handle */}
          <View style={{ alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border, marginBottom: 14 }} />

          <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
            Report an issue
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 12, marginBottom: 16, lineHeight: 16 }}>
            Tell us what's missing. We review every report within 24-48 hours.
          </Text>

          {/* Kind picker — 2x2 grid of tap-cards */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4, marginBottom: 14 }}>
            {KINDS.map((k) => {
              const isActive = kind === k.key;
              return (
                <View key={k.key} style={{ width: "50%", padding: 4 }}>
                  <Pressable
                    onPress={() => setKind(k.key)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 11,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      backgroundColor: isActive ? theme.accentPurple : theme.surfaceMuted,
                      borderWidth: 1,
                      borderColor: isActive ? theme.accentPurple : theme.border,
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <Ionicons name={k.icon} size={16} color={isActive ? "#fff" : theme.icon} />
                    <Text
                      numberOfLines={1}
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        fontWeight: "600",
                        color: isActive ? "#fff" : theme.text,
                      }}
                    >
                      {k.label}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </View>

          {/* Amount — hidden for account recovery since it's not numeric */}
          {needsAmount ? (
            <View style={{ marginBottom: 12 }}>
              <Text style={{ color: theme.textSoft, fontSize: 11, fontWeight: "600", marginBottom: 6 }}>
                {kind === "earnings" ? "Approximate ₱ amount" : `Approximate ${KIND_NOUN[kind]} amount`}
              </Text>
              <TextInput
                value={amount}
                onChangeText={(t) => setAmount(t.replace(/[^0-9]/g, ""))}
                placeholder="e.g. 800"
                placeholderTextColor={theme.placeholder}
                keyboardType="number-pad"
                style={{
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: Platform.OS === "ios" ? 12 : 8,
                  backgroundColor: theme.inputBackground,
                  borderWidth: 1,
                  borderColor: theme.border,
                  color: theme.inputText,
                  fontSize: 14,
                }}
                returnKeyType="next"
                onSubmitEditing={() => reasonInputRef.current?.focus()}
              />
            </View>
          ) : null}

          {/* Reason — required for account, optional for others */}
          <View style={{ marginBottom: 14 }}>
            <Text style={{ color: theme.textSoft, fontSize: 11, fontWeight: "600", marginBottom: 6 }}>
              {kind === "account"
                ? "What happened? (required)"
                : "Anything else we should know? (optional)"}
            </Text>
            <TextInput
              ref={reasonInputRef}
              value={reason}
              onChangeText={setReason}
              placeholder={
                kind === "account"
                  ? "Lost access to email, can't sign in, etc."
                  : "When you noticed it, last balance you remember…"
              }
              placeholderTextColor={theme.placeholder}
              multiline
              style={{
                minHeight: 70,
                maxHeight: 130,
                borderRadius: 14,
                paddingHorizontal: 14,
                paddingTop: 10,
                paddingBottom: 10,
                backgroundColor: theme.inputBackground,
                borderWidth: 1,
                borderColor: theme.border,
                color: theme.inputText,
                fontSize: 14,
                textAlignVertical: "top",
              }}
            />
          </View>

          {/* Screenshot attachment.
              Optional but strongly encouraged — admins can approve a request
              with proof attached in seconds vs. needing to chase the user
              for context. We render one of three states:
                • Empty   → "Attach a screenshot" tap-card with helper copy
                • Uploading → thumbnail with a spinner overlay + disabled tap
                • Done    → thumbnail with an X-button to remove + replace */}
          <View style={{ marginBottom: 14 }}>
            <Text style={{ color: theme.textSoft, fontSize: 11, fontWeight: "600", marginBottom: 6 }}>
              Screenshot (optional · faster review)
            </Text>
            {screenshotLocalUri ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: theme.surfaceMuted,
                  padding: 10,
                }}
              >
                <View style={{ width: 56, height: 56, borderRadius: 10, overflow: "hidden", backgroundColor: theme.border }}>
                  <Image source={{ uri: screenshotLocalUri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                  {uploadingScreenshot ? (
                    <View
                      style={{
                        position: "absolute",
                        inset: 0,
                        backgroundColor: "rgba(0,0,0,0.45)",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  ) : null}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
                    {uploadingScreenshot ? "Uploading…" : "Screenshot attached"}
                  </Text>
                  <Text style={{ color: theme.textSoft, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
                    {uploadingScreenshot ? "Hang tight — almost done." : "Tap × to remove or replace."}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={handleRemoveScreenshot}
                  disabled={uploadingScreenshot}
                  hitSlop={10}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.border,
                    opacity: uploadingScreenshot ? 0.5 : 1,
                  }}
                >
                  <Feather name="x" size={14} color={theme.text} />
                </TouchableOpacity>
              </View>
            ) : (
              <Pressable
                onPress={handlePickScreenshot}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: theme.border,
                  backgroundColor: theme.surfaceMuted,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.background,
                    borderWidth: 1,
                    borderColor: theme.border,
                  }}
                >
                  <Feather name="image" size={16} color={theme.icon} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
                    Attach a screenshot
                  </Text>
                  <Text style={{ color: theme.textSoft, fontSize: 11, marginTop: 2 }}>
                    Show your previous balance, coin pack, or support reply.
                  </Text>
                </View>
              </Pressable>
            )}
          </View>

          {error ? (
            <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 10 }}>
              {error}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity
              onPress={onClose}
              style={{
                flex: 1,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                borderWidth: 1,
                borderColor: theme.border,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={{
                flex: 1,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                backgroundColor: theme.accentPurple,
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>Submit</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </RNModal>
  );
};

// Inline style helpers — banner shape is shared across all states so
// the only diff between branches is bg color + border + content.
const styles = {
  bannerBase: (theme) => ({
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    // Symmetric self-spacing so the gap above and below the banner
    // is the same regardless of which screen mounts it. Payments has
    // no parent space-y so the banner needs intrinsic margin; Store
    // has `space-y-3` and stacks that on top, but as long as the
    // banner's own top/bottom match, both screens stay balanced.
    // Previously this was 12/14 which left a visible asymmetry on
    // Store between the coins/stars row and the "Earn a free star"
    // card sitting just below.
    marginTop: 12,
    marginBottom: 12,
  }),
  iconBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaPill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
};
