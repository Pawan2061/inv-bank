# Invoice + Bank Reconciliation POC

This is  Next.js proof-of-concept app that:
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
- `POST /api/reconcile`
  - runs invoice-to-bank matching and updates row status to `matched`.
- `GET /api/dashboard`
  - returns summary, all rows, and recent match decisions.
- `POST /api/upload/invoices`
  - imports invoice table rows from `.csv` or `.xlsx`,
  - supports both existing invoice schema headers and `data.xlsx` headers,
  - replaces existing invoice rows in DB.
- `POST /api/upload/transactions`
  - imports bank transaction rows from `.csv` or `.xlsx`.
  - replaces existing bank transaction rows in DB.
- `POST /api/upload/receipts`
  - accepts receipt images (`files` form-data, multiple allowed),
  - runs OCR/field extraction (OpenAI vision, with fallback invoice candidates for unclear images),
  - maps extracted values into `data.xlsx` column shape,
  - checks whether a corresponding bank transaction exists.

## Invoices File Format (.csv/.xlsx)
Supported header formats:

1) Standard schema:
```csv
invoice_number,vendor_name,issue_date,due_date,amount,currency
INV-2001,Acme Corp,2026-02-01,2026-02-10,250.00,USD
```

2) `data.xlsx` style:
```csv
Invoice No,Invoice Date,Parcel Dtls,Customer Code,Customer Name,Shipping Name,City,Courier Name,Header Remark,Remarks
1252684084,46107,240864(),1359,GOOD HOMES FURNITURE (DAVANAGERE),GOOD HOMES FURNITURE (Davanagere),DAVANAGERE,SRE CARGO CARRIERS,1r,YES
```

## Transactions File Format (.csv/.xlsx)
Upload bank transactions with headers:

```csv
transaction_date,description,invoice_number,amount,currency
2026-02-02,ACH ACME CORP INV-2001,INV-2001,250.00,USD
```

Notes:
- Date format must be `YYYY-MM-DD`.
- `amount` is parsed as dollars and converted to cents.
- `currency` is optional and defaults to `USD`.
- `invoice_number` on transactions file is optional but strongly recommended for high-confidence matching.

## Receipt Image Mapping (Admin)
For transport receipts like SRE/PSR slips, use the UI section:
- `Import Receipt Images (Admin)` and click `Map Receipt Fields`.
- Receipt verification is performed against invoices already uploaded to DB.

The API returns rows with this column order:
- `Invoice No`
- `Invoice Date` (Excel serial date)
- `Parcel Dtls`
- `Customer Code`
- `Customer Name`
- `Shipping Name`
- `City`
- `Courier Name`
- `Header Remark`
- `Remarks`

Environment:
- `OPENAI_API_KEY` is required for OCR extraction.
- `OPENAI_MODEL` is optional (default: `gpt-4.1-mini`).
- Receipt images are uploaded to S3 before returning/storing match history.
  - Default bucket: `ddecor-blinds`
  - Default region: `ap-south-1`
  - The app uses the standard AWS SDK credential chain, so an AWS profile, runtime IAM role, or env credentials can provide access.
  - Optional overrides: `S3_BUCKET_ARN`, `S3_BUCKET_NAME`, `AWS_REGION`.
  - Env credentials may use the standard `AWS_ACCESS_KEY_ID` name or the supported `AWS_ACCESS_KEY` alias, plus `AWS_SECRET_ACCESS_KEY`.
- Customer notifications use approved WhatsApp templates.
  - `WA_MATCH_TEMPLATE_NAME` enables matched-invoice customer notifications.
  - `WA_MATCH_TEMPLATE_LANGUAGE` defaults to `en_US`.
  - Body variables are sent as: customer name, invoice number, invoice date, amount.

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
