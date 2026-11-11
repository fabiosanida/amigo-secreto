ALTER TABLE as_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE as_users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE as_auth_challenges ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'legacy' CHECK (purpose IN ('legacy','signup','password_reset'));
ALTER TABLE as_auth_challenges ADD COLUMN IF NOT EXISTS password_hash text;
-- Old passwordless challenges must never bypass the new password requirement.
UPDATE as_auth_challenges SET used_at=now() WHERE used_at IS NULL AND purpose='legacy';
CREATE TABLE IF NOT EXISTS as_password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES as_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS as_password_resets_user ON as_password_resets(user_id);
