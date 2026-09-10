import { randomBytes } from "node:crypto";

// Crockford-style alphabet: no 0/O or 1/I/L — avoids a token that's
// ambiguous when read back from a WhatsApp message a customer retyped, or
// when a founder manually copies one out of an email subject line.
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 8;
const TOKEN_PREFIX = "REF-";

// ~40 bits of entropy (32^8) — collision probability across this tenant's
// realistic lead volume is negligible; service.ts still checks for an
// existing row before using one, defensively, not because this is expected
// to ever actually collide.
export function generateContactToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  }
  return `${TOKEN_PREFIX}${token}`;
}

const TOKEN_PATTERN = /REF-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}/i;

// Pure text search — never guesses, only recognizes the exact shape BOS
// itself generates. Case-insensitive (a customer might retype it in
// lowercase) but always normalized back to the uppercase form actually
// stored in contact_token. Returns null on no match — never a partial or
// best-effort guess.
export function extractContactToken(text: string): string | null {
  const match = text.match(TOKEN_PATTERN);
  return match ? match[0].toUpperCase() : null;
}
