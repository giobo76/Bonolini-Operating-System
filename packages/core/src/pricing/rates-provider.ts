import { getBusinessRuleByKey } from "../business-rules";
import { log, captureException } from "../observability";
import {
  pricingRuleKeys,
  minimumFareRuleContentSchema,
  tollRateRuleContentSchema,
  distanceRateRuleContentSchema,
  fixedFareAirportRuleContentSchema,
  foreignFixedTiranoRuleContentSchema,
  hospitalWaitingItalianRuleContentSchema,
  DEFAULT_PRICING_RATES,
  type PricingRates,
} from "./schema";
import type { ZodType } from "zod";

// Phase 2 (Business Rules) — the one deliberate exception to pricing's own
// "no database access at all" rule (see README.md's "Owns" line): this
// file's only job is to turn the six `category: "pricing"` Business Rules
// (Phase 1's business-rules module) into the plain `PricingRates` object
// calculatePrice() consumes, so calculatePrice() itself stays pure and
// synchronous, unaware of where its numbers came from.
//
// GetTransfer/Viator are deliberately absent from this file and from
// PricingRates entirely — today's calculatePrice() returns manual_required
// for both channels unconditionally, with no formula and no constant of
// any kind (see service.ts's calculatePrice, the `input.channel ===
// "gettransfer"/"viator"` checks). There is nothing to resolve for them;
// inventing a Business Rule for a formula that doesn't exist would be
// exactly the "never invent a price" violation this whole system exists to
// prevent.

export interface PricingRuleProvenanceEntry {
  ruleKey: string;
  source: "business_rule" | "fallback_default";
  ruleId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  fallbackReason?: "rule_not_found" | "no_effective_version";
}

export interface PricingRatesResolution {
  // null only when a real configuration error (invalid content, or more
  // than one effective version for the same rule) made the tariff data
  // untrustworthy — never for a merely-missing rule, which uses the
  // documented temporary fallback below instead. calculatePrice() treats
  // null as "cannot price this run", returning manual_required with
  // reason "pricing_rules_invalid" — see service.ts.
  rates: PricingRates | null;
  provenance: PricingRuleProvenanceEntry[];
  usedFallback: boolean;
  invalidReason?: string;
}

interface RuleSlotResult<T> {
  value: T;
  provenance: PricingRuleProvenanceEntry;
}

// Resolves one rule slot: business rule's effective content if it exists
// and validates, the documented temporary fallback if the rule is simply
// missing or has no effective version yet (the expected state before this
// phase's migration is applied), or `null` if the rule exists, has an
// effective version, but that version's content fails validation — a real
// configuration error, never silently swallowed.
async function resolveRuleSlot<T>(
  tenantId: string,
  ruleKey: string,
  contentSchema: ZodType<T>,
  fallbackValue: T,
): Promise<RuleSlotResult<T> | null> {
  const rule = await getBusinessRuleByKey(tenantId, ruleKey);

  if (!rule) {
    log("pricing.rates_provider.fallback", { ruleKey, reason: "rule_not_found" });
    return {
      value: fallbackValue,
      provenance: { ruleKey, source: "fallback_default", ruleId: null, versionId: null, versionNumber: null, fallbackReason: "rule_not_found" },
    };
  }

  const effectiveVersions = rule.versions.filter((v) => v.status === "effective");

  if (effectiveVersions.length === 0) {
    log("pricing.rates_provider.fallback", { ruleKey, ruleId: rule.id, reason: "no_effective_version" });
    return {
      value: fallbackValue,
      provenance: {
        ruleKey,
        source: "fallback_default",
        ruleId: rule.id,
        versionId: null,
        versionNumber: null,
        fallbackReason: "no_effective_version",
      },
    };
  }

  if (effectiveVersions.length > 1) {
    // Should never happen given business-rules/service.ts's own state
    // machine (approving a new version always supersedes the old one
    // first) — treated as a real configuration error, not silently
    // resolved by picking one, and never masked as a mere "not migrated
    // yet" fallback.
    captureException(
      new Error(`pricing rule '${ruleKey}' has ${effectiveVersions.length} effective versions — expected exactly one`),
      "pricing.rates_provider.inconsistent_rule",
      { ruleKey, ruleId: rule.id, effectiveVersionIds: effectiveVersions.map((v) => v.id) },
    );
    return null;
  }

  // Length === 1 confirmed just above — the two branches before this one
  // already returned for 0 and >1.
  const effective = effectiveVersions[0]!;
  const parsed = contentSchema.safeParse(effective.content);
  if (!parsed.success) {
    captureException(new Error(`pricing rule '${ruleKey}' effective content failed validation`), "pricing.rates_provider.invalid_content", {
      ruleKey,
      ruleId: rule.id,
      versionId: effective.id,
      versionNumber: effective.versionNumber,
      zodError: parsed.error.message,
    });
    return null;
  }

  return {
    value: parsed.data,
    provenance: {
      ruleKey,
      source: "business_rule",
      ruleId: rule.id,
      versionId: effective.id,
      versionNumber: effective.versionNumber,
    },
  };
}

// The one function transfer-requests (or any future caller) needs: resolve
// today's effective tariff values for this tenant, with full provenance,
// or an explicit `rates: null` if the configuration cannot be trusted this
// run. Never throws — a resolution problem always comes back as data
// (`rates: null` + `invalidReason`), for calculatePrice() to turn into a
// normal manual_required PricingResult, same fail-soft discipline as every
// Claude-facing call elsewhere in this codebase.
export async function resolvePricingRates(tenantId: string): Promise<PricingRatesResolution> {
  const [minimumFare, tollRate, distanceRate, fixedFareAirport, foreignFixedTirano, hospitalWaitingItalian] = await Promise.all([
    resolveRuleSlot(tenantId, pricingRuleKeys.minimumFare, minimumFareRuleContentSchema, {
      minimumFareCents: DEFAULT_PRICING_RATES.minimumFareCents,
    }),
    resolveRuleSlot(tenantId, pricingRuleKeys.tollRate, tollRateRuleContentSchema, { ratePerKm: DEFAULT_PRICING_RATES.tollRatePerKm }),
    resolveRuleSlot(tenantId, pricingRuleKeys.distanceRate, distanceRateRuleContentSchema, DEFAULT_PRICING_RATES.distanceRate),
    resolveRuleSlot(tenantId, pricingRuleKeys.fixedFareAirport, fixedFareAirportRuleContentSchema, DEFAULT_PRICING_RATES.fixedFareAirport),
    resolveRuleSlot(
      tenantId,
      pricingRuleKeys.foreignFixedTirano,
      foreignFixedTiranoRuleContentSchema,
      DEFAULT_PRICING_RATES.foreignFixedTirano,
    ),
    resolveRuleSlot(
      tenantId,
      pricingRuleKeys.hospitalWaitingItalian,
      hospitalWaitingItalianRuleContentSchema,
      DEFAULT_PRICING_RATES.hospitalWaitingItalian,
    ),
  ]);

  const slots = { minimumFare, tollRate, distanceRate, fixedFareAirport, foreignFixedTirano, hospitalWaitingItalian };
  const invalidKeys = Object.entries(slots)
    .filter(([, slot]) => slot === null)
    .map(([name]) => name);

  if (invalidKeys.length > 0) {
    return {
      rates: null,
      provenance: [],
      usedFallback: false,
      invalidReason: `the following pricing rule(s) have invalid or inconsistent configuration and were refused rather than guessed: ${invalidKeys.join(", ")}`,
    };
  }

  // TypeScript can't see the `invalidKeys.length > 0` check above proves
  // every slot is non-null — asserted narrowly, right here, rather than
  // sprinkling non-null assertions through the object below.
  const resolved = slots as { [K in keyof typeof slots]: NonNullable<(typeof slots)[K]> };

  const rates: PricingRates = {
    minimumFareCents: resolved.minimumFare.value.minimumFareCents,
    tollRatePerKm: resolved.tollRate.value.ratePerKm,
    distanceRate: resolved.distanceRate.value,
    fixedFareAirport: resolved.fixedFareAirport.value,
    foreignFixedTirano: resolved.foreignFixedTirano.value,
    hospitalWaitingItalian: resolved.hospitalWaitingItalian.value,
  };

  const provenance = Object.values(resolved).map((slot) => slot.provenance);
  const usedFallback = provenance.some((p) => p.source === "fallback_default");

  return { rates, provenance, usedFallback };
}
