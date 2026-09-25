-- Bonolini OS — fixed fare Sondrio city <-> Malpensa, italian customers
--
-- Data only: one new `category: 'pricing'` Business Rule with one effective
-- version, same pattern as 0022_pricing_business_rules.sql. No schema change.
--
-- Values decided by the founder on 2026-09-25 (production test, case B):
-- Sondrio city <-> Malpensa, both directions, italian customer (+39):
-- 250 EUR for 1-4 passengers, 350 EUR for 5-8. Above 8: manual price.
-- Foreign customers and other Valtellina towns: not covered by this rule.
-- Read by packages/core/src/pricing/rates-provider.ts
-- (pricingRuleKeys.sondrioMalpensaItalian).
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
    RAISE EXCEPTION 'Sondrio-Malpensa fare migration: no tenant found with slug ''bonolini-transfer''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM business_rules
    WHERE tenant_id = v_tenant_id AND key = 'pricing.fixed_fare.sondrio_malpensa_italian'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO business_rules (id, tenant_id, key, category)
  VALUES (gen_random_uuid(), v_tenant_id, 'pricing.fixed_fare.sondrio_malpensa_italian', 'pricing')
  RETURNING id INTO v_rule_id;

  INSERT INTO business_rule_versions (
    id, tenant_id, rule_id, version_number, status, content, author,
    owner_decision, owner_decision_reason, decided_at, effective_from
  )
  VALUES (
    gen_random_uuid(), v_tenant_id, v_rule_id, 1, 'effective',
    '{"upTo4PassengersCents": 25000, "from5To8PassengersCents": 35000}'::jsonb,
    'owner',
    'approved',
    'Founder decision 2026-09-25: Sondrio city <-> Malpensa, both directions, italian customers — 250 EUR (1-4 passengers), 350 EUR (5-8). Above 8 passengers: manual price.',
    now(), now()
  )
  RETURNING id INTO v_version_id;

  UPDATE business_rules SET current_version_id = v_version_id, updated_at = now() WHERE id = v_rule_id;
END $$;
