import { FontAwesome6, Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Modal, Text, TouchableOpacity, View } from "react-native";
import { BalanceRecoveryBanner, CustomAlertModal, CustomPicker, PaymentBreakdownEarnings, WithdrawModal } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { useEarnings } from "../../hooks/useEarnings";
import { getMyAuthorProfile } from "../../lib/earnings-supabase";
import UserDocumentsService from "../../lib/user-documents";
import { getAppConfig } from "../../lib/wallet-supabase";

const Earnings = ({ onSwitchToPaymentInfo }) => {
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const WITHDRAWAL_MINIMUM_AMOUNT = globalSettings["WITHDRAWAL_MINIMUM_AMOUNT"];
  const TRANSFER_FEE = globalSettings["TRANSFER_FEE"];
  const PLATFORM_COST = globalSettings["PLATFORM_COST"];

  const [selectedMonth, setSelectedMonth] = useState("");
  const [months, setMonths] = useState([]);
  const { earnings, remainingBalance, pendingBalance, withdraw, loading, latestWithdrawal } = useEarnings(user?.$id, selectedMonth);
  const isWithdrawalPending = latestWithdrawal?.status === "pending";

  // Pioneer-exempt status drives the "zero fees" preview in WithdrawModal.
  // Loaded once on mount; harmless if it fails (modal falls back to
  // non-exempt math, server still enforces correctness at submit time).
  const [authorProfile, setAuthorProfile] = useState(null);

  // Hold-period setting (app_config.author_earnings_hold_days). Same
  // value the web's Author Earnings card reads — surfaces "Available
  // N days after they're earned" on the Pending tile so writers see
  // why a fresh credit isn't available yet. Defaults to 7 to match
  // the current production knob; if the SQL is ever flipped to
  // another number, the next viewer mount picks it up via the cached
  // getAppConfig() call.
  const [holdDays, setHoldDays] = useState(7);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAppConfig();
        if (cancelled) return;
        const days = Number(cfg?.author_earnings_hold_days);
        if (Number.isFinite(days) && days > 0) setHoldDays(days);
      } catch (_) {
        // best-effort; default 7 stays
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [withdrawModal, setWithdrawModal] = useState({ visible: false, amount: "", amountToReceive: 0 });
  const [alert, setAlert] = useState({ message: "", open: false, icon: "circle-info", color: theme.primary });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getMyAuthorProfile();
        if (!cancelled) setAuthorProfile(p);
      } catch (_) {
        // non-fatal — just means modal renders non-Pioneer fees
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // One-time "Verify your Payment Info" gate before the first
  // Supabase-flow withdrawal request. Reads `supabase_confirmed_at`
  // from the author_kyc row — null = legacy/migrated row that
  // hasn't been re-saved through the new Supabase form yet.
  //
  //   • null  → Withdraw tap shows verify modal, routes to Payment
  //             Info; the BEFORE-write trigger on author_kyc stamps
  //             `supabase_confirmed_at = now()` whenever the user
  //             saves the form, so the next focus passes the gate
  //             silently.
  //   • set   → user has saved through the new flow at least once;
  //             gate is open forever.
  //
  // Refetches every focus so the moment a user lands back on the
  // Earnings tab from Payment Info, the local flag updates without
  // needing to navigate away and back.
  const [needsKycConfirm, setNeedsKycConfirm] = useState(false);
  const refreshKycConfirm = useCallback(async () => {
    try {
      const info = await UserDocumentsService.fetchPaymentInfo(user?.$id);
      // No KYC row yet → treat same as not confirmed (the user has
      // never saved Payment Info, so the modal still applies).
      const confirmedAt = info?.supabaseConfirmedAt || null;
      setNeedsKycConfirm(!confirmedAt);
    } catch (_) {
      // Best-effort. If we can't read it (auth quirk, network), let
      // the user proceed — server-side withdrawal RPC will still
      // reject incomplete KYC. Better to fail-open here than to
      // lock writers out of withdrawing if a transient blip hits.
      setNeedsKycConfirm(false);
    }
  }, [user?.$id]);

  useFocusEffect(
    useCallback(() => {
      refreshKycConfirm();
    }, [refreshKycConfirm]),
  );

  useEffect(() => {
    const generateMonths = () => {
      const start = new Date(2025, 7, 1);
      const now = new Date();
      const result = [];

      let current = new Date(start.getFullYear(), start.getMonth(), 1);

      while (current <= now) {
        const monthName = current.toLocaleString("default", { month: "long" });
        const year = current.getFullYear();

        result.push({
          label: `${monthName} ${year}`,
          value: `${year}-${String(current.getMonth() + 1).padStart(2, "0")}`,
        });

        current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
      }

      return result;
    };

    const availableMonths = generateMonths();
    setMonths(availableMonths);
    setSelectedMonth(availableMonths[availableMonths.length - 1].value);
  }, []);

  const showAlert = (message, type = "info") => {
    let icon = "circle-info";
    let color = theme.primary;

    switch (type) {
      case "success":
        icon = "circle-check";
        color = theme.accentGreen;
        break;
      case "error":
        icon = "circle-exclamation";
        color = theme.danger;
        break;
    }

    setAlert({ message, open: true, icon, color });
  };

  const handleOpenWithdrawal = () => {
    if (isWithdrawalPending) {
      showAlert("You already have a pending withdrawal request.", "info");
      return;
    }
    // One-time KYC re-confirm gate — fires only when
    // `author_kyc.supabase_confirmed_at` is null. Routes the user to
    // the Payment Info tab so they can review (and re-save, even
    // unchanged); the BEFORE-write trigger on author_kyc stamps the
    // timestamp on save and the gate is open forever after.
    if (needsKycConfirm) {
      setKycConfirmOpen(true);
      return;
    }
    if (remainingBalance <= 0) {
      showAlert("You have no remaining balance to withdraw.");
      return;
    }

    setWithdrawModal({ visible: true, amount: "" });
  };

  // Verify-Payment-Info modal state. Separate from the generic alert
  // because the CTA needs to navigate to the Payment Info tab — the
  // existing CustomAlertModal is dismiss-only.
  const [kycConfirmOpen, setKycConfirmOpen] = useState(false);
  const handleVerifyKycNow = () => {
    setKycConfirmOpen(false);
    if (typeof onSwitchToPaymentInfo === "function") {
      onSwitchToPaymentInfo();
    } else {
      // Fallback — if Earnings was rendered standalone (which the
      // current Payments screen doesn't do, but defensively).
      router.push("/payment-information");
    }
  };

  const handleConfirmWithdraw = async () => {
    if (isWithdrawalPending) {
      showAlert("You already have a pending withdrawal request.", "info");
      return;
    }
    const amount = parseFloat(withdrawModal.amount);
    const amountToReceive = withdrawModal.amountToReceive;

    if (isNaN(amount) || amount < WITHDRAWAL_MINIMUM_AMOUNT) {
      showAlert(`Minimum withdrawal is ₱${WITHDRAWAL_MINIMUM_AMOUNT}.`, "info");
      return;
    }
    if (amount > remainingBalance) {
      showAlert("Withdrawal cannot exceed your remaining balance.", "error");
      return;
    }

    try {
      // The Supabase withdrawal RPC takes pesos in MINOR units (centavos)
      // since it earmarks against author_earnings.net_php_minor (which is
      // also stored in centavos). Convert the peso input here so the user
      // types pesos but the server-side math is exact-integer.
      const amountPhpMinor = Math.round(amount * 100);
      await withdraw({ amount, amountToReceive, amountPhpMinor });
      setWithdrawModal({ ...withdrawModal, visible: false });
      setTimeout(() => {
        showAlert("Your withdrawal request has been submitted.", "success");
      }, 600);
    } catch (err) {
      if (err.message === "NO_PAYMENT_INFO") {
        showAlert("You must add your payment information before requesting a withdrawal.", "error");
      } else {
        showAlert("Failed to submit withdrawal request.", "error");
      }
    }
  };

  // Navigate to the per-item drill-down for a category (book / video /
  // post / clip). Passes the active month so the breakdown matches
  // what's shown on the tile — taps from "May 2026" go to a screen
  // scoped to May 2026. Pass empty `monthYear` to view lifetime.
  const openBreakdown = useCallback(
    (category, label) => {
      router.push({
        pathname: "/(payments)/earnings-breakdown",
        params: { category, label, monthYear: selectedMonth || "" },
      });
    },
    [selectedMonth],
  );

  const getWithdrawalStatusColor = (status) => {
    switch (status) {
      case "pending":
        return { dotColor: theme.accentAmber, textColor: theme.accentAmber };
      case "approved":
        return { dotColor: theme.accentGreen, textColor: theme.accentGreen };
      default:
        return { dotColor: theme.danger, textColor: theme.danger };
    }
  };

  return (
    <View>
      {/* Maintenance banner — withdrawals are temporarily paused while
          we reconcile pending requests. We surface this prominently at
          the top of the Earnings tab so creators don't think their
          balance disappeared (e.g. Ms.Chaser report — pending
          withdrawal wasn't subtracted from displayed available, so the
          ₱1,500 looked "missing"). The banner stays purple-soft so it
          reads as informational rather than alarming. */}
      <View
        className="mb-3 mt-3 rounded-2xl p-4"
        style={{
          backgroundColor: theme.primarySoft || "rgba(139,92,246,0.10)",
          borderWidth: 1,
          borderColor: "rgba(139,92,246,0.28)",
        }}
      >
        <View className="flex-row items-start">
          <View
            className="mr-3 h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: "rgba(139,92,246,0.18)" }}
          >
            <MaterialCommunityIcons name="shield-check" size={18} color={theme.primary || "#8b5cf6"} />
          </View>
          <View className="flex-1">
            <Text
              className="text-sm font-bold"
              style={{ color: theme.text, letterSpacing: 0.2 }}
            >
              Withdrawals temporarily under maintenance
            </Text>
            <Text
              className="mt-1 text-xs"
              style={{ color: theme.textSoft, lineHeight: 17 }}
            >
              Your earnings are safe. Pending withdrawal requests are queued and will be processed as soon as maintenance is complete. Thank you for your patience 💜
            </Text>
          </View>
        </View>
      </View>

      {/* Balance section */}
      <View className="mb-1 mt-3 rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <View className="mb-3 flex-row items-center">
          <View className="mr-2 h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: theme.primarySoft }}>
            <Ionicons name="wallet" size={16} color={theme.primary} />
          </View>
          <Text className="text-sm font-semibold" style={{ color: theme.textSoft }}>
            Remaining Balance
          </Text>
        </View>

        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            {loading ? (
              <AnimatedSkeleton style={{ width: "50%", height: 30, backgroundColor: theme.skeletonBase }} />
            ) : (
              <Text
                className="font-semibold"
                style={{ fontSize: 25, color: theme.text }}
                adjustsFontSizeToFit
                ellipsizeMode="tail"
                numberOfLines={1}
                minimumFontScale={0.5}
              >
                ₱ {remainingBalance.toFixed(2)}
              </Text>
            )}
            <Text className="mt-3 text-[12px] font-bold" style={{ color: theme.textSoft }}>
              Withdrawal Status
            </Text>
            {loading ? (
              <AnimatedSkeleton
                style={{
                  width: "50%",
                  height: 30,
                  backgroundColor: theme.skeletonBase,
                }}
              />
            ) : latestWithdrawal ? (
              <View className="mt-1 flex-row items-center">
                <View
                  className="mr-1.5 h-2 w-2 rounded-full"
                  style={{ backgroundColor: getWithdrawalStatusColor(latestWithdrawal.status).dotColor }}
                />
                <Text
                  className="text-[13px] font-semibold"
                  style={{ color: getWithdrawalStatusColor(latestWithdrawal.status).textColor }}
                  adjustsFontSizeToFit
                  ellipsizeMode="tail"
                  numberOfLines={1}
                  minimumFontScale={0.5}
                >
                  {latestWithdrawal.status} - ₱ {latestWithdrawal.amountToReceive.toFixed(2)}
                </Text>
              </View>
            ) : (
              <Text className="text-[13px] font-semibold" style={{ color: theme.textSubtle }}>
                -
              </Text>
            )}
          </View>

          {/* Withdraw button — DISABLED while withdrawals are under
              maintenance (matches the banner copy at the top of the
              tab). disabled={true} both visually + functionally — the
              press handler is a no-op so even fast taps don't slip
              through, and the button reads at ~50% opacity with a
              "Maintenance" label so the disabled state is unmistakable.
              When maintenance ends, restore onPress={handleOpenWithdrawal}
              and the original label / styling. */}
          <TouchableOpacity
            disabled
            onPress={() => {}}
            activeOpacity={1}
            className="flex-row items-center rounded-xl px-4 py-3"
            style={{
              backgroundColor: theme.primary,
              opacity: 0.45,
            }}
          >
            <MaterialIcons name="lock-outline" size={16} color={theme.primaryContrast} />
            <Text className="ml-1.5 text-center text-[14px] font-bold" style={{ color: theme.primaryContrast }}>
              Maintenance
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Balance recovery banner — entry point for users with missing
          coins / stars / earnings / account. Self-managing: shows
          default invitation, pending-review state, approved confirmation,
          or rejected state with admin note depending on the user's
          most recent recovery request. */}
      <BalanceRecoveryBanner />

      {/* Month Filter Dropdown */}
      <View className="flex-row items-center">
        <MaterialCommunityIcons name="calendar-month" size={20} color={theme.iconMuted} style={{ marginRight: 8 }} />
        <View className="flex-1">
          <CustomPicker
            options={months.map((m) => m.label)}
            selectedValue={months.find((m) => m.value === selectedMonth)?.label}
            onValueChange={(label) => {
              const found = months.find((m) => m.label === label);
              setSelectedMonth(found?.value || "");
            }}
            placeholder="Select Month"
          />
        </View>
      </View>

      {/* Earnings breakdown — reorganized May 2026 per UX feedback:
          [Total Earnings] [Pending]    ← row of two
          [This Month]                  ← full-width row
          Pairing Total + Pending side-by-side reads as "what you've
          earned" vs "still on hold"; This Month then drops below as
          its own time-bucket card. */}
      <View className="mt-[-2px] flex-row space-x-[8px]">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Total Earnings"
            amount={`₱ ${earnings.total.toFixed(2)}`}
            description="All-time net to your wallet, after fees."
            loading={loading}
            icon={<FontAwesome6 name="sack-dollar" size={14} color={theme.accentGreen} />}
            iconBackgroundColor={theme.accentGreenSoft}
          />
        </View>
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Pending"
            amount={`₱ ${(Number(pendingBalance) || 0).toFixed(2)}`}
            description={
              holdDays === 1
                ? "Available 1 day after they're earned."
                : `Available ${holdDays} days after they're earned.`
            }
            loading={loading}
            icon={<MaterialCommunityIcons name="clock-outline" size={14} color={theme.accentAmber} />}
            iconBackgroundColor={theme.accentAmberSoft}
          />
        </View>
      </View>

      {/* This Month — full-width row of its own. */}
      <View className="flex-row space-x-[8px]">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="This Month"
            amount={`₱ ${earnings.totalEarningsThisMonth.toFixed(2)}`}
            description="Earnings credited within the selected month."
            loading={loading}
            icon={<MaterialCommunityIcons name="calendar-check" size={14} color={theme.accentBlue} />}
            iconBackgroundColor={theme.accentBlueSoft}
          />
        </View>
      </View>

      {/* Other sections — each tile drills into a per-item earnings
          list scoped to the selected month. Total Earnings + This Month
          stay non-tappable summary cards. */}
      <View className="flex-row space-x-[8px]">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Post"
            amount={`₱ ${earnings.breakdown.posts?.toFixed(2) || "0.00"}`}
            description="Tap to see per-post earnings."
            loading={loading}
            icon={<MaterialCommunityIcons name="text-box-outline" size={14} color={theme.accentAmber} />}
            iconBackgroundColor={theme.accentAmberSoft}
            onPress={() => openBreakdown("post", "Post")}
          />
        </View>
        {/* Clips earnings tile removed — clips feature retired May 2026.
            The breakdown.clips field still exists in the data model
            (always 0) but no UI surface displays it. */}
      </View>

      <View className="flex-row space-x-[8px]">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Videos"
            amount={`₱ ${earnings.breakdown.video?.toFixed(2) || "0.00"}`}
            description="Tap to see per-video earnings."
            loading={loading}
            icon={<Ionicons name="videocam" size={14} color={theme.accentPurple} />}
            iconBackgroundColor={theme.accentPurpleSoft}
            onPress={() => openBreakdown("video", "Videos")}
          />
        </View>
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Books"
            amount={`₱ ${earnings.breakdown.book?.toFixed(2) || "0.00"}`}
            description="Tap to see per-book earnings."
            loading={loading}
            icon={<Ionicons name="book" size={14} color={theme.accentTeal} />}
            iconBackgroundColor={theme.accentTealSoft}
            onPress={() => openBreakdown("book", "Books")}
          />
        </View>
      </View>

      {/* Alert Dialogs */}
      <CustomAlertModal
        message={alert.message}
        messageOpen={alert.open}
        closeMessage={() => setAlert({ ...alert, open: false })}
        iconName={alert.icon}
        iconColor={alert.color}
      />

      {/* Verify-Payment-Info modal — fires once per author when their
          author_kyc.supabase_confirmed_at is null and they tap
          Withdraw. After they re-save the form, the BEFORE-write
          trigger stamps the timestamp and this modal never shows
          again for that user. */}
      <Modal
        visible={kycConfirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setKycConfirmOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(15,23,42,0.55)",
            justifyContent: "center",
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: theme.card || "#ffffff",
              borderRadius: 20,
              padding: 22,
              borderWidth: 1,
              borderColor: theme.border || "rgba(139,92,246,0.18)",
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.primarySoft || "rgba(139,92,246,0.12)",
                marginBottom: 14,
              }}
            >
              <MaterialCommunityIcons name="shield-check" size={28} color={theme.primary || "#8b5cf6"} />
            </View>
            <Text
              style={{
                color: theme.text,
                fontSize: 17,
                fontWeight: "800",
                textAlign: "center",
                letterSpacing: 0.2,
              }}
            >
              Verify your Payment Info
            </Text>
            <Text
              style={{
                marginTop: 8,
                color: theme.textSoft,
                fontSize: 13,
                lineHeight: 19,
                textAlign: "center",
              }}
            >
              We've upgraded our payment system. Please review your Payment Info before requesting your withdrawal — this only needs to be done once.
            </Text>

            <TouchableOpacity
              onPress={handleVerifyKycNow}
              activeOpacity={0.85}
              style={{
                marginTop: 18,
                paddingVertical: 13,
                borderRadius: 14,
                backgroundColor: theme.primary || "#8b5cf6",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: theme.primaryContrast || "#ffffff",
                  fontSize: 14,
                  fontWeight: "800",
                  letterSpacing: 0.3,
                }}
              >
                Verify now
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setKycConfirmOpen(false)}
              activeOpacity={0.7}
              style={{
                marginTop: 10,
                paddingVertical: 11,
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: theme.textSoft,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Withdraw Modal */}
      <WithdrawModal
        visible={withdrawModal.visible}
        onClose={() => setWithdrawModal({ ...withdrawModal, visible: false })}
        onConfirm={handleConfirmWithdraw}
        amount={withdrawModal.amount}
        setAmount={(text, receive) => setWithdrawModal({ ...withdrawModal, amount: text, amountToReceive: receive })}
        remainingBalance={remainingBalance}
        WITHDRAWAL_MINIMUM_AMOUNT={WITHDRAWAL_MINIMUM_AMOUNT}
        PLATFORM_COST={PLATFORM_COST}
        TRANSFER_FEE={TRANSFER_FEE}
        profile={authorProfile}
        loading={loading}
      />
    </View>
  );
};

export default Earnings;
