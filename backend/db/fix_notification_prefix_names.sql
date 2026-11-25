BEGIN;

-- Prospects: rebuild the full name without the "(n)" / "(n+)" prefix, then split
-- again on the first space. last_name is NOT NULL, so a one-word name gets ''.
WITH fixed AS (
  SELECT id,
         TRIM(regexp_replace(TRIM(first_name || ' ' || last_name), '^\(\d+\+?\)\s*', '')) AS full_name
    FROM prospects
   WHERE org_id = 111
     AND TRIM(first_name || ' ' || last_name) ~ '^\(\d+\+?\)'
)
UPDATE prospects p
   SET first_name = split_part(f.full_name, ' ', 1),
       last_name  = TRIM(substr(f.full_name, length(split_part(f.full_name, ' ', 1)) + 1)),
       updated_at = CURRENT_TIMESTAMP
  FROM fixed f
 WHERE p.id = f.id
RETURNING p.id, p.first_name, p.last_name;

-- Saved LinkedIn profiles
UPDATE linkedin_profiles
   SET full_name = TRIM(regexp_replace(full_name, '^\s*\(\d+\+?\)\s*', '')),
       updated_at = NOW()
 WHERE org_id = 111 AND full_name ~ '^\s*\(\d+\+?\)'
RETURNING id, linkedin_slug, full_name;

COMMIT;
