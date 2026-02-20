import { NextResponse } from "next/server";
import { runReconciliation } from "@/lib/reconcile";

export async function POST() {
  const result = await runReconciliation();
  return NextResponse.json({
    message: `Reconciliation finished. Matched ${result.matchedCount} invoice(s).`,
    matchedCount: result.matchedCount,
    invoices: result.invoices,
    transactions: result.transactions,
    recentMatches: result.recentMatches,
  });
}
