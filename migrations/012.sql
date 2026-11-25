UPDATE as_marmelada_tokens
SET used_at=NULL, failed_attempts=0, attempts_reset_at=NULL
WHERE used_at IS NOT NULL OR failed_attempts<>0 OR attempts_reset_at IS NOT NULL;
