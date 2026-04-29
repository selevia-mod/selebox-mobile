import AsyncStorage from "@react-native-async-storage/async-storage";
import { account } from "./appwrite";
import { streamClient, StreamService } from "./stream";

/**
 * Simple Stream Chat connection helper
 * Prevents duplicate connections and handles token refresh
 */
class StreamConnectionManager {
  constructor() {
    this.connectionPromise = null;
  }

  /**
   * Connect to Stream Chat
   * If a connection is already in progress, returns the existing promise
   * so all callers wait for the same connection attempt.
   * @param {string} userId - User ID to connect
   */
  async connect(userId) {
    // Already connected to the correct user
    if (streamClient.user?.id === userId) {
      console.log("Stream already connected");
      return;
    }

    // If a connection is in progress, wait for it instead of silently returning
    if (this.connectionPromise) {
      console.log("Stream connection in progress, waiting...");
      return this.connectionPromise;
    }

    this.connectionPromise = this._doConnect();

    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  async _doConnect() {
    try {
      // Disconnect any existing connection
      if (streamClient.user) {
        await streamClient.disconnectUser();
      }

      // Get Stream token
      const { jwt } = await account.createJWT();
      const { token, userId: streamUserId } = await StreamService.getStreamToken(jwt);

      // Connect to Stream
      await streamClient.connectUser({ id: streamUserId }, token);

      // Save tokens
      await AsyncStorage.setItem('streamToken', token);
      await AsyncStorage.setItem('streamUserId', streamUserId);

      console.log("Stream Chat connected");
    } catch (error) {
      console.error("Stream connection failed:", error.message || error);
      throw error;
    }
  }

  /**
   * Disconnect from Stream Chat
   */
  async disconnect() {
    try {
      await streamClient.disconnectUser();
      console.log("Stream Chat disconnected");
    } catch (error) {
      console.warn("Stream disconnect error:", error.message);
    }
  }
}

export const streamConnectionManager = new StreamConnectionManager();
