import { FontAwesome6, Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { CustomAlertModal, CustomPicker, PaymentBreakdownEarnings, WithdrawModal } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { useEarnings } from "../../hooks/useEarnings";
import { getMyAuthorProfile } from "../../lib/earnings-supabase";

const Earnings = () => {
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const WITHDRAWAL_MINIMUM_AMOUNT = globalSettings["WITHDRAWAL_MINIMUM_AMOUNT"];
  const TRANSFER_FEE = globalSettings["TRANSFER_FEE"];
  const PLATFORM_COST = globalSettings["PLATFORM_COST"];

  const [selectedMonth, setSelectedMonth] = useState("");
  const [months, setMonths] = useState([]);
  const { earnings, remainingBalance, withdraw, loading, latestWithdrawal } = useEarnings(user?.$id, selectedMonth);
  const isWithdrawalPending = latestWithdrawal?.status === "pending";

  // Pioneer-exempt status drives the "zero fees" preview in WithdrawModal.
  // Loaded once on mount; harmless if it fails (modal falls back to
  // non-exempt math, server still enforces correctness at submit time).
  const [authorProfile, setAuthorProfile] = useState(null);

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
    if (remainingBalance <= 0) {
      showAlert("You have no remaining balance to withdraw.");
      return;
    }

    setWithdrawModal({ visible: true, amount: "" });
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
      {/* Balance section */}
      <View className="my-5 rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
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

          <TouchableOpacity
            onPress={handleOpenWithdrawal}
            className="flex-row items-center rounded-xl px-4 py-3"
            style={{ backgroundColor: theme.primary }}
          >
            <MaterialIcons name="send" size={16} color={theme.primaryContrast} />
            <Text className="ml-1.5 text-center text-[14px] font-bold" style={{ color: theme.primaryContrast }}>
              Withdraw
            </Text>
          </TouchableOpacity>
        </View>
      </View>

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

      {/* Earnings breakdown */}
      <View className="flex-row space-x-4">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Total Earnings"
            amount={`₱ ${earnings.total.toFixed(2)}`}
            loading={loading}
            icon={<FontAwesome6 name="sack-dollar" size={14} color={theme.accentGreen} />}
            iconBackgroundColor={theme.accentGreenSoft}
          />
        </View>
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="This Month"
            amount={`₱ ${earnings.totalEarningsThisMonth.toFixed(2)}`}
            loading={loading}
            icon={<MaterialCommunityIcons name="calendar-check" size={14} color={theme.accentBlue} />}
            iconBackgroundColor={theme.accentBlueSoft}
          />
        </View>
      </View>

      {/* Other sections — each tile drills into a per-item earnings
          list scoped to the selected month. Total Earnings + This Month
          stay non-tappable summary cards. */}
      <View className="flex-row space-x-4">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Post"
            amount={`₱ ${earnings.breakdown.posts?.toFixed(2) || "0.00"}`}
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

      <View className="flex-row space-x-4">
        <View className="flex-1">
          <PaymentBreakdownEarnings
            title="Videos"
            amount={`₱ ${earnings.breakdown.video?.toFixed(2) || "0.00"}`}
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
