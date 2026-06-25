ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_s3_key text;
