import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { StyledSafeAreaView, StyledTitle } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import Earnings from "./earnings";
import PaymentInformation from "./payment-information";

const TABS = [
  { key: "Earnings", label: "Earnings", iconFamily: "MaterialCommunityIcons", iconName: "chart-line" },
  { key: "Payment Information", label: "Payment Info", iconFamily: "MaterialIcons", iconName: "credit-card" },
];

const TabIcon = ({ family, name, color }) => {
  if (family === "MaterialCommunityIcons") return <MaterialCommunityIcons name={name} size={16} color={color} />;
  return <MaterialIcons name={name} size={16} color={color} />;
};

const Payments = () => {
  const { theme } = useAppTheme();
  const [activeTab, setActiveTab] = useState("Earnings");
  const [hasLoadedPaymentInfo, setHasLoadedPaymentInfo] = useState(false);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    if (tab === "Payment Information" && !hasLoadedPaymentInfo) {
      setHasLoadedPaymentInfo(true);
    }
  };

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full pb-5" style={{ backgroundColor: theme.background }}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
            onPress={() => router.back()}
          >
            <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="account-balance-wallet" size={22} color={theme.icon} />} title={"Payments"} />
          </View>
          <View className="h-10 w-10" />
        </View>

        {/* Tabs */}
        <View
          className="mx-4 mt-2 flex-row rounded-2xl p-1"
          style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const iconColor = isActive ? theme.primaryContrast : theme.iconMuted;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => handleTabChange(tab.key)}
                className="flex-1 flex-row items-center justify-center rounded-xl py-2.5"
                style={{ backgroundColor: isActive ? theme.primary : "transparent" }}
                activeOpacity={0.8}
              >
                <TabIcon family={tab.iconFamily} name={tab.iconName} color={iconColor} />
                <Text className="ml-1.5 text-center text-sm font-semibold" style={{ color: isActive ? theme.primaryContrast : theme.textSoft }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
          <View style={{ display: activeTab === "Earnings" ? "flex" : "none" }}>
            {/* `onSwitchToPaymentInfo` is passed in so Earnings can
                deep-link the user to the Payment Info tab when the
                first-Supabase-withdrawal verify gate fires. Routing
                via setActiveTab keeps the navigation in-screen
                (faster than router.push to a separate route) and
                preserves whatever month filter the user had open. */}
            <Earnings onSwitchToPaymentInfo={() => handleTabChange("Payment Information")} />
          </View>
          {hasLoadedPaymentInfo && (
            <View
              style={{
                display: activeTab === "Payment Information" ? "flex" : "none",
              }}
            >
              <PaymentInformation />
            </View>
          )}
        </ScrollView>
      </View>
    </StyledSafeAreaView>
  );
};

export default Payments;
