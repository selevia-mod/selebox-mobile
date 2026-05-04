// Pure-function fee preview for the withdrawal modal. Mirrors what the
// server's request_author_withdrawal RPC does (parallel deduction:
// fee = amount × (PLATFORM_COST + TRANSFER_FEE)) but adds a Pioneer-
// exemption short-circuit so the UI matches what the RPC will actually
// charge at submit time.
//
// The server is still the source of truth — this function is just the
// preview shown in the modal. If the user is Pioneer-exempt and within
// their 1-year window, fees collapse to zero and `totalReceive` equals
// the requested amount.
//
// PLATFORM_COST and TRANSFER_FEE are READ as-stored from globalSettings
// (Appwrite legacy bootstrap). They could be:
//   • fractions:    0.2 / 0.02   (matching new Supabase app_config)
//   • percentages:  20 / 2       (legacy mobile shape, divided by 100)
// We auto-detect by magnitude — anything > 1 is treated as percent and
// divided; anything ≤ 1 is treated as a fraction and used directly.
// This keeps the math correct during the gradual Appwrite → Supabase
// settings migration without forcing every operator to flip values in
// lockstep.

const DEFAULT_PIONEER_EXEMPTION_DAYS = 365;

// Returns true when the profile is currently Pioneer-exempt from fees.
// Conditions: role='pioneer' AND pioneer_at + exemption_days >= now().
// Treats missing data conservatively: if either field is absent, the
// user is NOT exempt (server enforces the same way).
export const isPioneerExempt = (profile, exemptionDays = DEFAULT_PIONEER_EXEMPTION_DAYS) => {
  if (!profile) return false;
  if (profile.role !== "pioneer") return false;
  if (!profile.pioneer_at) return false;
  const grantedAt = new Date(profile.pioneer_at).getTime();
  if (!Number.isFinite(grantedAt)) return false;
  const expiresAt = grantedAt + exemptionDays * 24 * 60 * 60 * 1000;
  return Date.now() <= expiresAt;
};

// Days remaining in the Pioneer exemption window (0 if expired or
// non-Pioneer). Used by the modal to render "X days of free withdrawals
// left" copy. Floors to whole days for display.
export const pioneerDaysRemaining = (profile, exemptionDays = DEFAULT_PIONEER_EXEMPTION_DAYS) => {
  if (!profile?.pioneer_at || profile.role !== "pioneer") return 0;
  const grantedAt = new Date(profile.pioneer_at).getTime();
  if (!Number.isFinite(grantedAt)) return 0;
  const expiresAt = grantedAt + exemptionDays * 24 * 60 * 60 * 1000;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
};

// Reads a fee value as a fraction. Accepts both legacy percentage form
// (e.g. 20 = "20%") and modern fraction form (e.g. 0.2 = "20%"). Returns
// the multiplier to apply directly to the amount.
const toFraction = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? n / 100 : n;
};

// `globalSettings` may be the Appwrite-bootstrapped dict; `profile` is
// the Supabase profile row { role, pioneer_at }. `exemptionDays` is
// optional — defaults to 365 unless the caller wants to mirror a
// non-default app_config.pioneer_exemption_days.
export const calculateAmountToReceive = (amount, globalSettings, profile, exemptionDays) => {
  const amountNum = parseFloat(amount) || 0;
  const exempt = isPioneerExempt(profile, exemptionDays);

  if (exempt) {
    return {
      amountNum,
      platformCost: 0,
      transferFee: 0,
      totalReceive: amountNum > 0 ? amountNum : 0,
      isPioneerExempt: true,
    };
  }

  const platformFraction = toFraction(globalSettings?.PLATFORM_COST);
  const transferFraction = toFraction(globalSettings?.TRANSFER_FEE);

  const platformCost = amountNum * platformFraction;
  const transferFee  = amountNum * transferFraction;
  const totalReceive = amountNum - platformCost - transferFee;

  return {
    amountNum,
    platformCost,
    transferFee,
    totalReceive: totalReceive > 0 ? totalReceive : 0,
    isPioneerExempt: false,
  };
};
