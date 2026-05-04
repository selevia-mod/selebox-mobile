import { useCallback, useEffect, useState } from "react";
import { fetchUserEarnings as fetchUserEarningsAppwrite } from "../lib/earningsService";
import { USE_SUPABASE_WALLET } from "../lib/feature-flags";
import { getUserWithdrawals, requestWithdrawal } from "../lib/withdrawalsService";
// Phase F.8 — Supabase author earnings + withdrawals. Same legacy shape
// returned so consumers don't need to refactor; the adapter inside
// earnings-supabase.js does the conversion.
import { fetchUserEarnings as fetchUserEarningsSupabase, getAuthorWithdrawals, requestAuthorWithdrawal } from "../lib/earnings-supabase";

export function useEarnings(userId, selectedMonth) {
  const [earnings, setEarnings] = useState({ total: 0, breakdown: {}, totalEarningsThisMonth: 0 });
  const [withdrawals, setWithdrawals] = useState([]);
  const [remainingBalance, setRemainingBalance] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (!selectedMonth || !userId) return;

    setLoading(true);
    try {
      // Phase F.8 — Branch reads on the wallet flag. The Supabase
      // earnings adapter returns the same legacy shape, but the
      // withdrawal rows have different field names — we adapt the
      // status / amount fields below before computing remainingBalance.
      const [earningsData, withdrawalsData] = await Promise.all([
        USE_SUPABASE_WALLET ? fetchUserEarningsSupabase(userId, selectedMonth) : fetchUserEarningsAppwrite(userId, selectedMonth),
        USE_SUPABASE_WALLET ? getAuthorWithdrawals({ limit: 50 }) : getUserWithdrawals(userId),
      ]);

      setEarnings(earningsData);
      setWithdrawals(withdrawalsData);

      // compute remaining balance (only approved/paid withdrawals count
      // against the lifetime earnings total). Supabase rows use
      // amount_php_minor (cents) under different statuses; legacy uses
      // `amount` in pesos under "approved".
      const approvedWithdrawals = USE_SUPABASE_WALLET
        ? withdrawalsData
            .filter((w) => w.status === "approved" || w.status === "paid")
            .reduce((sum, w) => sum + (Number(w.amount_php_minor) || 0) / 100, 0)
        : withdrawalsData.filter((w) => w.status === "approved").reduce((sum, w) => sum + (Number(w.amount) || 0), 0);

      setRemainingBalance(earningsData.total - approvedWithdrawals);
    } catch (err) {
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Withdraw — branches on flag. Supabase path takes `amountPhpMinor`
  // (centavos) as of the May 2026 earnings overhaul: the RPC computes
  // server-side fees (Pioneer-aware) and earmarks across both coin and
  // star earnings FIFO. Legacy Appwrite path still uses peso `amount`
  // because the legacy collection-based withdrawal predates the unified
  // peso ledger.
  const withdraw = async ({ amount, amountToReceive, amountPhpMinor, payoutMethod, payoutDetails } = {}) => {
    if (!userId) return null;
    try {
      if (USE_SUPABASE_WALLET) {
        if (!Number.isFinite(amountPhpMinor) || amountPhpMinor <= 0) {
          throw new Error("amountPhpMinor required for Supabase withdrawal");
        }
        const result = await requestAuthorWithdrawal({ amountPhpMinor, payoutMethod, payoutDetails });
        await fetchData();
        return result;
      }
      if (!amount || amount <= 0) return null;
      await requestWithdrawal(userId, amount, amountToReceive);
      await fetchData();
      return { ok: true };
    } catch (err) {
      throw err;
    }
  };

  // Legacy + Supabase use different timestamp field names. Cover both.
  const sortKey = (w) => new Date(w?.requested_at || w?.$createdAt || 0).getTime();
  const rawLatest = [...withdrawals].sort((a, b) => sortKey(b) - sortKey(a))[0] || null;

  // Adapt the row shape so consumers can render uniformly. Legacy
  // (Appwrite) rows already carry `amount` + `amountToReceive` in
  // pesos. Supabase rows carry `amount_php_minor` / `net_php_minor`
  // in centavos. Without normalizing, the Earnings screen crashes on
  // `latestWithdrawal.amountToReceive.toFixed(2)` because the field
  // is undefined on Supabase rows.
  const latestWithdrawal = rawLatest
    ? {
        ...rawLatest,
        amount: rawLatest.amount ?? (Number(rawLatest.amount_php_minor) || 0) / 100,
        amountToReceive:
          rawLatest.amountToReceive ?? (Number(rawLatest.net_php_minor) || 0) / 100,
      }
    : null;

  return {
    earnings,
    withdrawals,
    remainingBalance,
    latestWithdrawal,
    loading,
    withdraw,
    refresh: fetchData,
  };
}
