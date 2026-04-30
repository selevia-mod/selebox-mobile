// Phase D — Supabase-only chat. Stream Chat removed.
//
// This screen is now a thin shell: a header (back button + title + new-chat
// pencil) + the SupabaseConversationsList component. All Stream Chat
// imports, channel filters, custom previews, and maintenance-mode branches
// are gone — the previous version of this file shipped them all behind a
// feature flag, but per the user's request we've stopped maintaining the
// old paths and the only chat experience now is Supabase-native.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import SupabaseConversationsList from "../../components/SupabaseConversationsList";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";

const ChannelListScreen = () => {
  const { theme } = useAppTheme();
  // chatUserId is the Supabase UUID for the current user (resolved from
  // user.$id via profiles.legacy_appwrite_id when running on the Appwrite
  // auth path). Use it for chat queries — `user.$id` is the Appwrite hex
  // and won't match `profiles.id`.
  const { chatUserId } = useGlobalContext();

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border"
            style={{ borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
          >
            <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
          </TouchableOpacity>
          <Text className="ml-3 font-sans text-2xl font-bold" style={{ color: theme.text }}>
            Messages
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("new-chat")}
          className="h-10 w-10 items-center justify-center rounded-full border"
          style={{ borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
        >
          <Feather name="edit" size={18} color={theme.icon} />
        </TouchableOpacity>
      </View>

      <SupabaseConversationsList currentUserId={chatUserId} />
    </SafeAreaView>
  );
};

export default ChannelListScreen;
