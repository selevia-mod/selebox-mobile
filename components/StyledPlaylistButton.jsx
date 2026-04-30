// 3-dot action menu on a video card.
//
// Re-designed to match the post-actions sheet (home.jsx Post actions modal):
// a centered react-native-modal sheet titled "Video actions" with stacked
// rounded-rectangle action rows that each have an icon, a primary label, and
// a small subtitle explaining what it does. Cancel sits at the bottom.
//
// Items, in order:
//   1. Save / Remove (Save for later) — toggles single-playlist membership via
//      the existing addToPlaylist + isVideoInPlaylist API.
//   2. Not interested (See fewer like this) — recommended new action that
//      mirrors the post sheet's "Hide post" semantic. Currently surfaces a
//      lightweight confirmation; the future feed-quality signal can hook into
//      `onNotInterested` when wiring is added.
//   3. Report video (Tell us what's wrong) — opens the existing ReportModal.

import { Entypo, MaterialIcons } from "@expo/vector-icons";
import axios from "axios";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { addToPlaylist, isVideoInPlaylist } from "../lib/appwrite";
import secrets from "../private/secrets";
import ReportModal from "./ReportModal";

function StyledPlaylistButton({
  videoId,
  refetchFunction = async () => {},
  onNotInterested,
  onRequestRemove,
  // When the caller already KNOWS whether the video is in the playlist (e.g.
  // VideosPlaylist tab — every row is by definition in the playlist), pass
  // this prop so we can short-circuit the async isVideoInPlaylist check.
  // Without this, the menu's label can race the user's tap and show
  // "Add to playlist" even though the video is already saved.
  inPlaylist: inPlaylistProp,
  ...props
}) {
  const { theme } = useAppTheme();
  const { user, globalSettings } = useGlobalContext();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [actionLoading, setActionLoading] = useState(null); // 'checking' | 'toggling' | null
  const [reportLoading, setReportLoading] = useState(false);
  const [reportDetail, setReportDetail] = useState("");
  const [isInPlaylist, setIsInPlaylist] = useState(Boolean(inPlaylistProp));
  const [showReportModal, setShowReportModal] = useState(false);

  // Keep state in sync if the caller flips the prop after mount.
  if (typeof inPlaylistProp === "boolean" && inPlaylistProp !== isInPlaylist) {
    // Side-effect during render is intentional and small — same pattern React
    // recommends for "derived state from props" without an effect round-trip.
    setIsInPlaylist(inPlaylistProp);
  }

  useFocusEffect(
    useCallback(() => {
      // Skip the network check entirely if the caller passed a known state.
      if (typeof inPlaylistProp === "boolean") return;

      let isActive = true;
      const checkVideoInPlaylist = async () => {
        if (!user?.$id || !videoId) return;
        setActionLoading("checking");
        try {
          const result = await isVideoInPlaylist(user.$id, videoId);
          if (isActive) setIsInPlaylist(result);
        } catch (error) {
          // swallow — not actionable in the sheet UI; user can still try the action
          console.log("StyledPlaylistButton check error:", error?.message || error);
        } finally {
          if (isActive) setActionLoading(null);
        }
      };
      checkVideoInPlaylist();
      return () => {
        isActive = false;
      };
    }, [inPlaylistProp, user, videoId]),
  );

  const closeSheet = () => setSheetVisible(false);
  const openSheet = () => setSheetVisible(true);

  const handleTogglePlaylist = async () => {
    if (actionLoading) return;
    closeSheet();

    // If the parent owns the remove flow (optimistic remove + undo snackbar
    // pattern in VideosPlaylist), delegate. Skip the network call here so
    // Undo can short-circuit before any DB mutation lands.
    if (isInPlaylist && typeof onRequestRemove === "function") {
      onRequestRemove(videoId);
      return;
    }

    setActionLoading("toggling");
    try {
      await addToPlaylist(videoId, user.$id);
      const updatedStatus = await isVideoInPlaylist(user.$id, videoId);
      setIsInPlaylist(updatedStatus);
      if (refetchFunction) await refetchFunction();
    } catch (error) {
      Alert.alert("Playlist Error", "Failed to update your playlist. Please try again later.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleNotInterested = () => {
    closeSheet();
    // Hook for the parent to remove this video from the local feed / signal the
    // recommendation backend. Falls back to a confirmation toast so taps don't
    // feel inert before the wiring lands.
    if (typeof onNotInterested === "function") {
      onNotInterested(videoId);
      return;
    }
    setTimeout(() => {
      Alert.alert("Got it", "We'll show fewer videos like this.");
    }, 200);
  };

  const handleOpenReport = () => {
    closeSheet();
    setTimeout(() => setShowReportModal(true), 200);
  };

  const handleCloseReport = () => setShowReportModal(false);

  const handleReport = async (reportDetails) => {
    Alert.alert(
      "Report video",
      "Are you sure you want to report this video? Confirming will submit your report for review by our team.",
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            setReportLoading(true);
            try {
              const response = await axios.post("https://67e9284815c6fe834817.appwrite.global", {
                from: "selebox.dev@gmail.com",
                to: JSON.parse(globalSettings["ADMIN_EMAILS"]).join(","),
                cc: user.email,
                bcc: JSON.parse(globalSettings["BCC_EMAILS"]).join(","),
                subject: `${user.username} | Selebox | Reported Video`,
                html: `
                  <p><strong>Dear Selebox Team,</strong></p>
                  <p>I am writing to report this video <b><u>${secrets.WEBSITE}${videoId}</u></b>. Please find this report for your review.</p>
                  <p><strong>Report Detail:</strong></p>
                  <p>${reportDetails}</p>
                  <p>Thank you for your time and consideration.</p>
                  <p>Best regards,<br>
                  ${user.username}<br>
                  ${user.accountId}<br>
                  ${user.email}<br>
                  ${new Date(user?.$createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>`,
              });
              if (response.data.success) {
                setReportDetail("");
                setShowReportModal(false);
                Alert.alert("Success", "Your report has been submitted for review.");
              } else {
                Alert.alert("Error", "There was an error submitting your report. Please try again.");
              }
            } catch (error) {
              Alert.alert("Error", error.message);
            }
            setReportLoading(false);
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <>
      <TouchableOpacity className="ml-2" onPress={openSheet} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} {...props}>
        <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
      </TouchableOpacity>

      <Modal isVisible={sheetVisible} onBackdropPress={closeSheet} onBackButtonPress={closeSheet} backdropOpacity={0.6} useNativeDriver>
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Video actions
          </Text>

          <TouchableOpacity
            className="mt-4 rounded-xl px-4 py-3"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={handleTogglePlaylist}
            disabled={actionLoading === "toggling"}
          >
            <View className="flex flex-row items-center justify-between">
              <View className="flex flex-row items-center">
                <MaterialIcons name={isInPlaylist ? "playlist-add-check" : "playlist-add"} size={22} color={theme.icon} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.text }}>
                    {isInPlaylist ? "Remove from playlist" : "Add to playlist"}
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    {isInPlaylist ? "Take it out of your saved videos" : "Save it for later"}
                  </Text>
                </View>
              </View>
              {actionLoading === "toggling" ? <ActivityIndicator size="small" color={theme.primary} /> : null}
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-2 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleNotInterested}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="visibility-off" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Not interested
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  See fewer videos like this
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-2 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleOpenReport}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="flag" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Report video
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Tell us what’s wrong
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-3 items-center" onPress={closeSheet}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <ReportModal
        type="Video"
        isVisible={showReportModal}
        onClose={handleCloseReport}
        handleSubmitReport={handleReport}
        reportDetail={reportDetail}
        setReportDetail={setReportDetail}
        reportLoading={reportLoading}
      />
    </>
  );
}

export default StyledPlaylistButton;
