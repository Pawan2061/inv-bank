import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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

export const customerMaster = pgTable(
  "customer_master",
  {
    id: serial("id").primaryKey(),
    customerCode: text("customer_code").notNull(),
    customerName: text("customer_name").notNull(),
    cityName: text("city_name"),
    billingState: text("billing_state"),
    billingPincode: text("billing_pincode"),
    source: text("source").notNull().default("manual"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    customerCodeUq: uniqueIndex("customer_master_customer_code_uq").on(table.customerCode),
    customerNameIdx: index("customer_master_customer_name_idx").on(table.customerName),
    cityNameIdx: index("customer_master_city_name_idx").on(table.cityName),
  }),
);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    customerId: integer("customer_id").references(() => customerMaster.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    usernameUq: uniqueIndex("users_username_uq").on(table.username),
    emailUq: uniqueIndex("users_email_uq").on(table.email),
  }),
);

export const customerPhoneNumbers = pgTable(
  "customer_phone_numbers",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customerMaster.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    label: text("label"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isWhatsappEnabled: boolean("is_whatsapp_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    phoneNumberUq: uniqueIndex("customer_phone_numbers_phone_number_uq").on(table.phoneNumber),
    customerIdIdx: index("customer_phone_numbers_customer_id_idx").on(table.customerId),
  }),
);

export const whatsappMessages = pgTable("whatsapp_messages", {
  id: serial("id").primaryKey(),
  messageId: text("message_id").notNull().unique(),
  fromNumber: text("from_number").notNull(),
  profileName: text("profile_name"),
  mediaId: text("media_id"),
  mediaMimeType: text("media_mime_type"),
  mediaSha256: text("media_sha256"),
  mediaUrl: text("media_url"),
  mediaS3Key: text("media_s3_key"),
  status: text("status").notNull().default("received"),
  responseText: text("response_text"),
  errorMessage: text("error_message"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
