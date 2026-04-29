import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { MaintenanceModules, Modules } from "../constants/app";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { streamConnectionManager } from "../lib/stream-connection-manager";

export const StreamChatLoader = ({ children }) => {
  const { user, streamConnectionState, setStreamConnectionState } = useGlobalContext();
  const { theme } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hasAttemptedConnection = useRef(false);
  const isMaintenance = MaintenanceModules.includes(Modules.chats);

  useEffect(() => {
    if (isMaintenance) {
      setLoading(false);
      return;
    }
    if (streamConnectionState === "connected") {
      setLoading(false);
      setError(null);
      hasAttemptedConnection.current = false;
      return;
    }

    if (!user?.$id || hasAttemptedConnection.current) return;

    hasAttemptedConnection.current = true;
    setLoading(true);
    setError(null);

    // This will either start a new connection or wait for the
    // in-progress bootstrap connection to complete
    streamConnectionManager
      .connect(user.$id)
      .then(() => {
        setStreamConnectionState("connected");
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Connection failed");
        setLoading(false);
        setStreamConnectionState("error");
        hasAttemptedConnection.current = false; // Allow retry
      });
  }, [user?.$id, streamConnectionState, setStreamConnectionState]);

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: theme.backgroundMuted }}>
        <Ionicons name="chatbubbles" size={40} color={theme.primary} style={{ marginBottom: 12 }} />
        <ActivityIndicator size="large" color={theme.primary} />
        <Text className="mt-4 font-pmedium" style={{ color: theme.text }}>
          Connecting...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: theme.backgroundMuted }}>
        <View style={{ backgroundColor: theme.dangerSoft, borderRadius: 999, padding: 16, marginBottom: 12 }}>
          <Ionicons name="cloud-offline-outline" size={36} color={theme.danger} />
        </View>
        <Text className="mb-2 font-pmedium" style={{ color: theme.danger }}>
          Connection Failed
        </Text>
        <Text className="mb-6 text-center" style={{ color: theme.textSoft }}>
          {error}
        </Text>
        <TouchableOpacity
          onPress={() => {
            setError(null);
            hasAttemptedConnection.current = false;
            setStreamConnectionState("disconnected");
          }}
          className="flex-row items-center rounded-xl px-6 py-3"
          style={{ backgroundColor: theme.primary }}
        >
          <Ionicons name="refresh" size={18} color={theme.primaryContrast} style={{ marginRight: 6 }} />
          <Text className="font-psemibold" style={{ color: theme.primaryContrast }}>
            Retry
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return children;
};
