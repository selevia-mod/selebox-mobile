import { Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";

const DB_ID = secrets.appwriteConfig.databaseId;
const USER_EARNINGS_COLLECTION_ID = secrets.appwriteConfig.usersEarningsCollectionId;

async function fetchAllDocuments(collectionId, queries = []) {
  const allDocs = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await databases.listDocuments(DB_ID, collectionId, [...queries, Query.limit(limit), Query.offset(offset)]);

    allDocs.push(...res.documents);

    if (res.documents.length < limit) break;
    offset += limit;
  }

  return allDocs;
}

export async function fetchUserEarnings(accountId, monthYear) {
  try {
    let startDate, endDate;

    if (monthYear.includes("-")) {
      // Format: YYYY-MM
      const [year, month] = monthYear.split("-");
      const y = Number(year);
      const m = Number(month) - 1;
      startDate = new Date(y, m, 1);
      endDate = new Date(y, m + 1, 0, 23, 59, 59);
    } else {
      // Format: "September 2025"
      const [monthName, year] = monthYear.split(" ");
      const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
      startDate = new Date(Number(year), monthIndex, 1);
      endDate = new Date(Number(year), monthIndex + 1, 0, 23, 59, 59);
    }

    const lifetimeDocs = await fetchAllDocuments(USER_EARNINGS_COLLECTION_ID, [Query.equal("contentOwner", accountId)]);

    // Monthly
    const monthDocs = await fetchAllDocuments(USER_EARNINGS_COLLECTION_ID, [
      Query.equal("contentOwner", accountId),
      Query.greaterThanEqual("$createdAt", startDate.toISOString()),
      Query.lessThanEqual("$createdAt", endDate.toISOString()),
    ]);

    const lifetimeTotal = lifetimeDocs.reduce((sum, doc) => {
      const peso = Number(doc.earningAmountToPhp ?? 0);
      return sum + (Number.isFinite(peso) ? peso : 0);
    }, 0);

    let totalEarningsThisMonth = 0;
    const breakdown = { posts: 0, clips: 0, video: 0, book: 0 };

    monthDocs.forEach((doc) => {
      const { contentType } = doc;
      const peso = Number(doc.earningAmountToPhp ?? 0);
      const safePeso = Number.isFinite(peso) ? peso : 0;
      totalEarningsThisMonth += safePeso;

      if (breakdown[contentType] !== undefined) breakdown[contentType] += safePeso;
    });

    return {
      total: lifetimeTotal,
      totalEarningsThisMonth,
      breakdown,
    };
  } catch (err) {
    console.error("Error fetching earnings:", err);
    return {
      total: 0,
      totalEarningsThisMonth: 0,
      breakdown: { posts: 0, clips: 0, video: 0, book: 0 },
    };
  }
}
