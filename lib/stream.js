import { ID } from "react-native-appwrite";
import { StreamChat } from "stream-chat";
import secrets from "../private/secrets";

export const streamClient = StreamChat.getInstance(secrets.STREAM_API_KEY);
export class StreamService {
  static async getStreamToken(jwt) {
    const response = await fetch("https://6899cd57000a724dc455.fra.appwrite.run", {
      method: "GET",
      headers: {
        "x-appwrite-jwt": jwt,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get Stream token: ${response.statusText}`);
    }

    return response.json(); // { token, userId }
  }

  async ensureUserExists(users) {
    const response = await fetch("https://689b08b70039351cb570.fra.appwrite.run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users: users }),
    });

    if (!response.ok) {
      throw new Error(`Failed to upsert Stream user: ${response.statusText}`);
    }

    return response.json();
  }

  async createNewChannel({ selectedUsers, currentUser, groupName }) {
    // Include the current user in the members list
    const members = [currentUser, ...selectedUsers];

    // Detect if this is 1:1 or group
    const isOneOnOne = members.length === 2;

    let channel;
    if (isOneOnOne) {
      // Sort member IDs to make the channel unique regardless of order
      const sortedIds = members.map((m) => m.$id).sort();
      channel = streamClient.channel("messaging", {
        members: sortedIds,
      });
    } else {
      // For group messages, generate a random channel id and set a name
      channel = streamClient.channel("messaging", `group-${ID.unique()}`, {
        members: members.map((m) => m.$id),
        name: groupName ?? members.map((m) => m.username).join(", "),
        isGroup: true,
      });
    }

    // Create or get existing channel
    await channel.create();
    return channel;
  }

  // async syncAppwriteUsersToStream() {
  //   const databaseId = secrets.appwriteConfig.databaseId;
  //   const collectionId = secrets.appwriteConfig.userCollectionId;
  //   const limit = 100;

  //   let cursor = "679c4efe3dcd51288789";
  //   let totalSynced = 0;

  //   try {
  //     while (true) {
  //       const queries = [Query.limit(limit)];
  //       if (cursor) queries.push(Query.cursorAfter(cursor));

  //       const users = await databases.listDocuments(databaseId, collectionId, queries);

  //       if (!users.documents || users.documents.length === 0) {
  //         break;
  //       }

  //       // Upsert batch to Stream
  //       await this.ensureUserExists(users.documents);

  //       totalSynced += users.documents.length;
  //       console.log(`✅ Synced batch of ${users.documents.length} users (total: ${totalSynced})`);

  //       // Move cursor to last doc
  //       cursor = users.documents[users.documents.length - 1].$id;

  //       // Stop if fewer than limit (last page)
  //       if (users.documents.length < limit) break;
  //     }

  //     console.log(`🎉 Finished syncing. Total users synced: ${totalSynced}`);
  //   } catch (err) {
  //     console.error("❌ Failed to sync users to Stream:", err);
  //     throw err;
  //   }
  // }
}
