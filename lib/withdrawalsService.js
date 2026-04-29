import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";

const DB_ID = secrets.appwriteConfig.databaseId;
const USERS_WITHDRAWALS_COLLECTION_ID = secrets.appwriteConfig.usersWithdrawalsCollectionId;

/**
 * Request a withdrawal
 */
export async function requestWithdrawal(userId, amount, amountToReceive) {
  try {
    const paymentInfo = await databases.listDocuments(DB_ID, secrets.appwriteConfig.usersPaymentInformationId, [Query.equal("userId", userId)]);

    const paymentInfoId = paymentInfo?.documents?.[0]?.$id || null;

    if (!paymentInfoId) {
      throw new Error("NO_PAYMENT_INFO");
    }

    const withdrawal = await databases.createDocument(DB_ID, USERS_WITHDRAWALS_COLLECTION_ID, ID.unique(), {
      userId,
      amount,
      amountToReceive,
      usersPaymentInformation: paymentInfoId,
    });

    return withdrawal;
  } catch (err) {
    throw err;
  }
}

/**
 * Get all withdrawals for a user
 */
export async function getUserWithdrawals(userId) {
  try {
    const response = await databases.listDocuments(DB_ID, USERS_WITHDRAWALS_COLLECTION_ID, [Query.equal("userId", userId)]);

    return response.documents || [];
  } catch (err) {
    console.error("Error fetching withdrawals:", err);
    return [];
  }
}
