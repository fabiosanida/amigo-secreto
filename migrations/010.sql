CREATE TABLE as_marmelada_tokens (
  group_id uuid NOT NULL,
  giver_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  PRIMARY KEY (group_id, giver_id),
  FOREIGN KEY (group_id, giver_id) REFERENCES as_draw_results(group_id, giver_id) ON DELETE CASCADE
);
