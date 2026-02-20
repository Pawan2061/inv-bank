import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { bankTransactions, invoices, reconciliationMatches } from "@/db/schema";

type InvoiceRow = typeof invoices.$inferSelect;
type BankTransactionRow = typeof bankTransactions.$inferSelect;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
}

function normalizeRef(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function dayDiff(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.abs(Math.round((a.getTime() - b.getTime()) / msPerDay));
}

function vendorMatchScore(vendor: string, description: string): number {
  const vendorWords = normalize(vendor).split(/\s+/).filter((word) => word.length >= 3);
  const desc = normalize(description);
  const hits = vendorWords.filter((word) => desc.includes(word)).length;
  return Math.min(20, hits * 7);
}

function invoiceRefScore(invoiceNumber: string, description: string): number {
  return normalize(description).includes(normalize(invoiceNumber)) ? 10 : 0;
}

function hasExactReferenceMatch(invoice: InvoiceRow, transaction: BankTransactionRow): boolean {
  if (!transaction.invoiceReference) {
    return false;
  }
  return normalizeRef(transaction.invoiceReference) === normalizeRef(invoice.invoiceNumber);
}

function scoreMatch(invoice: InvoiceRow, transaction: BankTransactionRow): { score: number; reason: string } {
  const exactReferenceMatch = hasExactReferenceMatch(invoice, transaction);
  const descriptionReferenceScore = invoiceRefScore(invoice.invoiceNumber, transaction.description);

  if (invoice.amountCents !== transaction.amountCents) {
    return { score: 0, reason: "amount mismatch" };
  }

  const dateDistance = dayDiff(invoice.issueDate, transaction.transactionDate);
  if (dateDistance > 14) {
    return { score: 0, reason: "date too far apart" };
  }

  const dateScore = Math.max(2, 20 - dateDistance * 2);
  const vendorScore = vendorMatchScore(invoice.vendorName, transaction.description);
  const exactReferenceScore = exactReferenceMatch ? 55 : 0;
  const score = 35 + dateScore + vendorScore + descriptionReferenceScore + exactReferenceScore;

  return {
    score,
    reason: `amount exact, exact ref ${exactReferenceMatch ? "yes" : "no"}, date ${dateDistance}d apart, vendor signal ${vendorScore}, desc ref signal ${descriptionReferenceScore}`,
  };
}

export async function runReconciliation() {
  const [unmatchedInvoices, unmatchedTransactions] = await Promise.all([
    db.select().from(invoices).where(eq(invoices.status, "unmatched")).orderBy(invoices.issueDate),
    db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.status, "unmatched"))
      .orderBy(bankTransactions.transactionDate),
  ]);

  const takenTransactionIds = new Set<number>();
  const acceptedMatches: Array<{
    invoiceId: number;
    bankTransactionId: number;
    matchScore: number;
    reason: string;
  }> = [];

  for (const invoice of unmatchedInvoices) {
    let best: { transactionId: number; score: number; reason: string } | null = null;

    for (const transaction of unmatchedTransactions) {
      if (takenTransactionIds.has(transaction.id)) {
        continue;
      }
      const { score, reason } = scoreMatch(invoice, transaction);
      if (score < 75) {
        continue;
      }
      if (!best || score > best.score) {
        best = { transactionId: transaction.id, score, reason };
      }
    }

    if (best) {
      takenTransactionIds.add(best.transactionId);
      acceptedMatches.push({
        invoiceId: invoice.id,
        bankTransactionId: best.transactionId,
        matchScore: best.score,
        reason: best.reason,
      });
    }
  }

  if (acceptedMatches.length === 0) {
    const [invoiceCounts, transactionCounts, recentMatches] = await Promise.all([
      db.select().from(invoices).orderBy(desc(invoices.createdAt)),
      db.select().from(bankTransactions).orderBy(desc(bankTransactions.createdAt)),
      db.select().from(reconciliationMatches).orderBy(desc(reconciliationMatches.createdAt)).limit(10),
    ]);

    return {
      matchedCount: 0,
      invoices: invoiceCounts,
      transactions: transactionCounts,
      recentMatches,
    };
  }

  await db.transaction(async (tx) => {
    await tx.insert(reconciliationMatches).values(acceptedMatches);

    await tx
      .update(invoices)
      .set({
        status: "matched",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoices.status, "unmatched"),
          inArray(
            invoices.id,
            acceptedMatches.map((match) => match.invoiceId),
          ),
        ),
      );

    await tx
      .update(bankTransactions)
      .set({
        status: "matched",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.status, "unmatched"),
          inArray(
            bankTransactions.id,
            acceptedMatches.map((match) => match.bankTransactionId),
          ),
        ),
      );
  });

  const [invoiceRows, transactionRows, recentMatches] = await Promise.all([
    db.select().from(invoices).orderBy(desc(invoices.createdAt)),
    db.select().from(bankTransactions).orderBy(desc(bankTransactions.createdAt)),
    db.select().from(reconciliationMatches).orderBy(desc(reconciliationMatches.createdAt)).limit(10),
  ]);

  return {
    matchedCount: acceptedMatches.length,
    invoices: invoiceRows,
    transactions: transactionRows,
    recentMatches,
  };
}
