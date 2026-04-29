import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Dimensions, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import { WebView } from "react-native-webview";
import useAppTheme from "../hooks/useAppTheme";
import { account, appwriteConfig } from "../lib/appwrite";
import {
  buildCampaignActionUrl,
  buildCampaignTargetUrl,
  getEligibleHomeCampaign,
  recordCampaignCompletion,
  recordCampaignDismissal,
  recordCampaignImpression,
} from "../lib/campaigns";
import { handleAppLink } from "../utils/appLinks";

const { height: screenHeight, width: screenWidth } = Dimensions.get("window");
const MODAL_MAX_HEIGHT = screenHeight * 0.86;
const MODAL_CARD_WIDTH = Math.min(screenWidth - 24, 420);
const IMAGE_MAX_HEIGHT = screenHeight * 0.68;
const IMAGE_CONTAINER_HEIGHT = Math.min((MODAL_CARD_WIDTH - 32) * (16 / 9), IMAGE_MAX_HEIGHT);

const toStringUrl = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value?.href) return String(value.href).trim();
  if (typeof value?.toString === "function") return String(value.toString()).trim();
  return String(value).trim();
};

const isAppwriteStorageUrl = (value) => {
  const normalized = toStringUrl(value);
  return normalized.startsWith(appwriteConfig.endpoint) && normalized.includes("/storage/buckets/");
};

export default function CampaignAdModal({ enabled, userId, onMessage, onModalOpen, onModalClose }) {
  const { theme } = useAppTheme();
  const [campaign, setCampaign] = useState(null);
  const [visible, setVisible] = useState(false);
  const [stateDocumentId, setStateDocumentId] = useState(null);
  const [webViewError, setWebViewError] = useState(false);
  const [isActionPending, setIsActionPending] = useState(false);
  const [imageSource, setImageSource] = useState(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const attemptUserIdRef = useRef(null);
  const hasAttemptedRef = useRef(false);
  const wasVisibleRef = useRef(false);
  const stateDocumentIdRef = useRef(null);
  const pendingExternalUrlRef = useRef(null);
  const pendingImpressionRef = useRef(null);
  const campaignRequestIdRef = useRef(0);
  const imageRetryWithoutHeadersRef = useRef(false);

  const campaignUrl = buildCampaignTargetUrl(campaign);
  const imageActionUrl = buildCampaignActionUrl(campaign);
  const isImageCampaign = campaign?.contentType === "image";
  const isWebViewCampaign = campaign?.contentType === "web" && campaign?.openMode !== "external_browser";

  useEffect(() => {
    stateDocumentIdRef.current = stateDocumentId;
  }, [stateDocumentId]);

  useEffect(() => {
    if (attemptUserIdRef.current === userId) return;

    attemptUserIdRef.current = userId;
    hasAttemptedRef.current = false;
    campaignRequestIdRef.current += 1;
    pendingImpressionRef.current = null;
    stateDocumentIdRef.current = null;
    setCampaign(null);
    setVisible(false);
    setStateDocumentId(null);
    setWebViewError(false);
    setImageSource(null);
    setIsImageLoading(false);
    setImageLoadFailed(false);
    imageRetryWithoutHeadersRef.current = false;
    pendingExternalUrlRef.current = null;
  }, [userId]);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) onModalOpen?.();
    if (!visible && wasVisibleRef.current && !pendingExternalUrlRef.current) onModalClose?.();
    wasVisibleRef.current = visible;
  }, [onModalClose, onModalOpen, visible]);

  useEffect(() => {
    return () => {
      if (wasVisibleRef.current) onModalClose?.();
    };
  }, [onModalClose]);

  useEffect(() => {
    if (!campaign || !isImageCampaign) {
      setImageSource(null);
      setIsImageLoading(false);
      setImageLoadFailed(false);
      imageRetryWithoutHeadersRef.current = false;
      return;
    }

    let isCancelled = false;
    const imageUrl = toStringUrl(campaign.imageUrl);

    const prepareImageSource = async () => {
      if (!imageUrl) {
        setImageSource(null);
        setImageLoadFailed(true);
        return;
      }

      setImageLoadFailed(false);
      setIsImageLoading(true);
      imageRetryWithoutHeadersRef.current = false;

      if (!isAppwriteStorageUrl(imageUrl)) {
        if (!isCancelled) {
          setImageSource({ uri: imageUrl, priority: FastImage.priority.high });
        }
        return;
      }

      try {
        const { jwt } = await account.createJWT();
        if (isCancelled) return;

        setImageSource({
          uri: imageUrl,
          headers: {
            "X-Appwrite-Project": appwriteConfig.projectId,
            "X-Appwrite-JWT": jwt,
          },
          priority: FastImage.priority.high,
        });
      } catch (error) {
        console.warn("campaign image auth error", error?.message || error);
        if (!isCancelled) {
          setImageSource({ uri: imageUrl, priority: FastImage.priority.high });
        }
      }
    };

    prepareImageSource();

    return () => {
      isCancelled = true;
    };
  }, [campaign, isImageCampaign]);

  useEffect(() => {
    if (!enabled || !userId || hasAttemptedRef.current) return;

    hasAttemptedRef.current = true;

    let isCancelled = false;
    const requestId = campaignRequestIdRef.current + 1;
    campaignRequestIdRef.current = requestId;

    const prepareCampaign = async () => {
      try {
        const eligible = await getEligibleHomeCampaign({ userId });
        if (!eligible?.campaign || isCancelled || campaignRequestIdRef.current !== requestId) return;

        const initialStateDocumentId = eligible.stateDoc?.$id || null;
        stateDocumentIdRef.current = initialStateDocumentId;
        setCampaign(eligible.campaign);
        setStateDocumentId(initialStateDocumentId);
        setVisible(true);

        const impressionPromise = recordCampaignImpression({
          userId,
          campaign: eligible.campaign,
          stateDoc: eligible.stateDoc,
        })
          .then((stateDoc) => {
            const nextStateDocumentId = stateDoc?.$id || eligible.stateDoc?.$id || null;

            if (!isCancelled && campaignRequestIdRef.current === requestId) {
              stateDocumentIdRef.current = nextStateDocumentId;
              setStateDocumentId(nextStateDocumentId);
            }

            return nextStateDocumentId;
          })
          .catch((error) => {
            console.warn("recordCampaignImpression error", error?.message || error);
            return eligible.stateDoc?.$id || null;
          })
          .finally(() => {
            if (pendingImpressionRef.current === impressionPromise) {
              pendingImpressionRef.current = null;
            }
          });

        pendingImpressionRef.current = impressionPromise;
      } catch (error) {
        console.warn("getEligibleHomeCampaign error", error?.message || error);
      }
    };

    prepareCampaign();

    return () => {
      isCancelled = true;
    };
  }, [enabled, userId]);

  const resolveStateDocumentId = useCallback(async () => {
    if (stateDocumentIdRef.current) return stateDocumentIdRef.current;

    const pendingImpression = pendingImpressionRef.current;
    if (!pendingImpression) return null;

    try {
      return (await pendingImpression) || null;
    } catch {
      return null;
    }
  }, []);

  const finalizeStateChange = useCallback(
    async ({ completion = false } = {}) => {
      const currentStateDocumentId = stateDocumentIdRef.current || (await resolveStateDocumentId());
      if (!currentStateDocumentId) return;

      try {
        if (completion) {
          await recordCampaignCompletion({ stateDocumentId: currentStateDocumentId });
        } else {
          await recordCampaignDismissal({ stateDocumentId: currentStateDocumentId });
        }
      } catch (error) {
        console.warn("campaign state update error", error?.message || error);
      }
    },
    [resolveStateDocumentId],
  );

  const handleClose = useCallback(async () => {
    if (!campaign || isActionPending) return;

    setIsActionPending(true);
    setVisible(false);
    await finalizeStateChange();
    setIsActionPending(false);
  }, [campaign, finalizeStateChange, isActionPending]);

  const handleExternalOpen = useCallback(async () => {
    if (!campaignUrl || isActionPending) {
      onMessage?.("Campaign link is unavailable right now.");
      return;
    }

    setIsActionPending(true);
    pendingExternalUrlRef.current = campaignUrl;
    setVisible(false);
    await finalizeStateChange({ completion: true });
    setIsActionPending(false);
  }, [campaignUrl, finalizeStateChange, isActionPending, onMessage]);

  const handleImagePress = useCallback(async () => {
    if (!imageActionUrl || isActionPending) return;

    setIsActionPending(true);
    pendingExternalUrlRef.current = imageActionUrl;
    setVisible(false);
    await finalizeStateChange({ completion: true });
    setIsActionPending(false);
  }, [finalizeStateChange, imageActionUrl, isActionPending]);

  const handleModalHide = useCallback(() => {
    const nextUrl = pendingExternalUrlRef.current;
    pendingExternalUrlRef.current = null;
    campaignRequestIdRef.current += 1;
    pendingImpressionRef.current = null;
    stateDocumentIdRef.current = null;
    setCampaign(null);
    setStateDocumentId(null);
    setWebViewError(false);
    setImageSource(null);
    setIsImageLoading(false);
    setImageLoadFailed(false);
    imageRetryWithoutHeadersRef.current = false;

    if (!nextUrl) return;

    try {
      handleAppLink(nextUrl);
    } catch (error) {
      console.warn("Campaign external open error", error?.message || error);
      onMessage?.("Unable to open the campaign link.");
    }
  }, [onMessage]);

  if (!campaign) return null;

  return (
    <Modal
      isVisible={visible}
      style={{ alignItems: "center", justifyContent: "center", margin: 12 }}
      backdropOpacity={0.5}
      useNativeDriver
      avoidKeyboard
      onBackdropPress={handleClose}
      onBackButtonPress={handleClose}
      onModalHide={handleModalHide}
    >
      {isImageCampaign ? (
        <View className="overflow-hidden rounded-[28px]" style={{ maxHeight: MODAL_MAX_HEIGHT, width: MODAL_CARD_WIDTH }}>
          <View className="items-center justify-center overflow-hidden rounded-[28px]" style={{ height: IMAGE_CONTAINER_HEIGHT, width: "100%" }}>
            {imageSource && !imageLoadFailed ? (
              <TouchableOpacity
                activeOpacity={imageActionUrl ? 0.96 : 1}
                disabled={!imageActionUrl || isActionPending}
                onPress={handleImagePress}
                style={{ height: IMAGE_CONTAINER_HEIGHT, width: "100%" }}
              >
                <FastImage
                  source={imageSource}
                  style={{ height: IMAGE_CONTAINER_HEIGHT, width: "100%" }}
                  resizeMode={FastImage.resizeMode.contain}
                  onLoadStart={() => {
                    setIsImageLoading(true);
                    setImageLoadFailed(false);
                  }}
                  onLoadEnd={() => setIsImageLoading(false)}
                  onError={() => {
                    if (imageRetryWithoutHeadersRef.current) {
                      setIsImageLoading(false);
                      setImageLoadFailed(true);
                      return;
                    }

                    imageRetryWithoutHeadersRef.current = true;
                    setImageSource({ uri: toStringUrl(campaign.imageUrl), priority: FastImage.priority.high });
                  }}
                />
              </TouchableOpacity>
            ) : (
              <Text className="px-6 text-center text-sm leading-5" style={{ color: theme.primaryContrast }}>
                Unable to load this campaign image right now.
              </Text>
            )}

            {isImageLoading ? (
              <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: theme.mediaOverlay }}>
                <ActivityIndicator size="small" color={theme.primaryContrast} />
              </View>
            ) : null}

            <TouchableOpacity className="absolute right-10 top-1 items-center justify-center" onPress={handleClose} disabled={isActionPending}>
              <Ionicons name="close" size={25} color={theme.primaryContrast} />
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View
          className="overflow-hidden rounded-3xl"
          style={{
            maxHeight: MODAL_MAX_HEIGHT,
            width: MODAL_CARD_WIDTH,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surfaceElevated,
          }}
        >
          <View
            className="flex-row items-center justify-between px-5 py-4"
            style={{ borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surfaceMuted }}
          >
            <View className="mr-4 flex-1">
              <Text className="text-base font-semibold" style={{ color: theme.text }}>
                {campaign.name || "Campaign"}
              </Text>
              <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                Featured on Selebox
              </Text>
            </View>

            <TouchableOpacity
              className="rounded-full px-3 py-1.5"
              style={{ backgroundColor: theme.surface }}
              onPress={handleClose}
              disabled={isActionPending}
            >
              <Text className="text-xs font-semibold uppercase tracking-wide" style={{ color: theme.textMuted }}>
                Close
              </Text>
            </TouchableOpacity>
          </View>

          {isWebViewCampaign && campaignUrl && !webViewError ? (
            <View className="h-[520] overflow-hidden" style={{ backgroundColor: theme.mediaBackground }}>
              <WebView
                source={{ uri: campaignUrl }}
                startInLoadingState
                setSupportMultipleWindows={false}
                renderLoading={() => (
                  <View className="flex-1 items-center justify-center" style={{ backgroundColor: theme.backgroundMuted }}>
                    <ActivityIndicator size="small" color={theme.primary} />
                  </View>
                )}
                onError={() => setWebViewError(true)}
              />
            </View>
          ) : (
            <View className="px-5 py-6">
              <Text className="text-center text-sm leading-5" style={{ color: theme.textMuted }}>
                {webViewError
                  ? "This campaign could not load inside the app. You can open it in your browser instead."
                  : "This campaign opens in your browser."}
              </Text>

              {campaignUrl ? (
                <TouchableOpacity
                  className="mt-5 rounded-2xl px-4 py-3"
                  style={{ backgroundColor: isActionPending ? theme.surfaceStrong : theme.primary }}
                  onPress={handleExternalOpen}
                  disabled={isActionPending}
                >
                  <Text className="text-center text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    {isActionPending ? "Opening..." : "Open Campaign"}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </View>
      )}
    </Modal>
  );
}
