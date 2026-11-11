-- Keep anonymous draw identities without retaining access or personal data.
ALTER TABLE as_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
