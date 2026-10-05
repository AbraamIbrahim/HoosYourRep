export async function analyzePromisesFulfillment(rep, billTitles) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      member: {
        name: rep.name,
        chamber: rep.chamber,
        district: rep.district,
        party: rep.party,
      },
      promises: rep.promises,
      bills: billTitles,
    }),
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error ?? "Gemini analysis request failed");
  }

  const billsByIdentifier = new Map(
    billTitles.map((bill) => [
      `${String(bill.type).toUpperCase()} ${bill.number}`,
      bill,
    ]),
  );
  return {
    ...result,
    breakdown: result.breakdown.map((entry) => ({
      ...entry,
      correlatingBills: entry.correlatingBills
        .map((identifier) => billsByIdentifier.get(identifier))
        .filter(Boolean),
    })),
  };
}
