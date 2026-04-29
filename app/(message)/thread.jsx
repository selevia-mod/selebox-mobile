import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Channel, Thread } from "stream-chat-expo";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import { streamClient } from "../../lib/stream";

const ThreadScreen = () => {
  const router = useRouter();
  const { channelId, parentMessageId } = useLocalSearchParams();

  const [channel, setChannel] = useState(null);
  const [parentMessage, setParentMessage] = useState(null);

  useEffect(() => {
    let mounted = true;

    const loadThread = async () => {
      try {
        const ch = streamClient.channel("messaging", channelId);
        await ch.watch();
        if (!mounted) return;

        setChannel(ch);

        // Try to get the parent message
        let message = ch.state.messages.find((m) => m.id === parentMessageId);

        // If not found in state, fetch directly
        if (!message) {
          const res = await streamClient.getMessage(parentMessageId);
          message = res.message;
        }

        if (mounted) {
          setParentMessage(message);
        }
      } catch (err) {
        console.error("Error loading thread:", err);
      }
    };

    if (channelId && parentMessageId) {
      loadThread();
    }

    return () => {
      mounted = false;
    };
  }, [channelId, parentMessageId]);

  if (!channel || !parentMessage) {
    return (
      <SafeAreaView className="flex-1 bg-gray-900">
        {/* Skeleton Header */}
        <View className="flex-row items-center border-b border-white/5 px-4 pb-3 pt-2">
          <AnimatedSkeleton style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} />
          <View>
            <AnimatedSkeleton style={{ width: 80, height: 16, marginBottom: 6 }} />
            <AnimatedSkeleton style={{ width: 140, height: 12 }} />
          </View>
        </View>

        {/* Skeleton Parent Message */}
        <View className="border-b border-white/5 px-4 py-4">
          <View className="flex-row items-center mb-3">
            <AnimatedSkeleton style={{ width: 32, height: 32, borderRadius: 16, marginRight: 10 }} />
            <AnimatedSkeleton style={{ width: 100, height: 14 }} />
          </View>
          <AnimatedSkeleton style={{ width: "90%", height: 14, marginBottom: 8 }} />
          <AnimatedSkeleton style={{ width: "70%", height: 14 }} />
        </View>

        {/* Skeleton Replies */}
        {[1, 2, 3].map((i) => (
          <View key={i} className="flex-row px-4 py-3">
            <AnimatedSkeleton style={{ width: 28, height: 28, borderRadius: 14, marginRight: 10, marginTop: 2 }} />
            <View style={{ flex: 1 }}>
              <AnimatedSkeleton style={{ width: 80, height: 12, marginBottom: 6 }} />
              <AnimatedSkeleton style={{ width: i === 2 ? "60%" : "80%", height: 13, marginBottom: 4 }} />
              {i !== 3 && <AnimatedSkeleton style={{ width: "45%", height: 13 }} />}
            </View>
          </View>
        ))}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
      {/* Header */}
      <View className="flex-row items-center border-b border-white/5 px-4 pb-3 pt-2">
        <TouchableOpacity
          onPress={() => router.back()}
          className="mr-3 h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
        >
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </TouchableOpacity>
        <View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="chatbubbles" size={16} color="#7975D4" style={{ marginRight: 6 }} />
            <Text className="text-lg font-bold text-white">Thread</Text>
          </View>
          <Text className="text-sm" numberOfLines={1}>
            <Text style={{ color: "rgba(255,255,255,0.4)" }}>Replying to: </Text>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontWeight: "500" }}>{parentMessage?.user?.name || "Unknown"}</Text>
          </Text>
        </View>
      </View>

      {/* Thread */}
      <Channel
        additionalKeyboardAvoidingViewProps={{
          style: {
            marginBottom: 75,
          },
        }}
        channel={channel}
        thread={parentMessage}
        threadList
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : -100}
      >
        <Thread />
      </Channel>
    </SafeAreaView>
  );
};

export default ThreadScreen;
