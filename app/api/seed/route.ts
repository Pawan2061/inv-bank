import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bankTransactions, invoices, reconciliationMatches } from "@/db/schema";

const demoInvoices: Array<typeof invoices.$inferInsert> = [
  {
    invoiceNumber: "INV-1001",
    vendorName: "Acme Supplies Inc",
    issueDate: "2026-02-01",
    dueDate: "2026-02-15",
    amountCents: 25000,
    currency: "USD",
  },
  {
    invoiceNumber: "INV-1002",
    vendorName: "Nimbus Consulting",
    issueDate: "2026-02-03",
    dueDate: "2026-02-18",
    amountCents: 78500,
    currency: "USD",
  },
  {
    invoiceNumber: "INV-1003",
    vendorName: "Northwind Services",
    issueDate: "2026-02-05",
    dueDate: "2026-02-20",
    amountCents: 41250,
    currency: "USD",
  },
  {
    invoiceNumber: "INV-1004",
    vendorName: "Delta Office Labs",
    issueDate: "2026-02-09",
    dueDate: "2026-02-24",
    amountCents: 15999,
    currency: "USD",
  },
];

const demoTransactions: Array<typeof bankTransactions.$inferInsert> = [
  {
    transactionDate: "2026-02-02",
    description: "ACH ACME SUPPLIES INV-1001",
    invoiceReference: "INV-1001",
    amountCents: 25000,
    currency: "USD",
  },
  {
    transactionDate: "2026-02-04",
    description: "Wire payment NIMBUS CONSULTING Ref INV-1002",
    invoiceReference: "INV-1002",
    amountCents: 78500,
    currency: "USD",
  },
  {
    transactionDate: "2026-02-06",
    description: "Northwind svc monthly charge",
    invoiceReference: "INV-1003",
    amountCents: 41250,
    currency: "USD",
  },
  {
    transactionDate: "2026-02-14",
    description: "Airport parking",
    amountCents: 4800,
    currency: "USD",
  },
];

export async function POST() {
  await db.transaction(async (tx) => {
    await tx.delete(reconciliationMatches);
    await tx.delete(invoices);
    await tx.delete(bankTransactions);
    await tx.insert(invoices).values(demoInvoices);
    await tx.insert(bankTransactions).values(demoTransactions);
  });

  const [invoiceRows, transactionRows] = await Promise.all([
    db.select().from(invoices),
    db.select().from(bankTransactions),
  ]);

  return NextResponse.json({
    message: "Seeded sample invoices and bank transactions.",
    invoiceCount: invoiceRows.length,
    transactionCount: transactionRows.length,
  });
}
