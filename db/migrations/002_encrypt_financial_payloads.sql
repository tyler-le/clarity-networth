ALTER TABLE financial_stores ADD COLUMN IF NOT EXISTS payload_enc text;

ALTER TABLE financial_stores
  ADD CONSTRAINT financial_stores_payload_enc_format
  CHECK (payload_enc IS NULL OR payload_enc LIKE 'v1.%');
