import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { appwriteConfig, databases } from "./appwrite";

const HOME_CAMPAIGN_SURFACE = "home_startup_modal";
const ACTIVE_CAMPAIGN_STATUS = "active";
const DEFAULT_STATE_VERSION = 1;
const DEFAULT_COOLDOWN_HOURS = 24;
const MAX_CAMPAIGN_QUERY_LIMIT = 50;
const MAX_CAMPAIGN_STATE_QUERY_LIMIT = 100;
const SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;

const missingConfig = (key) => {
  console.warn(`[campaigns] Missing Appwrite config for ${key}.`);
  return null;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveCampaignUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const normalizedPath = raw.startsWith("/") ? raw : `/${raw}`;
  return `${secrets.WEBSITE.replace(/\/$/, "")}${normalizedPath}`;
};

const resolveCampaignActionUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (SCHEME_REGEX.test(raw)) return raw;
  if (raw.startsWith("/")) return `${secrets.WEBSITE.replace(/\/$/, "")}${raw}`;
  return `https://${raw}`;
};

const isCampaignInScheduleWindow = (campaign, nowMs) => {
  const startAt = campaign?.startAt ? new Date(campaign.startAt).getTime() : null;
  const endAt = campaign?.endAt ? new Date(campaign.endAt).getTime() : null;

  if (Number.isFinite(startAt) && nowMs < startAt) return false;
  if (Number.isFinite(endAt) && nowMs > endAt) return false;
  return true;
};

const canRenderCampaign = (campaign) => {
  if (!campaign) return false;
  if (campaign.contentType === "image") return Boolean(String(campaign.imageUrl || "").trim());
  if (campaign.contentType === "web") return Boolean(resolveCampaignUrl(campaign.webPath));
  return false;
};

const sortCampaigns = (campaigns = []) =>
  [...campaigns].sort((left, right) => {
    const priorityDiff = toNumber(right?.priority) - toNumber(left?.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const leftUpdated = new Date(left?.$updatedAt || 0).getTime() || 0;
    const rightUpdated = new Date(right?.$updatedAt || 0).getTime() || 0;
    return rightUpdated - leftUpdated;
  });

const getCooldownHours = (campaign) => Math.max(1, toNumber(campaign?.cooldownHours, DEFAULT_COOLDOWN_HOURS));

const getStateSortTime = (stateDoc) => {
  const lastShownAtMs = stateDoc?.lastShownAt ? new Date(stateDoc.lastShownAt).getTime() : 0;
  if (Number.isFinite(lastShownAtMs) && lastShownAtMs > 0) return lastShownAtMs;

  const updatedAtMs = stateDoc?.$updatedAt ? new Date(stateDoc.$updatedAt).getTime() : 0;
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) return updatedAtMs;

  const createdAtMs = stateDoc?.$createdAt ? new Date(stateDoc.$createdAt).getTime() : 0;
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
};

const buildUserCampaignStateMap = (documents = []) => {
  const stateMap = new Map();

  documents.forEach((stateDoc) => {
    const campaignId = String(stateDoc?.campaignId || "").trim();
    if (!campaignId) return;

    const existingStateDoc = stateMap.get(campaignId);
    if (!existingStateDoc || getStateSortTime(stateDoc) > getStateSortTime(existingStateDoc)) {
      stateMap.set(campaignId, stateDoc);
    }
  });

  return stateMap;
};

const listUserCampaignStates = async ({ userId, campaignIds = [] }) => {
  if (!appwriteConfig.userCampaignStateCollectionId) return missingConfig("userCampaignStateCollectionId");
  if (!userId || campaignIds.length === 0) return new Map();

  const uniqueCampaignIds = [...new Set(campaignIds.filter(Boolean))];
  if (uniqueCampaignIds.length === 0) return new Map();

  const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, [
    Query.equal("userId", userId),
    Query.equal("campaignId", uniqueCampaignIds),
    Query.limit(Math.min(MAX_CAMPAIGN_STATE_QUERY_LIMIT, Math.max(uniqueCampaignIds.length * 2, 25))),
  ]);

  return buildUserCampaignStateMap(response.documents || []);
};

const isCampaignEligible = ({ campaign, stateDoc, nowMs }) => {
  if (!campaign) return false;
  if (!canRenderCampaign(campaign)) return false;
  if (!isCampaignInScheduleWindow(campaign, nowMs)) return false;

  if (!stateDoc) return true;

  const frequencyMode = String(campaign.frequencyMode || "once_per_campaign");

  if (frequencyMode === "every_session") return true;

  const lastShownAtMs = stateDoc?.lastShownAt ? new Date(stateDoc.lastShownAt).getTime() : 0;
  if (!Number.isFinite(lastShownAtMs) || lastShownAtMs <= 0) return true;

  if (frequencyMode === "cooldown") {
    const cooldownMs = getCooldownHours(campaign) * 60 * 60 * 1000;
    return nowMs - lastShownAtMs >= cooldownMs;
  }

  return false;
};

export const getEligibleHomeCampaign = async ({ userId }) => {
  if (!appwriteConfig.campaignsCollectionId) return missingConfig("campaignsCollectionId");
  if (!appwriteConfig.userCampaignStateCollectionId) return missingConfig("userCampaignStateCollectionId");

  const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.campaignsCollectionId, [
    Query.equal("status", ACTIVE_CAMPAIGN_STATUS),
    Query.equal("surface", HOME_CAMPAIGN_SURFACE),
    Query.limit(MAX_CAMPAIGN_QUERY_LIMIT),
  ]);

  const nowMs = Date.now();
  const campaigns = sortCampaigns(response.documents || []).filter(
    (campaign) => canRenderCampaign(campaign) && isCampaignInScheduleWindow(campaign, nowMs),
  );
  if (campaigns.length === 0) return null;

  const stateMap = await listUserCampaignStates({
    userId,
    campaignIds: campaigns.map((campaign) => campaign.$id),
  });

  for (const campaign of campaigns) {
    const stateDoc = stateMap.get(campaign.$id) || null;
    if (isCampaignEligible({ campaign, stateDoc, nowMs })) {
      return {
        campaign,
        stateDoc,
      };
    }
  }

  return null;
};

export const buildCampaignTargetUrl = (campaign) => {
  if (!campaign || campaign.contentType !== "web") return null;
  return resolveCampaignUrl(campaign.webPath);
};

export const buildCampaignActionUrl = (campaign) => {
  if (!campaign) return null;
  return resolveCampaignActionUrl(campaign.actionUrl);
};

export const recordCampaignImpression = async ({ userId, campaign, stateDoc }) => {
  if (!appwriteConfig.userCampaignStateCollectionId) return missingConfig("userCampaignStateCollectionId");

  const shownAt = new Date().toISOString();

  if (!stateDoc?.$id) {
    const basePayload = {
      userId,
      campaignId: campaign.$id,
      firstShownAt: shownAt,
      lastShownAt: shownAt,
    };

    try {
      return await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, ID.unique(), basePayload);
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (!message.includes("stateversion")) throw error;

      return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, ID.unique(), {
        ...basePayload,
        stateVersion: DEFAULT_STATE_VERSION,
      });
    }
  }

  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, stateDoc.$id, {
    lastShownAt: shownAt,
    ...(!stateDoc.firstShownAt ? { firstShownAt: shownAt } : {}),
  });
};

export const recordCampaignDismissal = async ({ stateDocumentId }) => {
  if (!stateDocumentId || !appwriteConfig.userCampaignStateCollectionId) return null;

  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, stateDocumentId, {
    dismissedAt: new Date().toISOString(),
  });
};

export const recordCampaignCompletion = async ({ stateDocumentId }) => {
  if (!stateDocumentId || !appwriteConfig.userCampaignStateCollectionId) return null;

  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCampaignStateCollectionId, stateDocumentId, {
    completedAt: new Date().toISOString(),
  });
};
