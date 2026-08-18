import { NextResponse, type NextRequest } from "next/server";
import { handleWhatsappVerification, handleWhatsappWebhookRequest } from "@bos/core";

// Public, unauthenticated — the only caller is Meta's WhatsApp Cloud API
// (webhook subscription verification + inbound message delivery), never
// this app's own UI. Excluded from middleware.ts's Supabase session gate
// the same way /api/marketing/lead-intent is: this exact path only. All
// real logic (signature verification, payload validation, processing)
// lives in packages/core/src/whatsapp/webhook-handler.ts, unit-tested
// there — this file only translates NextRequest/NextResponse to/from that
// framework-agnostic handler.

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const result = handleWhatsappVerification(
    {
      mode: searchParams.get("hub.mode"),
      verifyToken: searchParams.get("hub.verify_token"),
      challenge: searchParams.get("hub.challenge"),
    },
    process.env.WHATSAPP_VERIFY_TOKEN ?? "",
  );

  return new NextResponse(result.body, { status: result.status });
}

export async function POST(request: NextRequest) {
  // Read the exact raw body — the signature is computed over these exact
  // bytes; parsing to JSON first and re-serializing would not match.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const result = await handleWhatsappWebhookRequest({
    rawBody,
    signatureHeader,
    appSecret: process.env.WHATSAPP_APP_SECRET,
  });

  return NextResponse.json(result.body, { status: result.status });
}
