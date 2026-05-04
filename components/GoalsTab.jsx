// GoalsTab — daily / weekly / monthly engagement goals.
//
// React-Native port of the web app's Daily Goals panel
// (Selebox/index.html + Selebox/js/app.js). Shares the same pool model,
// reward economics, and quest definitions so a single user sees
// identical goals on both platforms once backend syncing lands.
//
// Pool model recap:
//   • Each tier (daily / weekly / monthly) offers N quests.
//   • Clear M of N to unlock the pool reward (stars + coins).
//   • Bonus-tagged quests carry an extra +X coin payout on top of the
//     pool, settled separately (acquisition / IAP-margin lines).
//
// State today is local-only (useState) so this is a preview surface —
// progress doesn't persist across app launches and isn't wired to
// real engagement events. When the Supabase schema lands
// (daily_quests + user_quest_progress), swap this component's state
// to a hook that subscribes to those tables.

import { Feather, Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, Share, Text, TouchableOpacity, View } from "react-native";
import Svg, { Circle, Path, Polygon } from "react-native-svg";
import useAppTheme from "../hooks/useAppTheme";
import { loadPoolClaimed, loadProgress, markPoolClaimed } from "../lib/goals-store";
import { buildInviteUrl, getMyReferralCode } from "../lib/referrals";

// ─── Quest definitions ────────────────────────────────────────────────
// Mirrors the web client. Per-quest `reward` field intentionally omitted
// — pool model means rewards bundle at the top, not per quest. Bonus
// tags only appear on quests that carry an extra coin settlement.

const DAILY_QUESTS = [
  { id: "login",         icon: "login",     label: "Log in today",            target: 1,  unit: "" },
  { id: "read_chapters", icon: "book",      label: "Read 3 chapters",         target: 3,  unit: "" },
  { id: "watch_video",   icon: "video",     label: "Watch 10 mins of video",  target: 10, unit: "min" },
  { id: "like_comment",  icon: "heart",     label: "Like & comment 3 posts",  target: 3,  unit: "" },
  { id: "follow_user",   icon: "user-plus", label: "Follow 1 new user",       target: 1,  unit: "" },
  { id: "watch_ads",     icon: "ad",        label: "Watch 3 ads",             target: 3,  unit: "" },
  { id: "invite_friend", icon: "gift",      label: "Invite 1 friend",         target: 1,  unit: "", bonus: { coins: 1 } },
];

const WEEKLY_QUESTS = [
  { id: "w_read_chapters", icon: "book",      label: "Read 20 chapters",          target: 20, unit: "" },
  { id: "w_watch_video",   icon: "video",     label: "Watch 60 mins of video",    target: 60, unit: "min" },
  { id: "w_like_comment",  icon: "heart",     label: "Like & comment 20 times",   target: 20, unit: "" },
  { id: "w_follow_users",  icon: "user-plus", label: "Follow 5 users",            target: 5,  unit: "" },
  { id: "w_share",         icon: "compass",   label: "Share 5 books or videos",   target: 5,  unit: "" },
  { id: "w_unlock",        icon: "gift",      label: "Unlock 3 books or videos",  target: 3,  unit: "" },
  { id: "w_watch_ads",     icon: "ad",        label: "Watch 10 ads",              target: 10, unit: "" },
  { id: "w_invite_friend", icon: "user-plus", label: "Invite 5 friends",          target: 5,  unit: "", bonus: { coins: 3 } },
  { id: "w_purchase_coin", icon: "gift",      label: "Purchase coins",            target: 1,  unit: "", bonus: { coins: 3 } },
];

const MONTHLY_QUESTS = [
  { id: "m_read_chapters", icon: "book",      label: "Read 100 chapters",         target: 100, unit: "" },
  { id: "m_watch_video",   icon: "video",     label: "Watch 300 mins of video",   target: 300, unit: "min" },
  { id: "m_like_comment",  icon: "heart",     label: "Like & comment 100 times",  target: 100, unit: "" },
  { id: "m_follow_users",  icon: "user-plus", label: "Follow 20 users",           target: 20,  unit: "" },
  { id: "m_share",         icon: "compass",   label: "Share 20 books or videos",  target: 20,  unit: "" },
  { id: "m_unlock",        icon: "gift",      label: "Unlock 30 books or videos", target: 30,  unit: "" },
  { id: "m_watch_ads",     icon: "ad",        label: "Watch 100 ads",             target: 100, unit: "" },
  // `required: true` — quest MUST be completed to unlock the monthly
  // pool reward, regardless of how many other quests are done. Without
  // this gate, a user could clear 9 of the 10 quests in any combination
  // and claim the reward, including by skipping Stay-active-30-days
  // entirely. Real retention signals are most valuable here, so the
  // 30-day-active streak is the anchor of the monthly tier.
  { id: "m_active30",      icon: "login",     label: "Stay active 30 days",       target: 30,  unit: " days", required: true },
  { id: "m_purchase_coin", icon: "gift",      label: "Purchase coins 4 times",    target: 4,   unit: "", bonus: { coins: 5 } },
  { id: "m_invite_friend", icon: "user-plus", label: "Invite 10 friends",         target: 10,  unit: "", bonus: { coins: 5 } },
];

const POOL_CONFIG = {
  daily:   { questsRequired: 5, reward: { stars: 4, coins: 1 } },
  weekly:  { questsRequired: 6, reward: { stars: 8, coins: 2 } },
  monthly: { questsRequired: 9, reward: { stars: 0, coins: 1000 } },
};

const TAB_TITLE = {
  daily:   "Daily Reward",
  weekly:  "Weekly Reward",
  monthly: "Monthly Reward",
};

// ─── Inline SVG icons (matches web) ──────────────────────────────────
const StarIcon = ({ size = 14, color = "#fff" }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Polygon points="12,2 14.6,9 22,9.5 16.2,14 17.9,21.5 12,17.5 6.1,21.5 7.8,14 2,9.5 9.4,9" fill={color} />
  </Svg>
);

const CoinIcon = ({ size = 14, color = "#fff" }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Circle cx="12" cy="12" r="9.5" fill={color} />
    <Circle cx="12" cy="12" r="6.5" fill="rgba(255,255,255,0.35)" />
    <Circle cx="12" cy="12" r="3.5" fill={color} />
  </Svg>
);

const BoltIcon = ({ size = 12, color }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M14.5 2 L4 13.5 L11 13.5 L9.5 22 L20 10.5 L13 10.5 Z" fill={color} />
  </Svg>
);

// Quest icon render — Feather/Ionicons set, single source of truth.
const QuestIcon = ({ name, color, size = 18 }) => {
  switch (name) {
    case "login":     return <Ionicons name="log-in-outline" size={size} color={color} />;
    case "book":      return <Feather name="book-open" size={size} color={color} />;
    case "video":     return <Feather name="video" size={size} color={color} />;
    case "heart":     return <Feather name="heart" size={size} color={color} />;
    case "user-plus": return <Feather name="user-plus" size={size} color={color} />;
    case "compass":   return <Feather name="compass" size={size} color={color} />;
    case "gift":      return <Feather name="gift" size={size} color={color} />;
    case "ad":        return <Feather name="tv" size={size} color={color} />;
    default:          return <Feather name="circle" size={size} color={color} />;
  }
};

const GoalsTab = () => {
  const { theme, isDarkMode } = useAppTheme();
  const [period, setPeriod] = useState("daily"); // daily | weekly | monthly
  // Progress shape: { daily: {questId: count}, weekly: {...}, monthly: {...} }
  // Hydrated from AsyncStorage via lib/goals-store on focus.
  const [progressByPeriod, setProgressByPeriod] = useState({ daily: {}, weekly: {}, monthly: {} });
  const [poolClaimed, setPoolClaimed] = useState({ daily: false, weekly: false, monthly: false });
  const [streak] = useState(0); // not yet wired to anything real

  // Re-hydrate on every focus so a tickGoal call from a different
  // screen (e.g. book-reading.jsx after a chapter completes) shows up
  // when the user navigates back here. AsyncStorage is the source of
  // truth between renders.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [progress, claimed] = await Promise.all([loadProgress(), loadPoolClaimed()]);
        if (cancelled) return;
        setProgressByPeriod(progress);
        setPoolClaimed(claimed);
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const quests = period === "daily" ? DAILY_QUESTS : period === "weekly" ? WEEKLY_QUESTS : MONTHLY_QUESTS;
  const pool = POOL_CONFIG[period];
  const progress = progressByPeriod[period] || {};

  const completedCount = useMemo(
    () => quests.filter((q) => (progress[q.id] || 0) >= q.target).length,
    [quests, progress],
  );
  // `required: true` quests MUST all be completed to unlock the pool
  // reward in addition to hitting the questsRequired count. Currently
  // this only applies to monthly's "Stay active 30 days" — the rest of
  // the pool is interchangeable. Without this second check, a user
  // could finish 9 of the 10 monthly quests in any combination and
  // skip the retention anchor.
  const requiredQuests = useMemo(() => quests.filter((q) => q.required), [quests]);
  const requiredQuestsDone = useMemo(
    () => requiredQuests.every((q) => (progress[q.id] || 0) >= q.target),
    [requiredQuests, progress],
  );
  const reachedThreshold = completedCount >= pool.questsRequired && requiredQuestsDone;
  const claimed = poolClaimed[period];

  // Quest tap handler — opens the appropriate native flow per quest.
  // Today only `invite_friend` (and its weekly/monthly mirrors) is
  // wired; the others stay non-interactive and are progressed by
  // their organic surfaces (login, read, watch_video, etc.).
  //
  // CRITICAL — invite credit is server-driven, NOT share-tap-driven.
  // The previous client-side `tickGoal('invite_friend')` on
  // Share.sharedAction was trivially game-able: tap "Copy link" in
  // the share sheet → goal credited without anyone signing up. Now:
  //
  //   1. Build the user's personal `?ref=<code>` URL via
  //      getMyReferralCode() (server RPC; cached for the session).
  //   2. Open the share sheet with that URL embedded in the message.
  //   3. DO NOT tick the goal here. The credit fires server-side
  //      inside `redeem_referral` (migration_referrals.sql) when a
  //      brand-new account signs up using the captured code — the
  //      RPC ticks the inviter's daily/weekly/monthly invite_friend
  //      counters under their user_id, with UNIQUE(invitee_id) on
  //      public.referrals enforcing one credit per real signup.
  //
  // The quest row's progress bar will update on the next focus
  // (loadProgress refetch) once the friend completes signup.
  const handleQuestTap = async (quest) => {
    if (!quest) return false;
    if (quest.id === "invite_friend" || quest.id === "w_invite_friend" || quest.id === "m_invite_friend") {
      try {
        const code = await getMyReferralCode();
        if (!code) {
          Alert.alert(
            "Couldn't get your invite link",
            "Make sure you're signed in and try again. If this keeps happening, restart the app.",
          );
          return true;
        }
        const inviteUrl = buildInviteUrl(code);
        await Share.share({
          message: `Hey! I've been using Selebox — books, videos, stories all in one place. Sign up with my invite link: ${inviteUrl}`,
          url: inviteUrl, // iOS link preview; Android ignores in favor of message.
          title: "Invite to Selebox",
        });
        // Intentionally NOT calling tickGoal here. Credit fires when
        // someone actually signs up via the link.
      } catch (err) {
        if (__DEV__) console.log("[goals] invite share error:", err?.message);
      }
      return true;
    }
    return false;
  };

  const handleClaim = async () => {
    if (!reachedThreshold || claimed) return;
    // Optimistic flip first so the UI reflects the claim immediately;
    // the RPC settles the real claim record server-side. UNIQUE index
    // on user_goal_claims rejects double-claims even if two devices
    // tap simultaneously — only the first lands, the second comes
    // back with already_claimed=true (still ok=true, no error).
    setPoolClaimed({ ...poolClaimed, [period]: true });
    await markPoolClaimed(period, pool.reward);
    // Wallet credit happens inside the claim RPC once
    // USE_SUPABASE_WALLET flips on. Until then, the claim record is
    // canonical (so we know who's been paid) but the visible balance
    // bump is still client-side via the topbar pill animation.
  };

  // ─── Sub-tabs (Daily / Weekly / Monthly) ──────────────────────────
  const TabButton = ({ value, label }) => {
    const isActive = period === value;
    return (
      <TouchableOpacity
        onPress={() => setPeriod(value)}
        activeOpacity={0.85}
        className="flex-1 items-center justify-center py-2"
        style={{
          borderBottomWidth: 2,
          borderBottomColor: isActive ? theme.primary : "transparent",
        }}
      >
        <Text
          className="font-psemibold text-sm"
          style={{
            color: isActive ? theme.text : theme.textSoft,
            letterSpacing: 0.1,
          }}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  // ─── Pool reward pill ─────────────────────────────────────────────
  const stars = pool.reward.stars || 0;
  const coins = pool.reward.coins || 0;

  return (
    <View className="flex-1">
      {/* Streak / countdown row */}
      <View className="mt-4 flex-row items-center justify-between">
        <View
          className="flex-row items-center rounded-full px-3 py-1"
          style={{
            backgroundColor: isDarkMode ? "rgba(167,139,250,0.18)" : "#ede9fe",
            borderWidth: 1,
            borderColor: isDarkMode ? "rgba(167,139,250,0.32)" : "rgba(124,58,237,0.28)",
          }}
        >
          <BoltIcon size={12} color={isDarkMode ? "#c4b5fd" : "#6d28d9"} />
          <Text
            className="ml-1 font-pbold text-xs"
            style={{ color: isDarkMode ? "#c4b5fd" : "#6d28d9" }}
          >
            {streak}d
          </Text>
        </View>
        <Text className="font-pmedium text-xs" style={{ color: theme.textSoft }}>
          Resets at midnight
        </Text>
      </View>

      {/* Sub-tab bar */}
      <View
        className="mt-3 flex-row"
        style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}
      >
        <TabButton value="daily" label="Daily" />
        <TabButton value="weekly" label="Weekly" />
        <TabButton value="monthly" label="Monthly" />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* Pool reward header */}
        <View
          className="mt-4 rounded-2xl p-4"
          style={{
            backgroundColor: reachedThreshold && !claimed ? (isDarkMode ? "rgba(167,139,250,0.18)" : "#ede9fe") : (isDarkMode ? "rgba(167,139,250,0.10)" : "#faf5ff"),
            borderWidth: 1,
            borderColor: reachedThreshold && !claimed ? "rgba(167,139,250,0.45)" : "rgba(167,139,250,0.22)",
            opacity: claimed ? 0.55 : 1,
          }}
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="font-pbold text-base" style={{ color: theme.text }}>
                {TAB_TITLE[period]}
              </Text>
              <Text className="mt-0.5 font-pregular text-xs" style={{ color: theme.textSoft }}>
                Finish {pool.questsRequired} goals to earn
              </Text>
            </View>
            {/* Reward pill */}
            <View
              className="flex-row items-center rounded-full px-3 py-1.5"
              style={{
                backgroundColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 3 },
                shadowOpacity: 0.35,
                shadowRadius: 8,
                elevation: 4,
              }}
            >
              {stars > 0 && (
                <View className="flex-row items-center">
                  <Text className="font-pbold text-[12px]" style={{ color: "#fff" }}>{stars}</Text>
                  <View style={{ marginHorizontal: 3 }}><StarIcon size={12} /></View>
                  <Text className="font-pbold text-[12px]" style={{ color: "#fff" }}>
                    {stars === 1 ? "Star" : "Stars"}
                  </Text>
                </View>
              )}
              {stars > 0 && coins > 0 && (
                <Text className="mx-1.5 font-pbold text-[12px]" style={{ color: "rgba(255,255,255,0.7)" }}>·</Text>
              )}
              {coins > 0 && (
                <View className="flex-row items-center">
                  <Text className="font-pbold text-[12px]" style={{ color: "#fff" }}>{coins}</Text>
                  <View style={{ marginHorizontal: 3 }}><CoinIcon size={12} /></View>
                  <Text className="font-pbold text-[12px]" style={{ color: "#fff" }}>
                    {coins === 1 ? "Coin" : "Coins"}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* Claim button or progress */}
          <View className="mt-3">
            {claimed ? (
              <View className="items-center rounded-full py-2" style={{ backgroundColor: "rgba(74,222,128,0.10)", borderWidth: 1, borderColor: "rgba(74,222,128,0.22)" }}>
                <Text className="font-pbold text-xs" style={{ color: "#22c55e", letterSpacing: 0.5 }}>✓ CLAIMED</Text>
              </View>
            ) : reachedThreshold ? (
              <TouchableOpacity
                onPress={handleClaim}
                activeOpacity={0.85}
                className="items-center rounded-full py-2.5"
                style={{
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.45,
                  shadowRadius: 10,
                  elevation: 5,
                }}
              >
                <Text className="font-pbold text-sm" style={{ color: "#fff", letterSpacing: 1 }}>CLAIM REWARD</Text>
              </TouchableOpacity>
            ) : (
              <View
                className="items-center rounded-full py-2"
                style={{
                  backgroundColor: isDarkMode ? "rgba(167,139,250,0.08)" : "rgba(243,232,255,0.7)",
                  borderWidth: 1,
                  borderColor: "rgba(167,139,250,0.18)",
                }}
              >
                <Text className="font-pbold text-xs" style={{ color: theme.textSoft, letterSpacing: 1 }}>
                  {completedCount}/{pool.questsRequired} GOALS
                </Text>
                {/* Edge case: user has completed enough quests by count
                    but is missing a `required: true` quest. Without this
                    sub-line they'd see "9/9 GOALS" but no claim button
                    and have no idea why. */}
                {completedCount >= pool.questsRequired && !requiredQuestsDone ? (
                  <Text
                    className="mt-0.5 font-pmedium text-[10px]"
                    style={{ color: theme.textSoft, letterSpacing: 0.4 }}
                  >
                    Complete required goals to claim
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </View>

        {/* Quest rows */}
        {quests.map((q) => {
          const done = progress[q.id] || 0;
          const pct = Math.min(100, Math.round((done / q.target) * 100));
          const isComplete = done >= q.target;
          // A quest is "actionable" if tapping its row triggers a
          // user-driven flow (e.g. opening the Share sheet for
          // invite_friend). Non-actionable quests progress via their
          // organic surfaces (login on app open, read in book-reading,
          // etc.) and stay non-tappable so the user doesn't get the
          // affordance hint without a result.
          const isActionable =
            !isComplete &&
            (q.id === "invite_friend" || q.id === "w_invite_friend" || q.id === "m_invite_friend");
          // Use TouchableOpacity for actionable rows, plain View for
          // organic ones. Same visual style either way; the activeOpacity
          // gives a subtle press feedback that makes the affordance
          // discoverable without any extra UI clutter.
          const RowComponent = isActionable ? TouchableOpacity : View;
          const rowProps = isActionable
            ? { onPress: () => handleQuestTap(q), activeOpacity: 0.85 }
            : {};
          return (
            <RowComponent
              key={q.id}
              {...rowProps}
              className="mt-3 flex-row items-center rounded-2xl p-3"
              style={{
                backgroundColor: theme.card,
                borderWidth: 1,
                borderColor: isComplete ? "rgba(167,139,250,0.45)" : theme.border,
              }}
            >
              {/* Icon bubble */}
              <View
                className="h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  backgroundColor: isDarkMode ? "rgba(167,139,250,0.20)" : "#ede9fe",
                  borderWidth: 1,
                  borderColor: isDarkMode ? "rgba(167,139,250,0.18)" : "rgba(124,58,237,0.18)",
                }}
              >
                <QuestIcon name={q.icon} color={isDarkMode ? "#c4b5fd" : "#6d28d9"} size={18} />
              </View>

              {/* Body */}
              <View className="ml-3 flex-1">
                <View className="flex-row items-center">
                  <Text
                    className="flex-shrink font-psemibold text-sm"
                    style={{ color: theme.text }}
                    numberOfLines={1}
                  >
                    {q.label}
                  </Text>
                  {/* REQUIRED badge — flag for quests that must be
                      completed to unlock the pool reward, not just
                      counted toward the questsRequired threshold.
                      Today only `m_active30` carries this flag, but
                      the rendering is generic so future required
                      quests pick it up automatically. */}
                  {q.required && (
                    <View
                      className="ml-2 flex-row items-center rounded-full px-1.5 py-0.5"
                      style={{
                        backgroundColor: isComplete ? "rgba(74,222,128,0.18)" : "rgba(239,68,68,0.16)",
                        borderWidth: 1,
                        borderColor: isComplete ? "rgba(74,222,128,0.45)" : "rgba(239,68,68,0.40)",
                      }}
                    >
                      <Text
                        className="font-pbold text-[9px]"
                        style={{ color: isComplete ? "#16a34a" : "#dc2626", letterSpacing: 0.6 }}
                      >
                        REQUIRED
                      </Text>
                    </View>
                  )}
                  {q.bonus && (
                    <View
                      className="ml-2 flex-row items-center rounded-full px-1.5 py-0.5"
                      style={{
                        backgroundColor: theme.primary,
                      }}
                    >
                      <Text className="font-pbold text-[9px]" style={{ color: "#fff" }}>
                        +{q.bonus.coins}
                      </Text>
                      <View style={{ marginLeft: 2, marginRight: 2 }}>
                        <CoinIcon size={9} />
                      </View>
                      <Text className="font-pbold text-[9px]" style={{ color: "#fff", letterSpacing: 0.5 }}>
                        BONUS
                      </Text>
                    </View>
                  )}
                </View>
                <View className="mt-2 flex-row items-center">
                  <View
                    className="h-1.5 flex-1 overflow-hidden rounded-full"
                    style={{ backgroundColor: isDarkMode ? "rgba(167,139,250,0.12)" : "rgba(124,58,237,0.10)" }}
                  >
                    <View
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: theme.primary,
                      }}
                    />
                  </View>
                  <Text
                    className="ml-2 font-pmedium text-[11px]"
                    style={{ color: theme.textSoft, minWidth: 50, textAlign: "right" }}
                  >
                    {done}{q.unit}/{q.target}{q.unit}
                  </Text>
                </View>
              </View>
            </RowComponent>
          );
        })}
      </ScrollView>
    </View>
  );
};

export default GoalsTab;
