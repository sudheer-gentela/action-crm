-- ============================================================================
-- clean_user15_org111_prospecting_config.sql
--
-- Removes the DataOps pollution from the executing user's prospecting_config
-- (user_id=15, org_id=111). This is the data fix for the "nothing changed"
-- drafts on the VP Dogfood campaign: the user layer is ADDITIVE on top of the
-- campaign override, so these leaked into an otherwise-clean campaign.
--
-- For the self-serve VP Dogfood case there is no client-owned sender, so the
-- Piece 5 clientRun guard does NOT suppress these additions — cleaning the
-- data is the actual fix.
--
-- JSON path verified against SkillContextService.buildProspectSkillContext:
--   SELECT preferences FROM user_preferences WHERE user_id=$1 AND org_id=$2
--   -> preferences.prospecting_config.custom_value_props   (six DataOps strings)
--   -> preferences.prospecting_config.rep                  ({title_for_signature, email_signature_block})
--
-- RUN STEP 1 FIRST (read-only). Only run STEP 2 after you've confirmed STEP 1
-- shows the expected pollution. STEP 2 is wrapped in a transaction with a
-- verification SELECT before you commit.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 1 — DRY RUN (read-only). Inspect what is currently stored.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
  user_id,
  org_id,
  preferences #> '{prospecting_config,custom_value_props}' AS custom_value_props,
  preferences #> '{prospecting_config,rep}'                AS rep,
  jsonb_array_length(
    COALESCE(preferences #> '{prospecting_config,custom_value_props}', '[]'::jsonb)
  ) AS custom_value_props_count
FROM user_preferences
WHERE user_id = 15 AND org_id = 111;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 2 — CLEAN (transactional). Empties custom_value_props and removes the
-- polluted user-layer rep so it can never leak into a campaign draft again.
--
-- Default behaviour: REMOVE the rep key entirely. With a campaign sender
-- configured (rep_source: campaign_sender), the user-layer rep is ignored on
-- the draft path anyway; removing it also fixes any non-campaign path that
-- would otherwise fall back to "Srujana / DataOps Manager".
--
-- Review the BEGIN block, run it, check the verification SELECT, then COMMIT
-- (or ROLLBACK to abort).
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;

UPDATE user_preferences
SET preferences = jsonb_set(
      preferences #- '{prospecting_config,rep}',          -- drop polluted rep
      '{prospecting_config,custom_value_props}',
      '[]'::jsonb,                                         -- empty the DataOps props
      false                                               -- do not create if absent
    )
WHERE user_id = 15 AND org_id = 111;

-- Verify the result inside the open transaction BEFORE committing:
SELECT
  user_id,
  org_id,
  preferences #> '{prospecting_config,custom_value_props}' AS custom_value_props_after,
  preferences #> '{prospecting_config,rep}'                AS rep_after
FROM user_preferences
WHERE user_id = 15 AND org_id = 111;

-- If the SELECT above shows custom_value_props_after = [] and rep_after = NULL:
--   COMMIT;
-- Otherwise:
--   ROLLBACK;


-- ─────────────────────────────────────────────────────────────────────────
-- OPTIONAL — instead of removing the rep, set it to Sudheer's correct values.
-- Use this in place of the `#- '{prospecting_config,rep}'` deletion above if a
-- user-layer rep should remain for non-campaign sends. Edit the values, then
-- run inside the same BEGIN/verify/COMMIT pattern.
-- ─────────────────────────────────────────────────────────────────────────
-- UPDATE user_preferences
-- SET preferences = jsonb_set(
--       jsonb_set(
--         preferences,
--         '{prospecting_config,custom_value_props}', '[]'::jsonb, false
--       ),
--       '{prospecting_config,rep}',
--       jsonb_build_object(
--         'title_for_signature',  'Founder & CEO',
--         'email_signature_block', 'Sudheer'
--       ),
--       true
--     )
-- WHERE user_id = 15 AND org_id = 111;
