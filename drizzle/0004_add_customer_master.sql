CREATE TABLE IF NOT EXISTS customer_master (
  id serial PRIMARY KEY,
  customer_code text NOT NULL,
  customer_name text NOT NULL,
  city_name text,
  billing_state text,
  billing_pincode text,
  source text NOT NULL DEFAULT 'manual',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_master_customer_code_uq
  ON customer_master(customer_code);

CREATE INDEX IF NOT EXISTS customer_master_customer_name_idx
  ON customer_master(customer_name);

CREATE INDEX IF NOT EXISTS customer_master_city_name_idx
  ON customer_master(city_name);

CREATE TABLE IF NOT EXISTS customer_phone_numbers (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customer_master(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  is_whatsapp_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_phone_numbers_phone_number_uq
  ON customer_phone_numbers(phone_number);

CREATE INDEX IF NOT EXISTS customer_phone_numbers_customer_id_idx
  ON customer_phone_numbers(customer_id);

INSERT INTO customer_master (
  customer_code,
  customer_name,
  city_name,
  source
)
VALUES (
  'PAWANPANDEY1',
  'pawanpandey1',
  'Kathmandu',
  'seed'
)
ON CONFLICT (customer_code) DO UPDATE SET
  customer_name = EXCLUDED.customer_name,
  city_name = EXCLUDED.city_name,
  source = EXCLUDED.source,
  is_active = true,
  updated_at = now();

INSERT INTO customer_phone_numbers (
  customer_id,
  phone_number,
  label,
  is_primary,
  is_whatsapp_enabled
)
SELECT
  id,
  '919289037928',
  'Pawan Pandey India',
  true,
  true
FROM customer_master
WHERE customer_code = 'PAWANPANDEY1'
ON CONFLICT (phone_number) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  label = EXCLUDED.label,
  is_primary = EXCLUDED.is_primary,
  is_whatsapp_enabled = EXCLUDED.is_whatsapp_enabled,
  updated_at = now();

INSERT INTO customer_phone_numbers (
  customer_id,
  phone_number,
  label,
  is_primary,
  is_whatsapp_enabled
)
SELECT
  id,
  '9779825455112',
  'Pawan Pandey Nepal',
  false,
  true
FROM customer_master
WHERE customer_code = 'PAWANPANDEY1'
ON CONFLICT (phone_number) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  label = EXCLUDED.label,
  is_primary = EXCLUDED.is_primary,
  is_whatsapp_enabled = EXCLUDED.is_whatsapp_enabled,
  updated_at = now();
