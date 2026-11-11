CREATE TABLE IF NOT EXISTS as_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  first_name text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 120),
  avatar text CHECK (octet_length(avatar) <= 350000),
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS as_auth_challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  user_id uuid REFERENCES as_users(id) ON DELETE CASCADE,
  first_name text,
  last_name text,
  avatar text,
  invite_token_cipher text,
  code_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS as_challenges_email_created ON as_auth_challenges(email, created_at DESC);
CREATE INDEX IF NOT EXISTS as_challenges_expiry ON as_auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS as_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES as_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS as_sessions_expiry ON as_sessions(expires_at);
CREATE TABLE IF NOT EXISTS as_rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 1,
  reset_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS as_groups (
  id uuid PRIMARY KEY,
  organizer_id uuid NOT NULL REFERENCES as_users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  event_date date NOT NULL,
  budget numeric(10,2) NOT NULL CHECK (budget >= 0 AND budget <= 100000),
  location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  drawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS as_groups_organizer ON as_groups(organizer_id);
CREATE TABLE IF NOT EXISTS as_memberships (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES as_groups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES as_users(id),
  email text NOT NULL CHECK (email = lower(email)),
  invited_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','opened','accepted','failed')),
  invite_token_hash text UNIQUE,
  invite_expires_at timestamptz,
  tracking_token_hash text UNIQUE,
  accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  last_invited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_id,email),
  UNIQUE(group_id,user_id),
  UNIQUE(group_id,id),
  CHECK (status <> 'accepted' OR user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS as_memberships_user ON as_memberships(user_id,group_id);
CREATE INDEX IF NOT EXISTS as_memberships_group_status ON as_memberships(group_id,status);

CREATE TABLE IF NOT EXISTS as_draw_results (
  group_id uuid NOT NULL REFERENCES as_groups(id),
  giver_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,giver_id),
  UNIQUE(group_id,receiver_id),
  FOREIGN KEY(group_id,giver_id) REFERENCES as_memberships(group_id,id),
  FOREIGN KEY(group_id,receiver_id) REFERENCES as_memberships(group_id,id),
  CHECK (giver_id <> receiver_id)
);

CREATE TABLE IF NOT EXISTS as_outbox (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES as_groups(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES as_memberships(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invite','result')),
  dedupe_key text NOT NULL UNIQUE,
  delivery_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  provider_id text,
  provider_message_id text,
  provider_status text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS as_outbox_due ON as_outbox(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS as_outbox_group ON as_outbox(group_id,state);
