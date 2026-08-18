import Anthropic from "@anthropic-ai/sdk";
import { parsedWhatsappMessageSchema, type ParsedWhatsappMessage } from "./schema";

// Mirrors packages/core/src/marketing/strategist.ts's pattern exactly:
// forced tool-use, zod-validated tool input, fail-soft on any error or
// missing ANTHROPIC_API_KEY. Deliberately not a second AI integration —
// same SDK, same call shape, same "requires the deployed app's own
// ANTHROPIC_API_KEY" caveat.

const EXTRACTION_TOOL = {
  name: "report_extracted_data",
  description:
    "Report only the information explicitly present in the customer's WhatsApp message. Omit any field the message does not clearly state — never guess, infer an address, assume a price, or fabricate a date/time that isn't clearly resolvable from the message and the provided reference date.",
  input_schema: {
    type: "object" as const,
    properties: {
      fullName: { type: "string", description: "Only if the customer states their own name in the message" },
      phone: { type: "string", description: "Only if a phone number appears in the message text itself" },
      email: { type: "string" },
      pickup: { type: "string", description: "Pickup location, only as stated" },
      destination: { type: "string", description: "Destination, only as stated" },
      date: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD), only if reliably resolvable from the message plus the reference date given below (e.g. 'tomorrow' relative to the reference date). Omit if the date is ambiguous or cannot be resolved with confidence.",
      },
      time: { type: "string", description: "Only if an explicit time is stated" },
      passengers: { type: "integer", description: "Only if a passenger count is stated" },
      luggage: { type: "string", description: "Only if luggage quantity/type is mentioned" },
      flight: { type: "string", description: "Flight number, only if mentioned" },
      train: { type: "string", description: "Train number, only if mentioned" },
      hotel: { type: "string", description: "Only if a hotel name is mentioned" },
      language: { type: "string", description: "Language the message is written in" },
      intent: {
        type: "string",
        description: "Short label for what the customer wants, e.g. transfer_request, question, modification, cancellation, other",
      },
      missingInformation: {
        type: "array",
        items: { type: "string" },
        description: "Fields that would be needed to act on this request but were not provided (e.g. ['date','time'])",
      },
    },
    required: [],
  },
} as const;

const SYSTEM_PROMPT =
  "You extract structured data from a single WhatsApp message sent to a chauffeur/NCC company (Bonolini Transfer) in Italy. You report ONLY information explicitly present in the message. You never invent, guess, or assume a value that isn't clearly stated — if something is ambiguous or absent, omit that field entirely and list it in missingInformation instead. You are given the message's reference date/time (when it was received) so you can resolve unambiguous relative dates like 'tomorrow' or 'next Monday' — but only when you are confident in the resolution; otherwise omit the date field. Never invent a price, availability, hotel, flight/train number, or exact address that is not in the message.";

export async function parseWhatsappMessage(
  rawText: string,
  referenceDate: Date,
): Promise<ParsedWhatsappMessage> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping WhatsApp message parsing");
    return {};
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Reference date/time (when this message was received): ${referenceDate.toISOString()}\n\nMessage:\n${rawText}\n\nExtract only what is explicitly present using the report_extracted_data tool.`,
        },
      ],
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: "report_extracted_data" },
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return {};

    const result = parsedWhatsappMessageSchema.safeParse(toolUse.input);
    return result.success ? result.data : {};
  } catch (error) {
    console.error("WhatsApp message parsing failed — storing raw_text with no parsed data", error);
    return {};
  }
}
