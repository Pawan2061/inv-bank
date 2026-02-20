import { desc, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bankTransactions, invoices, reconciliationMatches } from "@/db/schema";

export async function GET() {
  const [invoiceRows, transactionRows, matchRows, invoiceSummary, transactionSummary] = await Promise.all([
    db.select().from(invoices).orderBy(desc(invoices.createdAt)),
    db.select().from(bankTransactions).orderBy(desc(bankTransactions.createdAt)),
    db.select().from(reconciliationMatches).orderBy(desc(reconciliationMatches.createdAt)).limit(10),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${invoices.status} = 'matched')`,
      })
      .from(invoices),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${bankTransactions.status} = 'matched')`,
      })
      .from(bankTransactions),
  ]);

  return NextResponse.json({
    invoices: invoiceRows,
    transactions: transactionRows,
    recentMatches: matchRows,
    summary: {
      invoices: {
        total: Number(invoiceSummary[0]?.total ?? 0),
        matched: Number(invoiceSummary[0]?.matched ?? 0),
      },
      transactions: {
        total: Number(transactionSummary[0]?.total ?? 0),
        matched: Number(transactionSummary[0]?.matched ?? 0),
      },
    },
  });
}
