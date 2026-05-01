import axios from "axios";
import { account, appwriteConfig, databases } from "./appwrite";

const EARN_STAR_API = "https://68cefb3800191e5e39eb.fra.appwrite.run";
const GET_STARS_API = "https://68d173f5003301951815.fra.appwrite.run";

export const StarService = {
  /**
   * Earn a star by calling the Cloud Function.
   * Requires a valid Appwrite JWT to authenticate the request.
   * Returns updated star balance and ad tracking info.
   */
  earnStar: async () => {
    try {
      const { jwt } = await account.createJWT();
      const response = await axios.post(
        EARN_STAR_API,
        {},
        {
          headers: { "x-appwrite-jwt": jwt },
        },
      );

      if (response.data.error) {
        throw new Error(response.data.error);
      }

      return response.data;
    } catch (err) {
      console.error("Earn star failed:", err.message);
      throw err;
    }
  },

  /**
   * Get current star balance via Cloud Function
   * Requires a valid Appwrite JWT to authenticate the request.
   * Returns stars, adsWatchedToday, and lastWatchedDate.
   */
  getStars: async () => {
    try {
      const { jwt } = await account.createJWT();
      const response = await axios.post(
        GET_STARS_API,
        {},
        {
          headers: { "x-appwrite-jwt": jwt },
        },
      );

      if (response.data.error) {
        throw new Error(response.data.error);
      }

      return response.data; // should include stars, adsWatchedToday, lastWatchedDate
    } catch (err) {
      console.error("Get stars failed:", err.message);
      throw err;
    }
  },

  /**
   * Update star balance of a specific user.$id
   * Requires userStarId (User) and stars (Value).
   * Returns stars, adsWatchedToday, and lastWatchedDate.
   */
  updateStars: async (userStarId, stars) => {
    try {
      const updateStarsResponse = databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.starsCollectionId, userStarId, {
        stars: stars,
      });

      return updateStarsResponse;
    } catch (err) {
      console.error("Update stars failed:", err.message);
      throw err;
    }
  },
};
