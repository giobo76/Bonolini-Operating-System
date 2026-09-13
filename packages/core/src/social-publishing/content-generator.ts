import Anthropic from "@anthropic-ai/sdk";
import type { RealPostDataSnapshot } from "./content-source";

// Generation only — validation lives in validator.ts, publishing in
// meta-client.ts, per the founder's explicit instruction to keep these
// concerns separate. This never writes to social_posts or calls the Graph
// API; service.ts is the only orchestrator that does both.

// Written once, published as-is to both the Bonolini Transfer Facebook Page
// and Instagram account (see service.ts's runWeeklySocialPost) — the prompt
// says so explicitly so the post never reads as Facebook-specific (e.g. "as
// always on our Page") in a way that would look out of place on Instagram.
const SYSTEM_PROMPT = `You are writing a single social media post in English for Bonolini Transfer, a premium chauffeur/NCC (private car with driver) service based in Italy. It will be published as-is to both the company's Facebook Page and Instagram account — do not write anything specific to one platform only.

Hard rules, never violate them:
- Only use the real data provided below (served routes, transfer types, service area places). Never invent a fact, number, statistic, testimonial, review, price, or business volume/customer-count figure not present in the data.
- Never mention client names, phone numbers, emails, or any individual customer detail — none is provided to you and none should appear.
- Never state or imply booking counts, revenue, or business volume.
- Write in English only.
- No keyword stuffing — write naturally, for a real audience of travelers.
- End with exactly one clear call-to-action inviting the reader to get in touch (e.g. "message us", "get in touch", "reach out to book") — never invent a phone number, email, or link.
- Output a single, self-contained social post: no headers, no markdown formatting, no hashtags unless they read naturally, no placeholders like [insert] or {{...}}.`;

function buildUserMessage(snapshot: RealPostDataSnapshot): string {
  return `Real data for this week's post (the only facts you may reference):

Served routes (pickup -> destination), last ${snapshot.windowDays} days: ${JSON.stringify(snapshot.servedRoutes)}
Transfer types observed: ${JSON.stringify(snapshot.transferTypes)}
Service area places: ${JSON.stringify(snapshot.serviceAreaPlaces)}

Write the post now.`;
}

// Returns null (never a placeholder string) whenever real generation isn't
// possible — ANTHROPIC_API_KEY missing, or Claude returning no text block —
// so a caller never has a fabricated-looking fallback text it could
// accidentally publish. Unlike weekly-report.ts's synthesizeWeeklyNarrative
// (an internal report, safe to degrade to a plain-text summary), a public
// social post has no safe degraded form.
export async function generatePostContent(snapshot: RealPostDataSnapshot): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(snapshot) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  return text.length > 0 ? text : null;
}
