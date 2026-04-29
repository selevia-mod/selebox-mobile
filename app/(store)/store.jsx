import { FontAwesome5, MaterialIcons } from "@expo/vector-icons";
import axios from "axios";
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Animated, FlatList, Platform, Text, TouchableOpacity, View } from "react-native";
import { useIAP, withIAPContext } from "react-native-iap";
import { CustomAlertModal, StarIcon, StyledDivider, StyledSafeAreaView } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { useRewardedStar } from "../../hooks/useRewardedStars";
import { getCoinPacks, updateUserCoins } from "../../lib/appwrite";
import secrets from "../../private/secrets";

const StoreSkeleton = () => {
  const { theme } = useAppTheme();

  return (
    <View className="h-full w-full px-4 pb-5" style={{ backgroundColor: theme.background }}>
      <View className="mt-2 flex-row items-center">
        <AnimatedSkeleton className="h-10 w-10 rounded-full" />
        <View className="ml-3 flex-1">
          <AnimatedSkeleton className="h-6 w-24 rounded" />
          <AnimatedSkeleton className="mt-2 h-3 w-40 rounded" />
        </View>
        <AnimatedSkeleton className="h-6 w-16 rounded-full" />
      </View>

      <FlatList
        data={[1, 2, 3]}
        keyExtractor={(item) => `store-skeleton-${item}`}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 12 }}
        ListHeaderComponent={
          <View className="mt-4 space-y-3">
            <View className="flex-row space-x-3">
              <View className="flex-1 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className="h-10 w-10 rounded-full" />
                  <View className="flex-1">
                    <AnimatedSkeleton className="h-3 w-20 rounded" />
                    <AnimatedSkeleton className="mt-2 h-4 w-24 rounded" />
                  </View>
                </View>
              </View>
              <View className="flex-1 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className="h-10 w-10 rounded-full" />
                  <View className="flex-1">
                    <AnimatedSkeleton className="h-3 w-20 rounded" />
                    <AnimatedSkeleton className="mt-2 h-4 w-24 rounded" />
                  </View>
                </View>
              </View>
            </View>

            <View className="rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              <AnimatedSkeleton className="h-5 w-36 rounded" />
              <AnimatedSkeleton className="mt-2 h-3 w-56 rounded" />
              <AnimatedSkeleton className="mt-3 h-2 w-full rounded-full" />
              <View className="mt-3 flex-row items-center justify-between">
                <AnimatedSkeleton className="h-3 w-20 rounded" />
                <AnimatedSkeleton className="h-8 w-24 rounded-xl" />
              </View>
            </View>

            <View className="mt-1 flex-row items-center justify-between">
              <View>
                <AnimatedSkeleton className="h-5 w-24 rounded" />
                <AnimatedSkeleton className="mt-2 h-3 w-44 rounded" />
              </View>
              <AnimatedSkeleton className="h-6 w-16 rounded-full" />
            </View>
          </View>
        }
        renderItem={() => (
          <View className="my-2 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-3">
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className="h-11 w-11 rounded-full" />
                  <View className="flex-1">
                    <AnimatedSkeleton className="h-4 w-28 rounded" />
                    <AnimatedSkeleton className="mt-2 h-3 w-20 rounded" />
                  </View>
                </View>
                <AnimatedSkeleton className="mt-3 h-3 w-32 rounded" />
                <AnimatedSkeleton className="mt-2 h-3 w-40 rounded" />
              </View>
              <View className="items-center">
                <AnimatedSkeleton className="h-10 w-20 rounded-xl" />
                <AnimatedSkeleton className="mt-2 h-3 w-16 rounded" />
              </View>
            </View>
          </View>
        )}
        ListFooterComponent={
          <View className="mt-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <View className="items-center">
              <AnimatedSkeleton className="h-3 w-24 rounded" />
            </View>
            <AnimatedSkeleton className="mt-3 h-3 w-full rounded" />
            <AnimatedSkeleton className="mt-2 h-3 w-5/6 rounded" />
          </View>
        }
      />
    </View>
  );
};

const Store = () => {
  const { theme } = useAppTheme();
  const { products, finishTransaction, getProducts, requestPurchase } = useIAP();
  const [coinPacks, setCoinPacks] = useState([]);
  const { globalSettings, user, balance, refetchBalance, expoPushToken, refetchStars, starsData, setStarsData } = useGlobalContext();
  const { showAd, starLoading, showPlusOne, cooldownMessageOpen, remainingTime, setCooldownMessageOpen, plusOneAnim } = useRewardedStar({
    userId: user?.$id,
    cooldownSeconds: globalSettings["WATCH_AD_COOLDOWN_TIMER"],
    setStarsData,
  });
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const osName = Platform.OS;
  const dailyLimit = starsData?.maxAdsPerDay || 0;
  const watchedToday = starsData?.adsWatchedToday || 0;
  const limitReached = watchedToday >= dailyLimit;
  const remainingAds = Math.max(dailyLimit - watchedToday, 0);
  const progress = dailyLimit > 0 ? Math.min((watchedToday / dailyLimit) * 100, 100) : 0;
  const showSkeleton = loading || coinPacks.length === 0 || (products.length === 0 && osName === "ios");

  const getBonusPercent = useCallback((coins, free) => {
    if (!coins) return 0;
    return Math.max(0, Math.round(((coins + free) / coins - 1) * 100));
  }, []);

  const bestValueId = useMemo(() => {
    if (!coinPacks.length) return null;
    return coinPacks.reduce((best, pack) => {
      const bestBonus = getBonusPercent(best.coins, best.free);
      const packBonus = getBonusPercent(pack.coins, pack.free);
      if (packBonus > bestBonus) return pack;
      if (packBonus === bestBonus && pack.coins > best.coins) return pack;
      return best;
    }, coinPacks[0]).$id;
  }, [coinPacks, getBonusPercent]);

  useFocusEffect(
    useCallback(() => {
      fetchCoinPacks();
      refetchBalance(user?.$id);
      refetchStars();
    }, [user]),
  );

  const fetchCoinPacks = useCallback(async () => {
    try {
      const response = await getCoinPacks();
      if (osName === "ios") {
        handleGetProductsIOS(response);
        setCoinPacks(response);
        return () => {
          RNIap.endConnection();
        };
      } else {
        setCoinPacks(response);
      }
    } catch (error) {
      console.error(error.message);
    }
  }, []);

  const handleGetProductsIOS = async (response) => {
    try {
      await getProducts({ skus: response.map((p) => p.iapIOSProductID) });
    } catch (error) {
      console.error(error.message);
    }
  };

  const submitPaymentIOS = async (coins, iapIOSProductID) => {
    setLoading(true);
    try {
      const purchase = await requestPurchase({ sku: iapIOSProductID });
      if (purchase.transactionId || purchase.transactionReceipt) {
        await finishTransaction({
          purchase: purchase,
          isConsumable: true,
        });
        await updateUserCoins(user.$id, balance + coins);
        await refetchBalance(user.$id);
      }
    } catch (error) {
      console.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const submitPaymentAndroid = async (coins, price) => {
    setLoading(true);
    try {
      if (price < 20) {
        Alert.alert("Invalid Price", "The price must be greater than ₱20 to process the payment.");
        return;
      }
      const response = await axios.post(
        "https://api.hit-pay.com/v1/payment-requests",
        {
          amount: price,
          currency: "PHP",
          email: user.email,
          purpose: `You will receive ${coins} Coins`,
          send_email: true,
          webhook: `https://673a3a1162eb53830d78.appwrite.global?userID=${user.$id}&userToken=${expoPushToken}&coins=${coins}`,
        },
        { headers: { "X-BUSINESS-API-KEY": secrets.HITPAY_SECRET_KEY, "Content-Type": "application/json" } },
      );

      const { url } = response.data;
      await WebBrowser.openBrowserAsync(url);
      await refetchBalance(user.$id);
      router.dismissTo("/home");
    } catch (error) {
      Alert.alert("Submit Payment Error", error.message);
    } finally {
      setLoading(false);
    }
  };

  const renderCoinPacks = ({ item }) => {
    const totalCoins = item.coins + item.free;
    const bonusPercent = getBonusPercent(item.coins, item.free);
    const isBestValue = item.$id === bestValueId;
    const priceLabel =
      osName === "ios" ? products.find((product) => product.productId === item.iapIOSProductID)?.localizedPrice || "..." : `₱${item.price}`;

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => (osName === "ios" ? submitPaymentIOS(totalCoins, item.iapIOSProductID) : submitPaymentAndroid(totalCoins, item.price))}
        className="my-2 rounded-2xl border p-4"
        style={{
          borderColor: isBestValue ? theme.accentAmber : theme.border,
          backgroundColor: isBestValue ? theme.accentAmberSoft : theme.card,
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            <View className="flex-row items-center space-x-3">
              <View className="h-11 w-11 items-center justify-center rounded-full" style={{ backgroundColor: theme.accentAmberSoft }}>
                <FontAwesome5 name="coins" size={20} color={theme.coin} />
              </View>
              <View>
                <Text className="font-pbold text-lg" style={{ color: theme.text }}>
                  {item.coins} Coins
                </Text>
                <Text className="font-plight text-xs" style={{ color: theme.textSoft }}>
                  {item.free === 0 ? "No free coins" : `+${item.free} free coins`}
                </Text>
              </View>
            </View>
            <View className="mt-3 flex-row items-center space-x-2">
              <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className="text-[10px] font-psemibold" style={{ color: theme.textSoft }}>
                  Bonus {bonusPercent}%
                </Text>
              </View>
              {isBestValue && (
                <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.accentGreenSoft }}>
                  <Text className="text-[10px] font-psemibold" style={{ color: theme.accentGreen }}>
                    Best value
                  </Text>
                </View>
              )}
            </View>
            <Text className="mt-2 text-[11px]" style={{ color: theme.textSoft }}>
              Total {totalCoins} coins delivered instantly
            </Text>
          </View>
          <View className="items-center">
            <View className="rounded-xl px-4 py-2" style={{ backgroundColor: theme.primary }}>
              <Text className="font-psemibold" style={{ color: theme.primaryContrast }}>
                {priceLabel}
              </Text>
            </View>
            <Text className="mt-2 text-[10px] font-psemibold" style={{ color: theme.textSoft }}>
              Tap to buy
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <StyledSafeAreaView style={{ backgroundColor: theme.background }}>
      {/* Success modal */}
      <CustomAlertModal
        message={successMessage}
        icon={<StarIcon size={75} color="#fbbf24" />}
        messageOpen={!!successMessage}
        closeMessage={() => setSuccessMessage("")}
      />
      {/* Cooldown modal */}
      <CustomAlertModal
        message={`No ads available right now.\n⏳ Please try again in ${remainingTime} seconds.`}
        icon={<MaterialIcons name="timer" size={75} color="#f87171" />}
        messageOpen={cooldownMessageOpen}
        closeMessage={() => setCooldownMessageOpen(false)}
      />
      {showSkeleton ? (
        <StoreSkeleton />
      ) : (
        <View className="h-full w-full px-4 pb-5" style={{ backgroundColor: theme.background }}>
          <View className="mt-2 flex-row items-center">
            <TouchableOpacity
              activeOpacity={0.7}
              className="h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
              onPress={() => {
                router.back();
              }}
            >
              <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
            </TouchableOpacity>
            <View className="ml-3 flex-1">
              <Text className="font-pbold text-2xl" style={{ color: theme.text }}>
                Store
              </Text>
            </View>
          </View>

          <FlatList
            data={coinPacks}
            renderItem={renderCoinPacks}
            keyExtractor={(item) => item.$id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 12 }}
            ListHeaderComponent={
              <View className="mt-4 space-y-3">
                <View className="flex-row space-x-3">
                  <View className="flex-1 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                    <View className="flex-row items-center space-x-3">
                      <View className="h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: theme.accentAmberSoft }}>
                        <FontAwesome5 name="coins" size={20} color={theme.coin} />
                      </View>
                      <View>
                        <Text className="font-plight text-xs" style={{ color: theme.textSoft }}>
                          Coins balance
                        </Text>
                        <Text className="font-psemibold text-lg" style={{ color: theme.text }}>
                          {balance} Coins
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View className="flex-1 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                    <View className="flex-row items-center space-x-3">
                      <View className="h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: theme.accentAmberSoft }}>
                        <StarIcon size={22} color={theme.coin} />
                      </View>
                      <View>
                        <Text className="font-plight text-xs" style={{ color: theme.textSoft }}>
                          Stars balance
                        </Text>
                        {loading ? (
                          <View className="mt-1 h-4 w-16 animate-pulse rounded-md" style={{ backgroundColor: theme.surfaceMuted }} />
                        ) : (
                          <View>
                            {showPlusOne ? (
                              <Animated.Text
                                style={{
                                  color: theme.coin,
                                  fontSize: 18,
                                  fontWeight: "bold",
                                  transform: [{ translateY: plusOneAnim }],
                                  textAlign: "left",
                                }}
                              >
                                +1
                              </Animated.Text>
                            ) : (
                              <Text style={{ color: theme.text, fontSize: 18, fontWeight: "bold" }}>{starsData?.stars} Stars</Text>
                            )}
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                </View>

                <View className="rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.accentAmber, backgroundColor: theme.accentAmberSoft }}>
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="font-pbold text-lg" style={{ color: theme.text }}>
                        Earn a free star
                      </Text>
                      <Text className="mt-1 font-plight text-xs" style={{ color: theme.textSoft }}>
                        Watch a short ad to earn 1 Star. {remainingAds} left today.
                      </Text>
                    </View>
                    <View className="h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: theme.accentAmberSoft }}>
                      <StarIcon size={26} color={theme.coin} />
                    </View>
                  </View>
                  <View className="mt-3 h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
                    <View className="h-2 rounded-full" style={{ width: `${progress}%`, backgroundColor: theme.accentAmber }} />
                  </View>
                  <View className="mt-3 flex-row items-center justify-between">
                    <Text className="text-xs" style={{ color: theme.textSoft }}>
                      {watchedToday}/{dailyLimit} watched
                    </Text>
                    <TouchableOpacity
                      className="rounded-xl px-4 py-2"
                      onPress={showAd}
                      disabled={limitReached}
                      style={{ backgroundColor: limitReached ? theme.surfaceMuted : theme.accentAmber }}
                    >
                      <Text className="text-xs font-psemibold" style={{ color: limitReached ? theme.textSoft : theme.textInverse }}>
                        {limitReached ? "Limit Reached" : "Watch Ad"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View className="mt-1 flex-row items-center justify-between">
                  <View>
                    <Text className="font-pbold text-lg" style={{ color: theme.text }}>
                      Coin Packs
                    </Text>
                    <Text className="font-plight text-xs" style={{ color: theme.textSoft }}>
                      Choose the pack that fits you best
                    </Text>
                  </View>
                </View>
              </View>
            }
            ListFooterComponent={
              <View className="mt-4 rounded-2xl p-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                <StyledDivider color={theme.divider}>
                  <Text className="text-center font-sans text-[10px] font-bold" style={{ color: theme.textSoft }}>
                    Disclaimer
                  </Text>
                </StyledDivider>
                <Text className="mt-2 text-center font-pextralight text-xs" style={{ color: theme.textMuted }}>
                  "We do not collect, store, or process any credit card or billing information. All transactions are handled securely through
                  third-party payment providers."
                </Text>
              </View>
            }
          />
        </View>
      )}
      {starLoading && (
        <View className="absolute bottom-0 left-0 right-0 top-0 z-50 flex items-center justify-center" style={{ backgroundColor: theme.backdrop }}>
          <View className="rounded-lg p-6" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
            <ActivityIndicator size="large" color={theme.coin} />
            <Text className="mt-3 font-psemibold" style={{ color: theme.text }}>
              Earning your star...
            </Text>
          </View>
        </View>
      )}
    </StyledSafeAreaView>
  );
};

export default withIAPContext(Store);
