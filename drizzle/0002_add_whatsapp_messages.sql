CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id serial PRIMARY KEY,
  message_id text NOT NULL UNIQUE,
  from_number text NOT NULL,
  profile_name text,
  media_id text,
  media_mime_type text,
  media_sha256 text,
  status text NOT NULL DEFAULT 'received',
  response_text text,
  error_message text,
  result jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
