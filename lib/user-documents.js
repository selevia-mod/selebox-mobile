import { ID, Query } from "react-native-appwrite";
import { databases, storage } from "../lib/appwrite"; // adjust your appwrite setup path
import secrets from "../private/secrets";

const DATABASE_ID = secrets.appwriteConfig.databaseId;
const USERS_PAYMENT_INFORMATION_COLLECTION_ID = secrets.appwriteConfig.usersPaymentInformationId;
const BUCKET_ID = secrets.appwriteConfig.userDocumentsStorageId;

const UserDocumentsService = {
  /**
   * Upload a file to Appwrite storage
   * @param {string} uri - local file URI
   * @returns {Promise<string>} - file URL
   */
  async uploadFile(file) {
    const { convertToWebP, cleanupTempFile } = require("./utils/image-utils");
    const webp = await convertToWebP(file.uri);
    try {
      const response = await storage.createFile(BUCKET_ID, ID.unique(), {
        uri: webp.uri,
        type: "image/webp",
        size: webp.fileSize,
        name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
      });
      return storage.getFilePreview(BUCKET_ID, response.$id);
    } catch (error) {
      console.error("Upload error:", error);
      throw error;
    } finally {
      cleanupTempFile(webp.uri, file.uri);
    }
  },

  /**
   * Save payment info (with uploaded file URLs) to collection
   */
  async savePaymentInfo(userId, data) {
    try {
      return await databases.createDocument(DATABASE_ID, USERS_PAYMENT_INFORMATION_COLLECTION_ID, ID.unique(), {
        userId,
        name: data.name,
        phone: data.phone,
        date_of_birth: data.dateOfBirth,
        email: data.email,
        address: data.address,
        payment_method: data.paymentMethod,
        valid_id: data.valid_id || null,
        qr_code: data.qr_code,
        signature: data.signature || null,
      });
    } catch (error) {
      console.error("Save error:", error);
      throw error;
    }
  },

  /**
   * Fetch user’s saved payment info
   */
  async fetchPaymentInfo(userId) {
    try {
      const res = await databases.listDocuments(DATABASE_ID, USERS_PAYMENT_INFORMATION_COLLECTION_ID, [Query.equal("userId", userId)]);

      return res.documents.length > 0 ? res.documents[0] : null;
    } catch (error) {
      console.error("Fetch error:", error);
      throw error;
    }
  },
};

export default UserDocumentsService;
