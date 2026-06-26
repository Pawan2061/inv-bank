import { and, desc, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  bankTransactions,
  invoices,
  reconciliationMatches,
  whatsappMessages,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";

const DEMO_INVOICE_NUMBERS = ["INV-1001", "INV-1002", "INV-1003", "INV-1004"] as const;

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const [
    invoiceRows,
    transactionRows,
    matchRows,
    whatsappRows,
    invoiceSummary,
    transactionSummary,
  ] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(not(inArray(invoices.invoiceNumber, [...DEMO_INVOICE_NUMBERS])))
      .orderBy(desc(invoices.createdAt)),
    db.select().from(bankTransactions).orderBy(desc(bankTransactions.createdAt)),
    db.select().from(reconciliationMatches).orderBy(desc(reconciliationMatches.createdAt)).limit(10),
    db.select().from(whatsappMessages).orderBy(desc(whatsappMessages.createdAt)).limit(50),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${invoices.status} = 'matched')`,
      })
      .from(invoices)
      .where(not(inArray(invoices.invoiceNumber, [...DEMO_INVOICE_NUMBERS]))),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${bankTransactions.status} = 'matched')`,
      })
      .from(bankTransactions)
      .where(
        or(
          isNull(bankTransactions.invoiceReference),
          and(
            not(inArray(bankTransactions.invoiceReference, [...DEMO_INVOICE_NUMBERS])),
            not(eq(bankTransactions.description, "Airport parking")),
          ),
        ),
      ),
  ]);

  const filteredTransactions = transactionRows.filter((row) => {
    if (row.description === "Airport parking") {
      return false;
    }
    if (!row.invoiceReference) {
      return true;
    }
    return !DEMO_INVOICE_NUMBERS.includes(row.invoiceReference as (typeof DEMO_INVOICE_NUMBERS)[number]);
  });

  return NextResponse.json({
    invoices: invoiceRows,
    transactions: filteredTransactions,
    recentMatches: matchRows,
    whatsappMessages: whatsappRows,
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
