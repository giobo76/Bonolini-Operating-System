// ImageGenerator — a small, swappable adapter for the Social Agent's
// "content -> image -> validation -> Facebook/Instagram" pipeline. The
// interface is the contract; the Social Agent (agents/social-agent.ts) and
// its tools (tools/social-tools.ts) only ever depend on ImageGenerator,
// never on a specific provider, so a real provider can be added later
// (Stability, DALL-E, a stock-photo API — whatever the founder picks) by
// implementing this interface and changing only getConfiguredImageGenerator
// below, never the agent/tool code itself.
//
// The default provider (NoopImageGenerator) never calls any external or
// paid service — required so automated tests, and any environment without
// a configured provider, never make a real network call here. It always
// returns ok:false with a clear reason, which every caller (see
// tools/social-tools.ts's prepareSocialContentTool) already treats as a
// normal, expected outcome, not an error to crash on — "fallback sicuro se
// la generazione fallisce."

export interface ImageGenerationRequest {
  theme: string;
  tenantId: string;
}

export interface ImageGenerationResult {
  ok: boolean;
  theme: string | null;
  url: string | null;
  provider: string;
  error?: string;
}

export interface ImageGenerator {
  readonly name: string;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export class NoopImageGenerator implements ImageGenerator {
  readonly name = "noop";

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return {
      ok: false,
      theme: request.theme,
      url: null,
      provider: this.name,
      error: "no image generator provider configured — see getConfiguredImageGenerator()",
    };
  }
}

// Deterministic, real-data-grounded briefs for the specific themes the
// founder named as examples — never a random/invented image concept. Pure
// text, no network call; used to brief whichever real provider is
// eventually configured (or just returned as-is when none is). Matches
// every other "never invent" rule in this codebase: only maps a REAL
// served route/theme (see content-source.ts's getRealPostDataSnapshot) to
// a fixed, pre-approved visual concept — never fabricates a new one.
const THEME_BRIEFS: ReadonlyArray<{ match: string; brief: string }> = [
  { match: "bernina", brief: "Alpine landscape with the red Bernina Express train, professional travel photography." },
  { match: "como", brief: "Lake Como with a premium chauffeur transfer car, elegant and understated." },
  { match: "wine", brief: "Terraced Valtellina vineyards, no people, warm golden-hour light." },
  { match: "valtellina", brief: "Terraced Valtellina vineyards, no people, warm golden-hour light." },
  { match: "airport", brief: "Premium airport transfer experience, no recognizable faces, clean and professional." },
];

// Rules from the founder's own spec: professional, on-brand, no random
// images, no invented facts, no recognizable faces unless necessary, no
// text on the image unless necessary.
export function briefForTheme(theme: string): string | null {
  const normalized = theme.toLowerCase();
  const found = THEME_BRIEFS.find((entry) => normalized.includes(entry.match));
  return found?.brief ?? null;
}

export function getConfiguredImageGenerator(): ImageGenerator {
  // Provider selection is the one place this ever changes — swap this
  // return value for a real adapter once one is built and reviewed; the
  // Social Agent and its tools never need to change.
  return new NoopImageGenerator();
}
