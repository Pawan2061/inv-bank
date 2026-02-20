# Invoice + Bank Reconciliation POC

This is a Next.js proof-of-concept app that:
- stores invoices and bank statement rows in PostgreSQL,
- uses Drizzle ORM for schema + queries,
- runs a deterministic matching workflow,
- persists match decisions and updates statuses.

## Stack
- Next.js App Router
- PostgreSQL
- Drizzle ORM + Drizzle Kit
- TypeScript

## 1) Configure Environment
Copy `.env.example` to `.env.local` and set your database URL.

```bash
cp .env.example .env.local
```

## 2) Install Dependencies

```bash
pnpm install
```

## 3) Generate/Migrate Database

```bash
pnpm db:generate
pnpm db:migrate
```

## 4) Run the App

```bash
pnpm dev
```

Open `http://localhost:3000`.

## API Endpoints
- `POST /api/seed`
  - clears and seeds demo invoices + bank transactions.
- `POST /api/reconcile`
  - runs invoice-to-bank matching and updates row status to `matched`.
- `GET /api/dashboard`
  - returns summary, all rows, and recent match decisions.
- `POST /api/upload/invoices`
  - imports invoice CSV rows.
- `POST /api/upload/transactions`
  - imports bank transaction CSV rows.

## CSV Format
Upload invoice CSV with headers:

```csv
invoice_number,vendor_name,issue_date,due_date,amount,currency
INV-2001,Acme Corp,2026-02-01,2026-02-10,250.00,USD
```

Upload bank transaction CSV with headers:

```csv
transaction_date,description,invoice_number,amount,currency
2026-02-02,ACH ACME CORP INV-2001,INV-2001,250.00,USD
```

Notes:
- Date format must be `YYYY-MM-DD`.
- `amount` is parsed as dollars and converted to cents.
- `currency` is optional and defaults to `USD`.
- `invoice_number` on transaction CSV is optional but strongly recommended for high-confidence matching.

## Matching Logic (POC)
An invoice and transaction match when:
- amount matches exactly,
- transaction date is within 14 days of invoice issue date,
- exact `invoice_reference` (`invoice_number`) match on transaction gives the highest score boost,
- plus optional score boosts for vendor token overlap and invoice reference in bank description.

Matches are persisted in `reconciliation_matches`; source rows are updated to status `matched`.

## Notes
- This is intentionally simple and deterministic for demonstration.
- Production reconciliation should include confidence thresholds, approval queues, and audit/versioning details.
