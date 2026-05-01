// Profile kebab menu — sheet with the same visual language as StyledPlaylistButton
// (the Video 3-dot menu) and the home-feed Post actions modal: centered
// react-native-modal, title at top, stacked rounded-rectangle action rows with
// icon + primary label + small subtitle, Cancel at bottom.
//
// Item visibility:
//   - Share Profile        — always shown
//   - Report User / Snooze / Block — only on OTHER users' profiles
//
// Wiring:
//   - Share        → react-native-share (consistent with how books, clips,
//                    posts already share via the same util)
//   - Report User  → opens ReportModal, on submit emails admins via the
//                    existing appwrite.global function (mirrors the video
//                    report flow in StyledPlaylistButton)
//   - Block        → confirmation Alert → lib/safety.blockUser
//   - Snooze       → friendly Alert + TODO; full backend lands when
//                    feed_signals collection is added in the Phase 5 migration
//
// Modal-hide deferred dispatch:
//   Tapping any action button does NOT execute the action immediately. We
//   stash the chosen action in `pendingActionRef`, close the sheet, then run
//   the action via TWO complementary mechanisms:
//     1) `onModalHide` — fires after the dismiss animation finishes (primary).
//     2) `setTimeout` fallback (550ms) — fires if onModalHide somehow misses
//        (some platform/animation combos drop the callback, which produced
//        the previously-reported "first tap closes, second tap works" bug,
//        most visibly on the user's own profile where the menu only has the
//        Share row and there's no second tap to fall back on).
//   A `dispatchedRef` guards against double-firing when both paths run.

import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import playbackEvents from "../lib/playback-events";
import { blockUser } from "../lib/safety";
import secrets from "../private/secrets";
import ReportModal from "./ReportModal";

const PENDING_ACTION_FALLBACK_MS = 550;

const ProfileActionsMenu = ({
  // Target profile (the user being viewed)
  targetUser,
  // True when the logged-in user is viewing their own profile.
  // Hides Report / Snooze / Block.
  isOwnProfile = false,
  // Optional callback after a successful block so the parent can route away
  // (e.g. router.back()) and refresh blocked-user lists.
  onBlocked,
  // Style overrides for the trigger button (rare; defaults to a premium pill).
  triggerStyle,
}) => {
  const { theme } = useAppTheme();
  const { user, globalSettings } = useGlobalContext();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportDetail, setReportDetail] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null); // 'blocking' | null

  // Holds the action the user picked from the sheet so it can fire from
  // onModalHide once the dismiss animation finishes. Ref instead of state so
  // we don't trigger an extra render between tap and dispatch.
  const pendingActionRef = useRef(null);
  // Guards against the action firing twice when both onModalHide AND the
  // setTimeout fallback resolve (whichever lands first wins).
  const dispatchedRef = useRef(false);
  const fallbackTimerRef = useRef(null);

  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  // Cancel any pending fallback timer if the component unmounts mid-animation
  // — otherwise we'd dispatch into a torn-down component and trigger warnings.
  useEffect(() => clearFallbackTimer, []);

  const closeSheet = () => setSheetVisible(false);
  // Opening the sheet broadcasts a "pause-all" signal so any autoplaying
  // PostVideo / PostClip on the underlying screen releases playback ownership.
  // Without this, the share sheet (UIActivityViewController on iOS) ends up
  // competing with the video player for system focus and gets force-closed
  // before the user can interact — most visibly on the user's own profile,
  // where the videos tab autoplays a clip directly under the kebab. The fix
  // landed once the user pinpointed the autoplay video as the culprit.
  const openSheet = () => {
    try {
      playbackEvents.emit("pause-all");
    } catch (_) {}
    setSheetVisible(true);
  };

  const targetName = targetUser?.username || targetUser?.name || "this user";
  const targetId = targetUser?.$id || targetUser?.id;

  const runShare = async () => {
    if (!targetId) {
      Alert.alert("Cannot share", "User information is missing.");
      return;
    }
    try {
      await Share.open({
        title: targetUser?.username || "Selebox profile",
        message: `Check out ${targetName} on Selebox`,
        url: `${secrets.WEBSITE}/profile/${targetId}`,
      });
    } catch (error) {
      // User-dismissed share is normal; only log unexpected errors.
      if (error?.message && !/User did not share/i.test(error.message)) {
        console.log("ProfileActionsMenu share error:", error.message);
      }
    }
  };

  const runOpenReport = () => {
    setShowReportModal(true);
  };

  const handleCloseReport = () => setShowReportModal(false);

  const handleSubmitReport = async (reportDetails) => {
    Alert.alert(
      "Report user",
      `Are you sure you want to report ${targetName}? Confirming will submit your report for review by our team.`,
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            setReportLoading(true);
            try {
              const adminEmails = (() => {
                try {
                  return JSON.parse(globalSettings["ADMIN_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const bccEmails = (() => {
                try {
                  return JSON.parse(globalSettings["BCC_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const response = await axios.post("https://67e9284815c6fe834817.appwrite.global", {
                from: "selebox.dev@gmail.com",
                to: adminEmails,
                cc: user?.email,
                bcc: bccEmails,
                subject: `${user?.username} | Selebox | Reported User`,
                html: `
                  <p><strong>Dear Selebox Team,</strong></p>
                  <p>I am writing to report this user <b><u>${secrets.WEBSITE}/profile/${targetId}</u></b> (${targetName}). Please find this report for your review.</p>
                  <p><strong>Report Detail:</strong></p>
                  <p>${reportDetails}</p>
                  <p>Thank you for your time and consideration.</p>
                  <p>Best regards,<br>
                  ${user?.username}<br>
                  ${user?.accountId}<br>
                  ${user?.email}<br>
                  ${new Date(user?.$createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>`,
              });
              if (response.data?.success) {
                setReportDetail("");
                setShowReportModal(false);
                Alert.alert("Success", "Your report has been submitted for review.");
              } else {
                Alert.alert("Error", "There was an error submitting your report. Please try again.");
              }
            } catch (error) {
              Alert.alert("Error", error?.message || "Failed to submit report.");
            }
            setReportLoading(false);
          },
        },
      ],
      { cancelable: true },
    );
  };

  const runSnooze = () => {
    // TODO(phase-5): wire to a feed_signals collection that Discover / For You
    // reads filter against. The doc-level intent here is "hide this user's
    // content from algorithmic feeds for 30 days; their profile is still
    // visitable directly". Match the pattern used by the Videos 'Not interested'
    // signal once that backend lands.
    Alert.alert("Snoozed for 30 days", `You'll see less of ${targetName} for the next 30 days. You can still visit their profile directly.`);
  };

  const runBlockPrompt = () => {
    Alert.alert(
      "Block user",
      `Block ${targetName}? Their content will be hidden from your feeds and they won't be able to interact with you. You can unblock them later from settings.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            if (!user?.$id || !targetId) {
              Alert.alert("Cannot block", "User information is missing.");
              return;
            }
            setActionLoading("blocking");
            try {
              await blockUser({
                blockerId: user.$id,
                blockedUserId: targetId,
                contentId: targetId,
                contentType: "profile",
                reason: "user_block",
              });
              Alert.alert("Blocked", `${targetName} has been blocked.`);
              if (typeof onBlocked === "function") onBlocked(targetUser);
            } catch (error) {
              console.log("ProfileActionsMenu block error:", error?.message || error);
              Alert.alert("Error", "Could not block this user. Please try again.");
            } finally {
              setActionLoading(null);
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  const dispatchPending = () => {
    if (dispatchedRef.current) return;
    const action = pendingActionRef.current;
    if (!action) return;
    dispatchedRef.current = true;
    pendingActionRef.current = null;
    clearFallbackTimer();

    // Modal-stacking race fix — same root cause as the chat-report bug
    // (task #37). On iOS, calling Share.open() / Alert.alert while
    // react-native-modal is still mid-dismiss makes the native sheet /
    // alert appear AND immediately get rejected by the OS (or never
    // appear at all). The kebab menu visually closes but nothing
    // happens. The 80ms buffer lets the dismiss animation flush before
    // we open the next system UI — same number of milliseconds chat
    // landed on after testing. Snooze + Block (which use Alert.alert)
    // get the same delay; Report just toggles a React state, no need.
    const NATIVE_UI_DELAY_MS = 80;

    switch (action) {
      case "share":
        setTimeout(runShare, NATIVE_UI_DELAY_MS);
        break;
      case "report":
        runOpenReport();
        break;
      case "snooze":
        setTimeout(runSnooze, NATIVE_UI_DELAY_MS);
        break;
      case "block":
        setTimeout(runBlockPrompt, NATIVE_UI_DELAY_MS);
        break;
      default:
        break;
    }
  };

  // All four buttons defer to onModalHide via pendingActionRef so the action
  // fires only after the sheet's dismiss animation finishes. A setTimeout
  // fallback runs in parallel as a safety net — see header comment for the
  // own-profile-only race that motivated the dual-path dispatch.
  const queueAction = (action) => {
    pendingActionRef.current = action;
    dispatchedRef.current = false;
    clearFallbackTimer();
    fallbackTimerRef.current = setTimeout(dispatchPending, PENDING_ACTION_FALLBACK_MS);
    closeSheet();
  };

  const handleModalHide = () => {
    dispatchPending();
  };

  // Trigger button — glass-tinted dark disc designed to sit on top of the
  // profile banner art. Reads as a polished translucent control in the
  // language of iOS native player overlays. White ellipsis-horizontal icon
  // (cleaner than the previous vertical kebab) with a subtle glass rim.
  const defaultTriggerStyle = {
    height: 36,
    width: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.22)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  };

  return (
    <>
      <TouchableOpacity
        onPress={openSheet}
        accessibilityLabel="Profile actions"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={[defaultTriggerStyle, triggerStyle]}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color="#FFFFFF" />
      </TouchableOpacity>

      <Modal
        isVisible={sheetVisible}
        onBackdropPress={closeSheet}
        onBackButtonPress={closeSheet}
        onModalHide={handleModalHide}
        backdropOpacity={0.6}
        useNativeDriver
      >
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Profile actions
          </Text>

          {/* Share — always visible */}
          <TouchableOpacity
            className="mt-4 rounded-xl px-4 py-3"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => queueAction("share")}
          >
            <View className="flex flex-row items-center">
              <MaterialIcons name="ios-share" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Share profile
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Send this profile to a friend
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          {/* Report / Snooze / Block — only on other users' profiles */}
          {!isOwnProfile && (
            <>
              <TouchableOpacity
                className="mt-2 rounded-xl px-4 py-3"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={() => queueAction("report")}
              >
                <View className="flex flex-row items-center">
                  <MaterialIcons name="flag" size={22} color={theme.icon} style={{ marginRight: 12 }} />
                  <View>
                    <Text className="text-base font-semibold" style={{ color: theme.text }}>
                      Report user
                    </Text>
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      Tell us what's wrong
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                className="mt-2 rounded-xl px-4 py-3"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={() => queueAction("snooze")}
              >
                <View className="flex flex-row items-center">
                  <MaterialIcons name="schedule" size={22} color={theme.icon} style={{ marginRight: 12 }} />
                  <View>
                    <Text className="text-base font-semibold" style={{ color: theme.text }}>
                      Snooze for 30 days
                    </Text>
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      See less of this user in your feeds
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                className="mt-2 rounded-xl px-4 py-3"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={() => queueAction("block")}
                disabled={actionLoading === "blocking"}
              >
                <View className="flex flex-row items-center">
                  <MaterialIcons name="block" size={22} color={theme.iconDanger ?? "#ef4444"} style={{ marginRight: 12 }} />
                  <View>
                    <Text className="text-base font-semibold" style={{ color: theme.iconDanger ?? "#ef4444" }}>
                      Block user
                    </Text>
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      Hide their content and stop interactions
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity className="mt-3 items-center" onPress={closeSheet}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <ReportModal
        type="User"
        isVisible={showReportModal}
        onClose={handleCloseReport}
        handleSubmitReport={handleSubmitReport}
        reportDetail={reportDetail}
        setReportDetail={setReportDetail}
        reportLoading={reportLoading}
      />
    </>
  );
};

export default ProfileActionsMenu;
