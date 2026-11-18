-- Suggestions belong to a participation, so each group has its own list.
-- A monotonic position provides stable pagination without a total item limit.
CREATE TABLE as_wishlist_items (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES as_memberships(id) ON DELETE CASCADE,
  position bigint GENERATED ALWAYS AS IDENTITY,
  text varchar(2000) NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 2000),
  url varchar(2048) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (url='' OR url ~ '^https?://')
);
CREATE INDEX as_wishlist_items_membership_position ON as_wishlist_items(membership_id,position);
