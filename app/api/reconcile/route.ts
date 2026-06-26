import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { runReconciliation } from "@/lib/reconcile";

export async function POST() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const result = await runReconciliation();
  return NextResponse.json({
    message: `Reconciliation finished. Matched ${result.matchedCount} invoice(s).`,
    matchedCount: result.matchedCount,
    invoices: result.invoices,
    transactions: result.transactions,
    recentMatches: result.recentMatches,
  });
}
