ALTER TABLE as_marmelada_tokens
  ADD COLUMN token_ciphertext text,
  ADD COLUMN attempts_reset_at timestamptz,
  ADD CONSTRAINT as_marmelada_fixed_token_no_expiry
    CHECK (token_ciphertext IS NULL OR expires_at='infinity'::timestamptz);
