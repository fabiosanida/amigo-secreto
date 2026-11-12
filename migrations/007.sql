-- Dependents are represented by their guardian and never have credentials or email.
CREATE TABLE IF NOT EXISTS as_dependents (
  id uuid PRIMARY KEY,
  guardian_id uuid NOT NULL REFERENCES as_users(id),
  first_name text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS as_dependents_guardian ON as_dependents(guardian_id,created_at,id) WHERE deleted_at IS NULL;
ALTER TABLE as_memberships ADD COLUMN dependent_id uuid REFERENCES as_dependents(id);
ALTER TABLE as_memberships ALTER COLUMN email DROP NOT NULL;
ALTER TABLE as_memberships DROP CONSTRAINT as_memberships_check;
ALTER TABLE as_memberships ADD CONSTRAINT as_memberships_accepted_identity_check
  CHECK (status<>'accepted' OR user_id IS NOT NULL OR dependent_id IS NOT NULL);
ALTER TABLE as_memberships ADD CONSTRAINT as_memberships_identity_check CHECK (
  (dependent_id IS NULL AND email IS NOT NULL)
  OR (dependent_id IS NOT NULL AND user_id IS NULL AND email IS NULL AND status='accepted'
    AND invite_token_hash IS NULL AND invite_expires_at IS NULL AND tracking_token_hash IS NULL AND last_invited_at IS NULL)
);
ALTER TABLE as_memberships ADD CONSTRAINT as_memberships_group_dependent_key UNIQUE(group_id,dependent_id);
CREATE INDEX IF NOT EXISTS as_memberships_dependent ON as_memberships(dependent_id) WHERE dependent_id IS NOT NULL;
