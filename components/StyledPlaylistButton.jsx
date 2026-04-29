import { Entypo } from "@expo/vector-icons";
import axios from "axios";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Animated, Modal, Pressable, Text, TouchableOpacity, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { addToPlaylist, isVideoInPlaylist } from "../lib/appwrite";
import secrets from "../private/secrets";
import ReportModal from "./ReportModal";

function StyledPlaylistButton({ videoId, refetchFunction = async () => {}, ...props }) {
  const { theme } = useAppTheme();
  const { user, globalSettings } = useGlobalContext();
  const [loading, setLoading] = useState(false);
  const [loadingType, setLoadingType] = useState(null); // 'checking', 'adding', 'removing', or null
  const [reportLoading, setReportLoading] = useState(false);
  const [reportDetail, setReportDetail] = useState("");
  const [isInPlaylist, setIsInPlaylist] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [buttonLayout, setButtonLayout] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const buttonRef = useRef(null);
  const dropdownOpacity = useRef(new Animated.Value(0)).current;
  const dropdownScale = useRef(new Animated.Value(0.95)).current;

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      const checkVideoInPlaylist = async () => {
        setLoading(true);
        setLoadingType("checking");
        try {
          const result = await isVideoInPlaylist(user.$id, videoId);
          if (isActive) {
            setIsInPlaylist(result);
          }
        } catch (error) {
          Alert.alert("Error", "Failed to check playlist status. Please try again.");
        } finally {
          if (isActive) {
            setLoading(false);
            setLoadingType(null);
          }
        }
      };

      checkVideoInPlaylist();

      return () => {
        isActive = false;
      };
    }, [user, videoId]),
  );

  const toggleDropdown = () => {
    if (showDropdown) {
      Animated.parallel([
        Animated.timing(dropdownOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(dropdownScale, {
          toValue: 0.95,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start(() => setShowDropdown(false));
    } else {
      buttonRef.current?.measureInWindow((x, y, width, height) => {
        setButtonLayout({ x, y, width, height });
      });
      setShowDropdown(true);
      Animated.parallel([
        Animated.timing(dropdownOpacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(dropdownScale, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  };

  const handleAddToPlaylist = async () => {
    if (loading) return;

    toggleDropdown();
    setLoading(true);
    setLoadingType(isInPlaylist ? "removing" : "adding");
    try {
      await addToPlaylist(videoId, user.$id);
      const updatedStatus = await isVideoInPlaylist(user.$id, videoId);
      setIsInPlaylist(updatedStatus);
      if (refetchFunction) await refetchFunction();
    } catch (error) {
      Alert.alert("Playlist Error", "Failed to add video to playlist. Please try again later.");
    } finally {
      setLoading(false);
      setLoadingType(null);
    }
  };

  const handleOpenReport = () => {
    // Close dropdown with animation first
    Animated.parallel([
      Animated.timing(dropdownOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(dropdownScale, {
        toValue: 0.95,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowDropdown(false);
      // Open report modal after dropdown closes
      setTimeout(() => {
        setShowReportModal(true);
      }, 50);
    });
  };

  const handleCloseReport = () => {
    setShowReportModal(false);
  };

  const handleReport = async (reportDetails) => {
    Alert.alert(
      `Report video`,
      `Are you sure you want to report this video? Confirming will submit your report for review by our team.`,
      [
        {
          text: "No",
          style: "cancel",
        },
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
      <TouchableOpacity ref={buttonRef} className="ml-2" onPress={toggleDropdown}>
        <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
      </TouchableOpacity>

      <Modal visible={showDropdown} transparent animationType="none" onRequestClose={toggleDropdown} statusBarTranslucent>
        <Pressable style={{ flex: 1, backgroundColor: theme.backdrop }} onPress={toggleDropdown} activeOpacity={1}>
          <Animated.View
            onStartShouldSetResponder={() => true}
            style={{
              position: "absolute",
              top: buttonLayout.y + buttonLayout.height + 8,
              right: 8,
              paddingVertical: 8,
              paddingHorizontal: 8,
              borderRadius: 12,
              backgroundColor: theme.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.border,
              shadowColor: theme.overlayStrong,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
              elevation: 10,
              opacity: dropdownOpacity,
              transform: [{ scale: dropdownScale }],
            }}
          >
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleAddToPlaylist}
              disabled={loading}
              accessibilityLabel={isInPlaylist ? "Remove From Playlist" : "Add To Playlist"}
              className="mb-2 rounded-lg px-3 py-2.5"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              {loading ? (
                <View className="flex-row items-center space-x-2">
                  <LoaderKit style={{ width: 16, height: 16 }} name={"BallScaleMultiple"} color={theme.primary} />
                  <Text className="text-sm font-medium" style={{ color: theme.textMuted }}>
                    {loadingType === "checking" ? "Checking..." : loadingType === "adding" ? "Adding..." : "Removing..."}
                  </Text>
                </View>
              ) : (
                <Text className="text-sm font-medium" style={{ color: theme.text }}>
                  {isInPlaylist ? "Remove from playlist" : "Add to playlist"}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleOpenReport}
              className="rounded-lg px-3 py-2.5"
              style={{ backgroundColor: theme.dangerSoft }}
            >
              {reportLoading ? (
                <View className="flex-row items-center space-x-2">
                  <Text className="text-center text-sm font-medium" style={{ color: theme.danger }}>
                    Report
                  </Text>
                  <LoaderKit style={{ width: 16, height: 16 }} name={"BallScaleMultiple"} color={theme.danger} />
                </View>
              ) : (
                <Text className="text-center text-sm font-medium" style={{ color: theme.danger }}>
                  Report
                </Text>
              )}
            </TouchableOpacity>
          </Animated.View>
        </Pressable>
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
