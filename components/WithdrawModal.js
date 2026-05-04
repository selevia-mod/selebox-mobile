import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { ActivityIndicator, Modal, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import {
  calculateAmountToReceive,
  isPioneerExempt,
  pioneerDaysRemaining,
} from "../lib/utils/calculateWithdrawal";

// `profile` is the Supabase profile row { role, pioneer_at } — used to
// compute Pioneer-exempt fee status for the preview. When null/undefined
// the modal falls back to non-Pioneer math (server still enforces).
//
// `exemptionDays` is optional and defaults to 365; pass through from the
// caller if you've fetched a custom value from app_config.
const WithdrawModal = ({
  visible,
  onClose,
  onConfirm,
  amount,
  setAmount,
  remainingBalance,
  loading,
  profile,
  exemptionDays,
}) => {
  const { globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const WITHDRAWAL_MINIMUM_AMOUNT = globalSettings["WITHDRAWAL_MINIMUM_AMOUNT"];
  const TRANSFER_FEE = globalSettings["TRANSFER_FEE"];
  const PLATFORM_COST = globalSettings["PLATFORM_COST"];

  const exempt = isPioneerExempt(profile, exemptionDays);
  const daysLeft = pioneerDaysRemaining(profile, exemptionDays);

  const { amountNum, platformCost, transferFee, totalReceive } = calculateAmountToReceive(
    amount,
    globalSettings,
    profile,
    exemptionDays,
  );

  const handleAmountChange = (text) => {
    const { totalReceive } = calculateAmountToReceive(text, globalSettings, profile, exemptionDays);
    setAmount(text, totalReceive);
  };

  const isDisabled = loading || remainingBalance < WITHDRAWAL_MINIMUM_AMOUNT || amountNum > remainingBalance;

  // For display: render the configured fees as percentages whether the
  // raw value is fraction (0.2) or percent (20). Avoids "0.2%" labels.
  const formatFeePct = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n > 1 ? String(n) : String(Math.round(n * 1000) / 10);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: theme.backdrop }}>
        <View className="w-11/12 rounded-2xl p-6" style={{ backgroundColor: theme.surfaceElevated }}>
          <View className="mb-3 flex-row items-center">
            <MaterialCommunityIcons name="bank-transfer-out" size={22} color={theme.primary} />
            <Text className="ml-2 text-lg font-bold" style={{ color: theme.primary }}>
              Withdrawal Request
            </Text>
          </View>

          {/* Pioneer perk banner — only shown when the user is currently
              Pioneer-exempt. Tells them their fees are zero and how many
              days are left in the exemption window. */}
          {exempt && (
            <View
              className="mb-3 flex-row items-center rounded-lg px-3 py-2"
              style={{
                backgroundColor: theme.accentPurpleSoft,
                borderWidth: 1,
                borderColor: theme.accentPurple,
              }}
            >
              <View
                className="mr-2 h-7 w-7 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.primary }}
              >
                <Feather name="star" size={14} color="#FFFFFF" />
              </View>
              <View className="flex-1">
                <Text className="text-[13px] font-bold" style={{ color: theme.primary }}>
                  Pioneer perk active — zero fees
                </Text>
                <Text className="mt-0.5 text-[11px]" style={{ color: theme.primary, opacity: 0.85 }}>
                  {daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} of free withdrawals remaining` : "Exemption window ending soon"}
                </Text>
              </View>
            </View>
          )}

          {/* Remaining Balance */}
          <View className="mb-4 rounded-lg p-3" style={{ backgroundColor: theme.card }}>
            <Text style={{ color: theme.textSoft }}>Remaining Balance</Text>
            <Text className="text-xl font-bold" style={{ color: theme.primary }}>
              ₱ {remainingBalance.toFixed(2)}
            </Text>
          </View>

          {/* Indicator if balance is less than minimum */}
          {remainingBalance < WITHDRAWAL_MINIMUM_AMOUNT && (
            <Text className="mb-3 text-sm" style={{ color: theme.danger }}>
              Your balance is below the minimum withdrawal requirement (₱{WITHDRAWAL_MINIMUM_AMOUNT}).
            </Text>
          )}

          {/* Input */}
          <Text style={{ color: theme.textSoft }}>Enter withdrawal amount (Minimum: ₱{WITHDRAWAL_MINIMUM_AMOUNT})</Text>
          <TextInput
            value={amount}
            onChangeText={handleAmountChange}
            keyboardType="numeric"
            placeholder="₱ 0.00"
            placeholderTextColor={theme.placeholder}
            className="my-3 rounded-md p-3"
            style={{ backgroundColor: theme.inputBackground, color: theme.inputText, borderWidth: 1, borderColor: theme.inputBorder }}
            editable={remainingBalance >= WITHDRAWAL_MINIMUM_AMOUNT}
          />

          {/* Divider */}
          <View className="my-2 h-[1px]" style={{ backgroundColor: theme.divider }} />

          {/* Receipt-style breakdown. Pioneer-exempt rows show 0 / "Waived". */}
          <View className="mb-2">
            <View className="flex-row justify-between">
              <Text style={{ color: theme.textSoft }}>Withdrawal Amount</Text>
              <Text style={{ color: theme.text }}>₱ {amountNum.toFixed(2)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text style={{ color: theme.textSoft }}>Platform Cost ({formatFeePct(PLATFORM_COST)}%)</Text>
              <Text style={{ color: exempt ? theme.accentGreen : theme.text }}>
                {exempt ? "Waived" : `₱ ${platformCost.toFixed(2)}`}
              </Text>
            </View>
            <View className="flex-row justify-between">
              <Text style={{ color: theme.textSoft }}>Transfer Fee ({formatFeePct(TRANSFER_FEE)}%)</Text>
              <Text style={{ color: exempt ? theme.accentGreen : theme.text }}>
                {exempt ? "Waived" : `₱ ${transferFee.toFixed(2)}`}
              </Text>
            </View>

            <View className="my-2 h-[1px]" style={{ backgroundColor: theme.divider }} />

            <View className="flex-row justify-between">
              <Text className="text-[16px] font-bold" style={{ color: theme.primary }}>
                You will receive
              </Text>
              <Text className="text-[16px] font-bold" style={{ color: theme.primary }}>
                ₱ {totalReceive > 0 ? totalReceive.toFixed(2) : "0.00"}
              </Text>
            </View>
          </View>

          {/* Actions */}
          <View className="mt-4 flex-row justify-end space-x-3">
            <TouchableOpacity onPress={onClose} className="rounded-lg px-4 py-2" style={{ backgroundColor: theme.surfaceMuted }} disabled={loading}>
              <Text style={{ color: theme.text }}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onConfirm}
              className="rounded-lg px-4 py-2"
              style={{ backgroundColor: isDisabled ? theme.primarySoft : theme.primary }}
              disabled={isDisabled}
            >
              {loading ? (
                <ActivityIndicator size="small" color={theme.primaryContrast} />
              ) : (
                <Text className="font-bold" style={{ color: theme.primaryContrast }}>
                  Confirm
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

export default WithdrawModal;
