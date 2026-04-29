import { ID } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

export class UserEarningsService {
  async createUserEarning({ contentId, contentType, contentOwner, earningType, earningAmount, earningFromUser }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userEarningsCollectionId, ID.unique(), {
      contentId,
      contentType,
      contentOwner,
      earningType,
      earningAmount,
      earningFromUser,
    });
  }

  async deleteUserEarning({ userEarningId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.userEarningsCollectionId, userEarningId);
  }
}
