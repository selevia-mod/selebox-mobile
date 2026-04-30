import { useCallback, useEffect, useState } from "react";
import { fetchUserEarnings } from "../lib/earningsService";
import { getUserWithdrawals, requestWithdrawal } from "../lib/withdrawalsService";

export function useEarnings(userId, selectedMonth) {
  const [earnings, setEarnings] = useState({ total: 0, breakdown: {}, totalEarningsThisMonth: 0 });
  const [withdrawals, setWithdrawals] = useState([]);
  const [remainingBalance, setRemainingBalance] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (!selectedMonth || !userId) return;

    setLoading(true);
    try {
      const [earningsData, withdrawalsData] = await Promise.all([
        fetchUserEarnings(userId, selectedMonth),
        getUserWithdrawals(userId),
      ]);

      setEarnings(earningsData);
      setWithdrawals(withdrawalsData);

      // compute remaining balance (only approved withdrawals count)
      const approvedWithdrawals = withdrawalsData.filter((w) => w.status === "approved").reduce((sum, w) => sum + (w.amount || 0), 0);

      setRemainingBalance(earningsData.total - approvedWithdrawals);
    } catch (err) {
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const withdraw = async ({ amount, amountToReceive }) => {
    if (!userId || amount <= 0) return null;
    try {
      await requestWithdrawal(userId, amount, amountToReceive);
      await fetchData();
    } catch (err) {
      throw err;
    }
  };

  const latestWithdrawal = [...withdrawals].sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt))[0] || null;

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
