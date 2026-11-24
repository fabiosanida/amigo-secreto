ALTER TABLE as_sessions ADD COLUMN password_verified_at timestamptz;

CREATE TABLE as_passkeys (
  id text NOT NULL,
  rp_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES as_users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 4294967295),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (rp_id, id)
);
CREATE INDEX as_passkeys_user_rp ON as_passkeys(user_id, rp_id);

CREATE TABLE as_passkey_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge text NOT NULL,
  binding_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX as_passkey_challenges_expiry ON as_passkey_challenges(expires_at);
