-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_83_whatsapp_account_unique_ids.sql
--
-- Defensive uniqueness on org_whatsapp_accounts identifiers.
--
-- WHY: inbound webhooks are attributed to an org by phone_number_id, and
-- template-status webhooks by waba_id:
--     SELECT org_id FROM org_whatsapp_accounts WHERE phone_number_id = $1 ...
-- The table is keyed by org_id (one WABA per org), but nothing stopped the SAME
-- Meta phone_number_id / waba_id from appearing under two orgs. Meta ids are
-- globally unique in practice, so routing works today — but if a number were
-- ever re-onboarded to a different org without the old row being revoked, the
-- webhook lookup would pick a row arbitrarily and mis-attribute a customer's
-- messages. These indexes make that impossible at the database level.
--
-- Additive and idempotent. Applying it is a no-op unless a genuine duplicate
-- already exists (in which case CREATE UNIQUE INDEX will fail loudly — that is
-- the correct outcome: the duplicate must be resolved before it can bite).
--
-- NUMBERING: prior is 82. This is 83.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- One active/known WABA phone number may map to exactly one org. We index the
-- raw column (not partitioned by status) because even a 'suspended'/'revoked'
-- row for a number must not coexist with an 'active' one on another org — the
-- webhook filters status in its query, but the identifier itself must stay
-- unambiguous across the whole table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_whatsapp_accounts_phone_number_id
  ON public.org_whatsapp_accounts (phone_number_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_whatsapp_accounts_waba_id
  ON public.org_whatsapp_accounts (waba_id);

COMMENT ON INDEX public.uq_org_whatsapp_accounts_phone_number_id IS
  'Guarantees webhook attribution by phone_number_id is unambiguous — a Meta number belongs to at most one org.';
COMMENT ON INDEX public.uq_org_whatsapp_accounts_waba_id IS
  'Guarantees template-status webhook attribution by waba_id is unambiguous — a WABA belongs to at most one org.';

COMMIT;
