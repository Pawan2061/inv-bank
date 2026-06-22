import { date, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  vendorName: text("vendor_name").notNull(),
  issueDate: date("issue_date").notNull(),
  dueDate: date("due_date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("unmatched"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const bankTransactions = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  transactionDate: date("transaction_date").notNull(),
  description: text("description").notNull(),
  invoiceReference: text("invoice_reference"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("unmatched"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const reconciliationMatches = pgTable("reconciliation_matches", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  bankTransactionId: integer("bank_transaction_id")
    .notNull()
    .references(() => bankTransactions.id, { onDelete: "cascade" }),
  matchScore: integer("match_score").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const whatsappMessages = pgTable("whatsapp_messages", {
  id: serial("id").primaryKey(),
  messageId: text("message_id").notNull().unique(),
  fromNumber: text("from_number").notNull(),
  profileName: text("profile_name"),
  mediaId: text("media_id"),
  mediaMimeType: text("media_mime_type"),
  mediaSha256: text("media_sha256"),
  status: text("status").notNull().default("received"),
  responseText: text("response_text"),
  errorMessage: text("error_message"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
