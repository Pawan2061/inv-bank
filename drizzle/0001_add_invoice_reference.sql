ALTER TABLE bank_transactions
ADD COLUMN IF NOT EXISTS invoice_reference text;
