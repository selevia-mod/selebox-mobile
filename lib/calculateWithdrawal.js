export const calculateAmountToReceive = (amount, globalSettings) => {
  const amountNum = parseFloat(amount) || 0;
  const PLATFORM_COST = globalSettings["PLATFORM_COST"];
  const TRANSFER_FEE = globalSettings["TRANSFER_FEE"];

  const platformCost = amountNum * (PLATFORM_COST / 100);
  const transferFee = amountNum * (TRANSFER_FEE / 100);
  const totalReceive = amountNum - platformCost - transferFee;

  return {
    amountNum,
    platformCost,
    transferFee,
    totalReceive: totalReceive > 0 ? totalReceive : 0,
  };
};
