CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  invoice_number text NOT NULL UNIQUE,
  vendor_name text NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'unmatched',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id serial PRIMARY KEY,
  transaction_date date NOT NULL,
  description text NOT NULL,
  invoice_reference text,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'unmatched',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_matches (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  bank_transaction_id integer NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  match_score integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
