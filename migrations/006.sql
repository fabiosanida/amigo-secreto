-- Dashboard invitations are fetched by the signed-in email, newest first.
-- Accepted/revoked invitations stay outside this small covering index.
CREATE INDEX IF NOT EXISTS as_memberships_pending_email
  ON as_memberships(email,created_at DESC,id DESC)
  INCLUDE(group_id,user_id,invite_expires_at)
  WHERE status<>'accepted' AND invite_token_hash IS NOT NULL;
