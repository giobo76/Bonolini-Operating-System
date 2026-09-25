-- Bonolini OS — minimum duration of the booking event in Google Calendar
--
-- Data only: one new `category: 'other'` Business Rule with one effective
-- version, same pattern as 0029_sondrio_malpensa_fixed_fare.sql. No schema
-- change.
--
-- Decided by the founder on 2026-09-25: the calendar event of a confirmed
-- booking lasts the whole time he is busy (Sondrio -> pickup -> destination
-- -> Sondrio, from Google Maps); for routes with Malpensa, in either
-- direction, never less than 5 hours. Minimums for other routes are added
-- as a new version of this rule, not in code.
-- Read by packages/core/src/calendar/booking-event.ts
-- (MINIMUM_EVENT_DURATION_RULE_KEY).
--
-- Idempotent: skips the key if it already exists for the tenant.

DO $$
DECLARE
  v_tenant_id uuid;
  v_rule_id uuid;
  v_version_id uuid;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'bonolini-transfer';

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Calendar minimum duration migration: no tenant found with slug ''bonolini-transfer''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM business_rules
    WHERE tenant_id = v_tenant_id AND key = 'calendar.minimum_event_duration'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO business_rules (id, tenant_id, key, category)
  VALUES (gen_random_uuid(), v_tenant_id, 'calendar.minimum_event_duration', 'other')
  RETURNING id INTO v_rule_id;

  INSERT INTO business_rule_versions (
    id, tenant_id, rule_id, version_number, status, content, author,
    owner_decision, owner_decision_reason, decided_at, effective_from
  )
  VALUES (
    gen_random_uuid(), v_tenant_id, v_rule_id, 1, 'effective',
    '{"minimums": [{"label": "Malpensa", "placeKeywords": ["malpensa", "mxp"], "minimumMinutes": 300}]}'::jsonb,
    'owner',
    'approved',
    'decisione del titolare 2026-09-25',
    now(), now()
  )
  RETURNING id INTO v_version_id;

  UPDATE business_rules SET current_version_id = v_version_id, updated_at = now() WHERE id = v_rule_id;
END $$;
