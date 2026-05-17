import { FontAwesome5, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Animated, FlatList, Platform, Text, TouchableOpacity, View } from "react-native";
import { useIAP, withIAPContext } from "react-native-iap";
import { BalanceRecoveryBanner, CustomAlertModal, StarIcon, StyledDivider, StyledSafeAreaView } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import GoalsTab from "../../components/GoalsTab";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { useRewardedStar } from "../../hooks/useRewardedStars";
import { getCoinPacks, updateUserCoins } from "../../lib/appwrite";
import { USE_SUPABASE_WALLET } from "../../lib/feature-flags";
import supabase from "../../lib/supabase";
import { narrowOverride } from "../../lib/utils/responsive";

// Pre-computed once at module load. Hoisting these out of the JSX
// removes 56 narrowOverride() calls + dozens of fresh className-string
// allocations per render of the Store screen on Infinix. The `_no`
// alias keeps replace_all-style edits safe — searching for
// `narrowOverride(X, Y)` won't accidentally clobber the constant
// definitions themselves.
const _no = narrowOverride;
// Numeric (icon sizes, container w/h, fontSize)
const S_AV_36       = _no(36, 40); // back button + balance card icon containers (w/h)
const S_AV_40       = _no(40, 44); // coin pack icon container (w/h)
const S_AV_40_48    = _no(40, 48); // earn-a-star big icon container (w/h)
const S_ICON_17_20  = _no(17, 20); // FontAwesome5 coins glyph
const S_ICON_19_22  = _no(19, 22); // back arrow + StarIcon balance
const S_ICON_22_26  = _no(22, 26); // earn-a-star StarIcon
const S_FS_16_18    = _no(16, 18); // Stars-value fontSize (animated +1)
// Class strings (NativeWind)
const S_PAD_CARD    = _no("p-3", "p-4");
const S_PRICE_PAD   = _no("px-2.5 py-1", "px-4 py-2");
const S_WATCH_PAD   = _no("px-3 py-1.5", "px-4 py-2");
const S_TAB_PAD_Y   = _no("py-1.5", "py-2.5");
const S_HEADING     = _no("text-base", "text-lg");
const S_BODY        = _no("text-[11px]", "text-xs");
const S_TINY        = _no("text-[9px]", "text-[10px]");
const S_FOOTNOTE    = _no("text-[10px]", "text-[11px]");
const S_TAB_LABEL   = _no("text-[13px]", "text-sm");
const S_TITLE       = _no("text-xl", "text-2xl");
// Skeleton-only sizes
const S_SK_BAL_ICON = _no("h-9 w-9", "h-10 w-10");
const S_SK_BAL_VAL  = _no("h-3.5 w-20", "h-4 w-24");
const S_SK_PACK_ICN = _no("h-10 w-10", "h-11 w-11");
const S_SK_PACK_TTL = _no("h-3.5 w-24", "h-4 w-28");
const S_SK_HDR_TTL  = _no("h-5 w-20", "h-6 w-24");
const S_SK_STAR_TTL = _no("h-4 w-32", "h-5 w-36");
const S_SK_WATCH_BT = _no("h-7 w-20", "h-8 w-24");
const S_SK_PACKS_T  = _no("h-4 w-20", "h-5 w-24");
const S_SK_PRICE_BT = _no("h-9 w-16", "h-10 w-20");

const StoreSkeleton = () => {
  const { theme } = useAppTheme();

  return (
    <View className="h-full w-full px-4 pb-5" style={{ backgroundColor: theme.background }}>
      <View className="mt-2 flex-row items-center">
        <AnimatedSkeleton className={`${S_SK_BAL_ICON} rounded-full`} />
        <View className="ml-3 flex-1">
          <AnimatedSkeleton className={`${S_SK_HDR_TTL} rounded`} />
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
              <View className={`flex-1 rounded-2xl ${S_PAD_CARD}`} style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className={`${S_SK_BAL_ICON} rounded-full`} />
                  <View className="flex-1">
                    <AnimatedSkeleton className="h-3 w-20 rounded" />
                    <AnimatedSkeleton className={`mt-2 ${S_SK_BAL_VAL} rounded`} />
                  </View>
                </View>
              </View>
              <View className={`flex-1 rounded-2xl ${S_PAD_CARD}`} style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className={`${S_SK_BAL_ICON} rounded-full`} />
                  <View className="flex-1">
                    <AnimatedSkeleton className="h-3 w-20 rounded" />
                    <AnimatedSkeleton className={`mt-2 ${S_SK_BAL_VAL} rounded`} />
                  </View>
                </View>
              </View>
            </View>

            <View className={`rounded-2xl ${S_PAD_CARD}`} style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              <AnimatedSkeleton className={`${S_SK_STAR_TTL} rounded`} />
              <AnimatedSkeleton className="mt-2 h-3 w-56 rounded" />
              <AnimatedSkeleton className="mt-3 h-2 w-full rounded-full" />
              <View className="mt-3 flex-row items-center justify-between">
                <AnimatedSkeleton className="h-3 w-20 rounded" />
                <AnimatedSkeleton className={`${S_SK_WATCH_BT} rounded-xl`} />
              </View>
            </View>

            <View className="mt-1 flex-row items-center justify-between">
              <View>
                <AnimatedSkeleton className={`${S_SK_PACKS_T} rounded`} />
                <AnimatedSkeleton className="mt-2 h-3 w-44 rounded" />
              </View>
              <AnimatedSkeleton className="h-6 w-16 rounded-full" />
            </View>
          </View>
        }
        renderItem={() => (
          <View className={`my-2 rounded-2xl ${S_PAD_CARD}`} style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-3">
                <View className="flex-row items-center space-x-3">
                  <AnimatedSkeleton className={`${S_SK_PACK_ICN} rounded-full`} />
                  <View className="flex-1">
                    <AnimatedSkeleton className={`${S_SK_PACK_TTL} rounded`} />
                    <AnimatedSkeleton className="mt-2 h-3 w-20 rounded" />
                  </View>
                </View>
                <AnimatedSkeleton className="mt-3 h-3 w-32 rounded" />
                <AnimatedSkeleton className="mt-2 h-3 w-40 rounded" />
              </View>
              <View className="items-center">
                <AnimatedSkeleton className={`${S_SK_PRICE_BT} rounded-xl`} />
                <AnimatedSkeleton className="mt-2 h-3 w-16 rounded" />
              </View>
            </View>
          </View>
        )}
        ListFooterComponent={
          <View className={`mt-4 rounded-2xl ${S_PAD_CARD}`} style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
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

// Module-level cache for the coin pack catalog. Pricing rows in
// coin_packages only change when an admin runs SQL — for end users this is
// effectively static config. 1hr TTL is plenty; users get instant render
// on subsequent Store opens instead of flashing the skeleton while the
// network round-trips a query that returns the same payload every time.
const COIN_PACKS_TTL_MS = 60 * 60 * 1000;
let cachedCoinPacks = null;
let cachedCoinPacksTs = 0;

// Two-section screen: Goals (daily/weekly/monthly engagement targets,
// formerly called "Quests" on web) and Store (coin packs + rewarded
// ads). Tab toggle at the top lets the user swing between them without
// leaving the screen — keeps the wallet balance visible above both
// sections so users always see their current Stars / Coins.
const Store = () => {
  const [activeStoreTab, setActiveStoreTab] = useState("goals");
  const { theme } = useAppTheme();
  const { products, finishTransaction, getProducts, requestPurchase } = useIAP();
  const [coinPacks, setCoinPacks] = useState([]);
  const { globalSettings, user, balance, refetchBalance, refetchStars, starsData, setStarsData } = useGlobalContext();
  const { showAd, starLoading, showPlusOne, cooldownMessageOpen, remainingTime, setCooldownMessageOpen, plusOneAnim } = useRewardedStar({
    userId: user?.$id,
    cooldownSeconds: globalSettings["WATCH_AD_COOLDOWN_TIMER"],
    setStarsData,
  });
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  // Once an IAP catalog fetch has resolved (success OR failure), release
  // the skeleton even if `products` is empty. Without this, an App Store
  // outage left iOS users staring at the skeleton forever (since the
  // showSkeleton expression had `products.length === 0 && osName === "ios"`
  // as a hard block).
  const [iapFetchAttempted, setIapFetchAttempted] = useState(false);
  const osName = Platform.OS;
  const dailyLimit = starsData?.maxAdsPerDay || 0;
  const watchedToday = starsData?.adsWatchedToday || 0;
  const limitReached = watchedToday >= dailyLimit;
  const remainingAds = Math.max(dailyLimit - watchedToday, 0);
  const progress = dailyLimit > 0 ? Math.min((watchedToday / dailyLimit) * 100, 100) : 0;
  const showSkeleton = loading || coinPacks.length === 0 || (products.length === 0 && (osName === "ios" || osName === "android") && !iapFetchAttempted);

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
      // Cache hit — paint immediately, skip the round-trip. iOS still
      // wants the IAP getProducts call to populate `products` even when
      // we have cached pack metadata, so we re-fire that side either way.
      if (cachedCoinPacks && Date.now() - cachedCoinPacksTs < COIN_PACKS_TTL_MS) {
        if (osName === "ios") {
          handleGetProductsIOS(cachedCoinPacks);
        }
        setCoinPacks(cachedCoinPacks);
        return;
      }

      // Wallet flag drives the catalog source. Under USE_SUPABASE_WALLET,
      // packs come from public.coin_packages — that's the same table the
      // IAP webhooks (apple-iap-webhook + the future google-play-webhook)
      // resolve via package_id. The legacy Appwrite path remains as a
      // rollback option until the flag retires.
      let response;
      if (USE_SUPABASE_WALLET) {
        const { data, error } = await supabase
          .from("coin_packages")
          .select(
            "id, name, base_coins, bonus_coins, price_minor, currency, is_active, is_best_value, sort_order, iap_ios_product_id, iap_android_product_id",
          )
          .eq("is_active", true)
          .order("sort_order", { ascending: true });
        if (error) throw error;
        response = (data || []).map((row) => ({
          $id: row.id,
          name: row.name,
          coins: row.base_coins ?? 0,
          free: row.bonus_coins ?? 0,
          // price_minor is in centavos; the UI shows the whole-peso
          // amount when an external-currency price is needed (legacy).
          price: Math.round((row.price_minor ?? 0) / 100),
          currency: row.currency || "PHP",
          isBestValue: !!row.is_best_value,
          sortOrder: row.sort_order ?? 0,
          iapIOSProductID: row.iap_ios_product_id || null,
          iapAndroidProductID: row.iap_android_product_id || null,
        }));
      } else {
        response = await getCoinPacks();
      }
      if (osName === "ios") {
        // Don't await — let the IAP catalog hydrate in the background so
        // coin packs render immediately. handleGetProductsIOS now flips
        // iapFetchAttempted in its finally block, so the skeleton releases
        // even on App Store outage instead of hanging forever.
        handleGetProductsIOS(response);
        setCoinPacks(response);
      } else if (osName === "android") {
        // Same fire-and-forget pattern for Google Play. Skeleton releases
        // either way thanks to iapFetchAttempted in the finally block.
        handleGetProductsAndroid(response);
        setCoinPacks(response);
      } else {
        setCoinPacks(response);
      }
      // Persist for the next Store open within the TTL window.
      cachedCoinPacks = response;
      cachedCoinPacksTs = Date.now();
    } catch (error) {
      console.error(error.message);
    }
  }, []);

  const handleGetProductsIOS = async (response) => {
    const skus = response.map((p) => p.iapIOSProductID).filter(Boolean);
    if (skus.length === 0) {
      setIapFetchAttempted(true);
      return;
    }
    // One retry with backoff — App Store occasionally rate-limits or returns
    // transient errors. After this, iapFetchAttempted releases the skeleton
    // so the user at least sees the (price-less) packs and can pull-to-retry
    // via the parent useFocusEffect.
    const attempt = async () => {
      await getProducts({ skus });
    };
    try {
      await attempt();
    } catch (firstErr) {
      console.warn("IAP getProducts failed, retrying in 1.5s:", firstErr?.message);
      try {
        await new Promise((r) => setTimeout(r, 1500));
        await attempt();
      } catch (retryErr) {
        console.error("IAP getProducts failed after retry:", retryErr?.message);
      }
    } finally {
      setIapFetchAttempted(true);
    }
  };

  const submitPaymentIOS = async (coins, iapIOSProductID) => {
    setLoading(true);
    try {
      // appAccountToken — Apple includes this in the signed
      // transactionInfo it pushes to our App Store Server
      // Notifications V2 webhook (apple-iap-webhook). Without it,
      // the webhook can't tell which Selebox user to credit, and
      // every purchase silently drops on the server side. Must be
      // a UUID.
      const purchase = await requestPurchase({
        sku: iapIOSProductID,
        appAccountToken: user?.$id,
      });
      if (purchase.transactionId || purchase.transactionReceipt) {
        await finishTransaction({
          purchase: purchase,
          isConsumable: true,
        });
        // Phase F.7 — On Supabase mode, the IAP webhook on the server
        // credits the wallet row directly (server-authoritative —
        // matches the StoreKit / Play Billing notification flow).
        // We skip the Appwrite client-side coin write to avoid
        // double-crediting and let the realtime wallet subscription
        // pick up the new balance.
        if (!USE_SUPABASE_WALLET) {
          await updateUserCoins(user.$id, balance + coins);
        }
        await refetchBalance(user.$id);

        // ABUSE DEFENSE: tick the purchase_coin goal AFTER
        // finishTransaction succeeded. The transactionId is the
        // canonical idempotency key — same purchase replayed (e.g.,
        // "restore purchases") returns the same transactionId so
        // dedup blocks. Each fresh successful IAP ticks once.
        const { tickGoalUnique } = await import("../../lib/goals-store");
        tickGoalUnique("purchase_coin", `iap:${purchase.transactionId || purchase.transactionReceipt}`);
      }
    } catch (error) {
      // SKErrorDomain code 2 (SKErrorPaymentCancelled) and StoreKit's
      // "user cancelled" / "E_USER_CANCELLED" are normal cancel paths
      // — the user dismissed the Apple purchase sheet or password
      // prompt. We silence those so the dev terminal doesn't fill with
      // red error logs every time someone backs out of a purchase.
      const msg = String(error?.message || "");
      const code = String(error?.code || "");
      const isCancel =
        code === "E_USER_CANCELLED" ||
        msg.includes("SKErrorDomain error 2") ||
        msg.toLowerCase().includes("cancel");
      if (!isCancel) {
        console.error(error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // ─── Android product catalog hydration ──────────────────────────────
  // Mirror of handleGetProductsIOS but pulls iapAndroidProductID SKUs
  // from coin_packages. Populates the `products` list react-native-iap
  // exposes so the UI can show localized Play Store prices.
  const handleGetProductsAndroid = async (response) => {
    const skus = response.map((p) => p.iapAndroidProductID).filter(Boolean);
    if (skus.length === 0) {
      setIapFetchAttempted(true);
      return;
    }
    const attempt = async () => {
      await getProducts({ skus });
    };
    try {
      await attempt();
    } catch (firstErr) {
      console.warn("IAP getProducts (android) failed, retrying in 1.5s:", firstErr?.message);
      try {
        await new Promise((r) => setTimeout(r, 1500));
        await attempt();
      } catch (retryErr) {
        console.error("IAP getProducts (android) failed after retry:", retryErr?.message);
      }
    } finally {
      setIapFetchAttempted(true);
    }
  };

  // ─── Android purchase flow ──────────────────────────────────────────
  // Google Play Billing path. Wired 2026-05-17.
  //
  // Flow:
  //   1. requestPurchase({ skus: [androidSku], obfuscatedAccountIdAndroid: user.$id })
  //   2. On success, react-native-iap returns a purchase with a
  //      `purchaseToken` field — that's the canonical idempotency key
  //      Google emits.
  //   3. POST {userId, packageName, productId, purchaseToken} to the
  //      verify-google-play-purchase Edge Function. It calls Google's
  //      Developer API to confirm purchaseState=0 (purchased) and then
  //      credits via credit_iap_purchase RPC.
  //   4. ONLY AFTER the server confirms ok, call finishTransaction to
  //      consume the Play purchase. Calling it before would lose the
  //      receipt if the server-side credit fails — the user would have
  //      paid Google but never received coins.
  //
  // obfuscatedAccountIdAndroid is the Android counterpart to Apple's
  // appAccountToken. It rides along with the purchase and is queryable
  // from the Developer API + RTDN events, giving us a second
  // independent signal of which Selebox user owns the purchase (in
  // addition to the client-passed userId we send to the edge function).
  const submitPaymentAndroid = async (coins, iapAndroidProductID) => {
    if (!iapAndroidProductID) {
      Alert.alert("Coming soon", "This pack isn't available on Google Play yet.");
      return;
    }
    setLoading(true);
    try {
      const purchase = await requestPurchase({
        skus: [iapAndroidProductID],
        obfuscatedAccountIdAndroid: user?.$id,
      });
      // react-native-iap on Android returns either a single object or an
      // array (legacy / newer versions differ). Normalize.
      const p = Array.isArray(purchase) ? purchase[0] : purchase;
      const purchaseToken = p?.purchaseToken;
      const productId     = p?.productId || iapAndroidProductID;
      if (!purchaseToken) {
        throw new Error("missing_purchase_token");
      }

      // Server-side verification + credit. Don't acknowledge the
      // purchase to Google until this returns ok.
      const { data, error } = await supabase.functions.invoke(
        "verify-google-play-purchase",
        {
          body: {
            userId:        user?.$id,
            packageName:   "com.talesofsiren.talesofsiren",
            productId,
            purchaseToken,
          },
        },
      );
      if (error) throw new Error(`verify_failed: ${error.message || error}`);
      if (!data?.ok) {
        throw new Error(`verify_rejected: ${data?.error || "unknown"}`);
      }

      // Consume the purchase so Google releases it for re-purchase.
      // isConsumable=true matches iOS — coin packs are consumable.
      await finishTransaction({ purchase: p, isConsumable: true });

      // Phase F.7 — same server-authoritative pattern as iOS. The
      // credit happened server-side via credit_iap_purchase; we just
      // refresh the local balance via the realtime subscription.
      if (!USE_SUPABASE_WALLET) {
        await updateUserCoins(user.$id, balance + coins);
      }
      await refetchBalance(user.$id);

      // Daily-goal tick — same dedup key shape as iOS.
      const { tickGoalUnique } = await import("../../lib/goals-store");
      tickGoalUnique("purchase_coin", `iap:${purchaseToken}`);
    } catch (error) {
      const msg = String(error?.message || "");
      const code = String(error?.code || "");
      // Google Play "user cancelled" / billing client error codes.
      // E_USER_CANCELLED is react-native-iap's normalized code.
      const isCancel =
        code === "E_USER_CANCELLED" ||
        msg.toLowerCase().includes("user canceled") ||
        msg.toLowerCase().includes("user cancelled") ||
        msg.toLowerCase().includes("cancel");
      if (!isCancel) {
        console.error("[submitPaymentAndroid]", msg);
        Alert.alert("Purchase failed", msg || "Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const renderCoinPacks = ({ item }) => {
    const totalCoins = item.coins + item.free;
    const bonusPercent = getBonusPercent(item.coins, item.free);
    const isBestValue = item.$id === bestValueId;
    // Price comes from the platform's IAP catalog (localized, including
    // currency). On iOS that's the App Store SKU; on Android it's the
    // Google Play SKU. If the SKU isn't defined for the platform (e.g.
    // a pack only exists on iOS yet), we render "Coming soon" so the
    // user knows it's not available on their device.
    const platformSku =
      osName === "ios"     ? item.iapIOSProductID :
      osName === "android" ? item.iapAndroidProductID :
      null;
    const priceLabel = platformSku
      ? (products.find((product) => product.productId === platformSku)?.localizedPrice || "...")
      : "Coming soon";

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() =>
          osName === "ios"
            ? submitPaymentIOS(totalCoins, item.iapIOSProductID)
            : submitPaymentAndroid(totalCoins, item.iapAndroidProductID)
        }
        className={`my-2 rounded-2xl border ${S_PAD_CARD}`}
        style={{
          borderColor: isBestValue ? theme.accentAmber : theme.border,
          backgroundColor: isBestValue ? theme.accentAmberSoft : theme.card,
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            <View className="flex-row items-center space-x-3">
              <View
                className="items-center justify-center rounded-full"
                style={{
                  width: S_AV_40,
                  height: S_AV_40,
                  backgroundColor: theme.accentAmberSoft,
                }}
              >
                <FontAwesome5 name="coins" size={S_ICON_17_20} color={theme.coin} />
              </View>
              <View>
                <Text className={`font-pbold ${S_HEADING}`} style={{ color: theme.text }}>
                  {item.coins} Coins
                </Text>
                <Text className={`font-plight ${S_BODY}`} style={{ color: theme.textSoft }}>
                  {item.free === 0 ? "No free coins" : `+${item.free} free coins`}
                </Text>
              </View>
            </View>
            <View className="mt-3 flex-row items-center space-x-2">
              <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className={`font-psemibold ${S_TINY}`} style={{ color: theme.textSoft }}>
                  Bonus {bonusPercent}%
                </Text>
              </View>
              {isBestValue && (
                <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.accentGreenSoft }}>
                  <Text className={`font-psemibold ${S_TINY}`} style={{ color: theme.accentGreen }}>
                    Best value
                  </Text>
                </View>
              )}
            </View>
            <Text className={`mt-2 ${S_FOOTNOTE}`} style={{ color: theme.textSoft }}>
              Total {totalCoins} coins delivered instantly
            </Text>
          </View>
          <View className="items-center">
            <View className={`rounded-xl ${S_PRICE_PAD}`} style={{ backgroundColor: theme.primary }}>
              <Text className={`font-psemibold ${S_TAB_LABEL}`} style={{ color: theme.primaryContrast }}>
                {priceLabel}
              </Text>
            </View>
            <Text className={`mt-2 font-psemibold ${S_TINY}`} style={{ color: theme.textSoft }}>
              {platformSku ? "Tap to buy" : "Available soon"}
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
              className="items-center justify-center rounded-full"
              style={{
                width: S_AV_36,
                height: S_AV_36,
                backgroundColor: theme.surfaceMuted,
                borderWidth: 1,
                borderColor: theme.border,
              }}
              onPress={() => {
                router.back();
              }}
            >
              <MaterialIcons name="arrow-back" size={S_ICON_19_22} color={theme.icon} />
            </TouchableOpacity>
            <View className="ml-3 flex-1">
              {/* "Goals and Store" — text-2xl (24) on wide, drops to
                  text-xl (20) on Infinix-class viewports per the 360dp
                  rule. */}
              <Text className={`font-pbold ${S_TITLE}`} style={{ color: theme.text }}>
                Goals and Store
              </Text>
            </View>
          </View>

          {/* [Goals][Store] tab toggle. Pill-style segmented control,
              matches the visual language of other in-app toggles
              (For You / Following on home, etc.). The active pill picks
              up theme.primary; inactive sits flat on theme.surfaceMuted. */}
          <View
            className="mt-4 flex-row rounded-2xl p-1"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
          >
            {[
              { key: "goals", label: "Goals" },
              { key: "store", label: "Store" },
            ].map((tab) => {
              const isActive = activeStoreTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  activeOpacity={0.85}
                  onPress={() => setActiveStoreTab(tab.key)}
                  className={`flex-1 items-center justify-center rounded-xl ${S_TAB_PAD_Y}`}
                  style={{
                    backgroundColor: isActive ? theme.primary : "transparent",
                  }}
                >
                  <Text
                    className={`font-psemibold ${S_TAB_LABEL}`}
                    style={{ color: isActive ? theme.primaryContrast || "#FFFFFF" : theme.textSoft }}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {activeStoreTab === "goals" && <GoalsTab />}

          {activeStoreTab === "store" && (
          <FlatList
            data={coinPacks}
            renderItem={renderCoinPacks}
            keyExtractor={(item) => item.$id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 12 }}
            ListHeaderComponent={
              <View className="mt-4 space-y-3">
                <View className="flex-row space-x-3">
                  {/* Tap → coin purchase history (May 2026 add).
                      The card was a passive display before; promoting
                      it to a tap target lets users see where their
                      coins came from without a separate menu item. */}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => router.push("/coin-history")}
                    className={`flex-1 rounded-2xl ${S_PAD_CARD}`}
                    style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
                    accessibilityRole="button"
                    accessibilityLabel="View coin purchase history"
                  >
                    <View className="flex-row items-center space-x-3">
                      <View
                        className="items-center justify-center rounded-full"
                        style={{
                          width: S_AV_36,
                          height: S_AV_36,
                          backgroundColor: theme.accentAmberSoft,
                        }}
                      >
                        <FontAwesome5 name="coins" size={S_ICON_17_20} color={theme.coin} />
                      </View>
                      {/* `min-w-0 flex-1` lets this text container shrink
                          below its intrinsic content width inside the
                          flex row, which is what allows the numberOfLines
                          truncation to actually engage. Without min-w-0
                          the card overflows the screen edge on narrow
                          (~360pt) devices — a Facebook user's screenshot
                          flagged this for the Stars side. */}
                      <View className="min-w-0 flex-1">
                        <Text
                          className={`font-plight ${S_BODY}`}
                          style={{ color: theme.textSoft }}
                          numberOfLines={1}
                        >
                          Coins balance
                        </Text>
                        <Text
                          className={`font-psemibold ${S_HEADING}`}
                          style={{ color: theme.text }}
                          numberOfLines={1}
                        >
                          {balance ?? 0} {balance === 1 ? "Coin" : "Coins"}
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>

                  {/* Tap → star earning history grouped by day. */}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => router.push("/star-history")}
                    className={`flex-1 rounded-2xl ${S_PAD_CARD}`}
                    style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
                    accessibilityRole="button"
                    accessibilityLabel="View star earning history"
                  >
                    <View className="flex-row items-center space-x-3">
                      <View
                        className="items-center justify-center rounded-full"
                        style={{
                          width: S_AV_36,
                          height: S_AV_36,
                          backgroundColor: theme.accentAmberSoft,
                        }}
                      >
                        <StarIcon size={S_ICON_19_22} color={theme.coin} />
                      </View>
                      {/* Same min-w-0 + numberOfLines treatment as the
                          Coins card above — keeps the card honest on
                          narrow devices. */}
                      <View className="min-w-0 flex-1">
                        <Text
                          className={`font-plight ${S_BODY}`}
                          style={{ color: theme.textSoft }}
                          numberOfLines={1}
                        >
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
                                  fontSize: S_FS_16_18,
                                  fontWeight: "bold",
                                  transform: [{ translateY: plusOneAnim }],
                                  textAlign: "left",
                                }}
                                numberOfLines={1}
                              >
                                +1
                              </Animated.Text>
                            ) : (
                              <Text style={{ color: theme.text, fontSize: S_FS_16_18, fontWeight: "bold" }} numberOfLines={1}>
                                {starsData?.stars ?? 0} {starsData?.stars === 1 ? "Star" : "Stars"}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                </View>

                {/* Balance recovery banner — surfaced here right under
                    the Coins/Stars balance cards so users staring at a
                    suspicious 0 have the report-an-issue path within
                    reach without having to navigate to Payments. */}
                <BalanceRecoveryBanner />

                <View
                  className={`rounded-2xl ${S_PAD_CARD}`}
                  style={{ borderWidth: 1, borderColor: theme.accentAmber, backgroundColor: theme.accentAmberSoft }}
                >
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1 pr-3">
                      <Text className={`font-pbold ${S_HEADING}`} style={{ color: theme.text }}>
                        Earn a free star
                      </Text>
                      <Text className={`mt-1 font-plight ${S_BODY}`} style={{ color: theme.textSoft }}>
                        Watch a short ad to earn 1 Star. {remainingAds} left today.
                      </Text>
                    </View>
                    <View
                      className="items-center justify-center rounded-full"
                      style={{
                        width: S_AV_40_48,
                        height: S_AV_40_48,
                        backgroundColor: theme.accentAmberSoft,
                      }}
                    >
                      <StarIcon size={S_ICON_22_26} color={theme.coin} />
                    </View>
                  </View>
                  <View className="mt-3 h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
                    <View className="h-2 rounded-full" style={{ width: `${progress}%`, backgroundColor: theme.accentAmber }} />
                  </View>
                  <View className="mt-3 flex-row items-center justify-between">
                    <Text className={S_BODY} style={{ color: theme.textSoft }}>
                      {watchedToday}/{dailyLimit} watched
                    </Text>
                    <TouchableOpacity
                      className={`rounded-xl ${S_WATCH_PAD}`}
                      onPress={showAd}
                      disabled={limitReached}
                      style={{ backgroundColor: limitReached ? theme.surfaceMuted : theme.accentAmber }}
                    >
                      <Text
                        className={`font-psemibold ${S_BODY}`}
                        style={{ color: limitReached ? theme.textSoft : theme.textInverse }}
                      >
                        {limitReached ? "Limit Reached" : "Watch Ad"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View className="mt-1 flex-row items-center justify-between">
                  <View>
                    <Text className={`font-pbold ${S_HEADING}`} style={{ color: theme.text }}>
                      Coin Packs
                    </Text>
                    <Text className={`font-plight ${S_BODY}`} style={{ color: theme.textSoft }}>
                      Choose the pack that fits you best
                    </Text>
                  </View>
                </View>
              </View>
            }
            ListFooterComponent={
              <View
                className={`mt-4 rounded-2xl ${S_PAD_CARD}`}
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
              >
                <StyledDivider color={theme.divider}>
                  <Text
                    className={`text-center font-sans font-bold ${S_TINY}`}
                    style={{ color: theme.textSoft }}
                  >
                    Disclaimer
                  </Text>
                </StyledDivider>
                <Text
                  className={`mt-2 text-center font-pextralight ${S_BODY}`}
                  style={{ color: theme.textMuted }}
                >
                  "We do not collect, store, or process any credit card or billing information. All transactions are handled securely through
                  third-party payment providers."
                </Text>
              </View>
            }
          />
          )}
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
