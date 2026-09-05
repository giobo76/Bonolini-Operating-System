import type { RealPostDataSnapshot } from "./content-source";

// Pure, network-free validation — the one gate every generated post must
// clear before publishTextPost() is ever called. Kept deliberately separate
// from content-generator.ts (generation) and meta-client.ts (publishing) per
// the founder's explicit instruction to keep generation/validation/
// publishing/logging/idempotency as distinct concerns.

const MIN_LENGTH = 40;
const MAX_LENGTH = 3000;

const CTA_KEYWORDS = ["contact", "book", "whatsapp", "reach out", "get in touch", "message us"];

// Every one of these patterns targets a category of fact this module never
// supplies to Claude (see content-generator.ts's system prompt and
// content-source.ts's snapshot shape) — a match means the model added
// something it wasn't given, not that real data leaked through.
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "email address", pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { name: "phone-like number", pattern: /\+?\d[\d\s\-()]{6,}\d/ },
  { name: "currency amount", pattern: /[€$£]\s?\d/ },
  { name: "placeholder marker", pattern: /\[(insert|todo|placeholder)/i },
  { name: "placeholder marker", pattern: /\{\{/ },
  {
    name: "invented testimonial/rating claim",
    pattern: /\b(testimonials?|reviews?|5-star|five-star|ratings?|customers said|guarantees?)\b/i,
  },
  {
    name: "business volume claim",
    pattern: /\b\d+[,.]?\d*\s*(customers|clients|bookings|transfers|trips|years in business)\b/i,
  },
];

// A light heuristic, not a real language detector (no NLP dependency
// justified for a single-sentence check) — a safety net behind the system
// prompt's own "English only" instruction, not the primary defense.
// Threshold, not zero-tolerance: fluent English prose can contain an
// occasional loanword; several of these together is the actual signal.
const ITALIAN_TELLS = /\b(il|lo|gli|delle|dei|che|per|con|siamo|nostri|servizio)\b/gi;
const ITALIAN_TELL_THRESHOLD = 3;

export interface PostValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePostLength(text: string): string | null {
  const length = text.trim().length;
  if (length < MIN_LENGTH) return `post is too short (${length} chars, minimum ${MIN_LENGTH})`;
  if (text.length > MAX_LENGTH) return `post is too long (${text.length} chars, maximum ${MAX_LENGTH})`;
  return null;
}

export function validatePostHasCta(text: string): string | null {
  const lower = text.toLowerCase();
  return CTA_KEYWORDS.some((keyword) => lower.includes(keyword)) ? null : "post has no recognizable call-to-action";
}

export function validatePostForbiddenContent(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => `post appears to contain a ${name}, which is never supplied as real data`,
  );
}

export function validatePostLanguage(text: string): string | null {
  const matches = text.match(ITALIAN_TELLS);
  return (matches?.length ?? 0) >= ITALIAN_TELL_THRESHOLD ? "post appears to be written in Italian, not English" : null;
}

export function validatePost(text: string, snapshot: RealPostDataSnapshot): PostValidationResult {
  const errors: string[] = [];

  if (snapshot.servedRoutes.length === 0) {
    errors.push("no real served routes in the data snapshot — refusing to validate an ungrounded post");
  }

  const lengthError = validatePostLength(text);
  if (lengthError) errors.push(lengthError);

  const ctaError = validatePostHasCta(text);
  if (ctaError) errors.push(ctaError);

  errors.push(...validatePostForbiddenContent(text));

  const languageError = validatePostLanguage(text);
  if (languageError) errors.push(languageError);

  return { valid: errors.length === 0, errors };
}
