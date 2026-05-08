// lib/balance-recovery.js
//
// Thin client for the balance_recovery_requests system. Two server
// RPCs are exposed:
//   • submit_balance_recovery_request — user-facing, validates kind +
//     amount, returns { ok, id, status } or { ok: false, error,
//     existing_id? } if there's already an open request for the same
//     kind.
//   • (admin RPCs approve_/reject_ are not called from the mobile.)
//
// Reads the user's own request rows directly via the table (RLS
// scopes to the signed-in user) so the banner can show:
//   - "Report an issue" (no open request)
//   - "We're reviewing your report" (pending / needs_info)
//   - "Your balance has been restored" (approved, < 7 days old)
//   - "We couldn't verify this report" (rejected, < 7 days old)

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";

const requireUser = async () => {
  try {
    const cached = getMessagesUserId?.();
    if (cached) return { id: cached };
  } catch (_) {}
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user) return data.user;
  } catch (_) { /* no session */ }
  throw new Error("Not signed in");
};

// Submit a new recovery request.
// kind:    'coin' | 'star' | 'earnings' | 'account'
// amount:  positive integer (placeholder 1 is fine for 'account')
// reason:  optional free text describing the issue
// context: optional jsonb (app version, last-seen balance, etc.)
export const submitRecoveryRequest = async ({ kind, amount, reason, context } = {}) => {
  if (!["coin", "star", "earnings", "account"].includes(kind)) {
    throw new Error("Invalid kind");
  }
  // Account recovery doesn't need an amount; default to 1 placeholder.
  const reportedAmount = kind === "account" ? 1 : Number(amount);
  if (kind !== "account" && (!Number.isFinite(reportedAmount) || reportedAmount <= 0)) {
    throw new Error("Amount must be a positive number");
  }

  const me = await requireUser().catch(() => null);
  const { data, error } = await supabase.rpc("submit_balance_recovery_request", {
    p_kind: kind,
    p_reported_amount: Math.round(reportedAmount),
    p_reason: reason || null,
    p_context: context || {},
    p_actor_id: me?.id || null,
  });
  if (error) throw error;
  return data || { ok: false, error: "no_response" };
};

// Pulls every recovery request for the current user, newest first.
// Used by the banner to decide what state to show. RLS limits to
// own rows so no extra filter is needed.
export const getMyRecoveryRequests = async ({ limit = 10 } = {}) => {
  const me = await requireUser().catch(() => null);
  if (!me) return [];
  const { data, error } = await supabase
    .from("balance_recovery_requests")
    .select("id, kind, reported_amount, approved_amount, status, admin_notes, reviewed_at, created_at")
    .eq("user_id", me.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.log("[balance-recovery] getMyRecoveryRequests error:", error.message);
    return [];
  }
  return data || [];
};

// Helper: returns the most recent ACTIONABLE request for banner state.
// Rules:
//   • An open (pending / needs_info) request always wins.
//   • If none open, the most recent approved/rejected within 7 days
//     surfaces as a confirmation/rejection state.
//   • Older resolved requests are ignored (banner returns to default).
export const getActiveRecoveryRequest = async () => {
  const rows = await getMyRecoveryRequests({ limit: 5 });
  if (!rows.length) return null;
  const open = rows.find((r) => r.status === "pending" || r.status === "needs_info");
  if (open) return open;
  const recent = rows[0];
  const ageMs = Date.now() - new Date(recent.created_at).getTime();
  if (ageMs < 7 * 24 * 60 * 60 * 1000 && (recent.status === "approved" || recent.status === "rejected")) {
    return recent;
  }
  return null;
};
