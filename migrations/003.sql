-- Historic rows are preserved; refuse the migration if an incompatible value
-- appears after the preflight check instead of silently changing user data.
ALTER TABLE as_groups ADD CONSTRAINT as_groups_budget_minimum CHECK (budget >= 1);
