# quote-approval — WhatsApp quote approval flow

**Status:** implemented 2026-09-24. Not yet validated live.

**Owns:** `quote_approval_requests` (one row per "PREVENTIVO PRONTO" round sent to the founder) and `founder_whatsapp_messages` (the founder's own inbound messages). Migration `0028_quote_approval.sql`.

**Exposes:** `handleCustomerMessageOutcome`, `handleFounderMessage`, `isFounderPhone`. The only caller is `whatsapp/webhook-handler.ts`.

**Emits / listens to:** nothing. Called inline from the WhatsApp webhook, the same way `transfer-requests` is.

## The flow

```
customer WhatsApp ─▶ transfer-requests (merge, availability, pricing)
   │
   ├─ collecting_info ─────────▶ automatic question to the customer (missing data + children/ages + luggage)
   ├─ pending_admin_approval ──▶ founder: "PREVENTIVO PRONTO" + APPROVA / MODIFICA / RIFIUTA
   └─ ready_for_pricing + manual_required ─▶ founder: "PREZZO DA INSERIRE" (no buttons)

founder taps APPROVA ─▶ acceptTransferRequest (or modifyPrice for a MODIFICA round)
                      ─▶ communications: prepare → submit → approve (founder) → execute ─▶ quote to customer
founder taps RIFIUTA ─▶ rejectTransferRequest, nothing sent to the customer
founder taps MODIFICA ─▶ "write the new price" ─▶ founder writes "280" ─▶ new PREVENTIVO PRONTO at 280 € (new round, new buttons)
founder writes anything else ─▶ every pending PREVENTIVO PRONTO is re-sent
```

The quote reaches the customer **only** from an APPROVA tap. That is the only code path that calls `approveCommunication` for a `quote_offer`.

## Founder decisions (2026-09-24)

1. The missing-data question goes out automatically. It uses fixed texts, no AI and no price. `communications.sendMissingInfoRequest` is the one customer message that skips approval, and its `policy_decision` records this rule.
2. RIFIUTA: the customer receives nothing.
3. Manual price: notification only. There is no button to enter a manual price yet, because `modifyPriceForTransferRequest` requires `pending_admin_approval` and a `manual_required` request stays at `ready_for_pricing`.
4. Children (number and ages) and luggage are asked for, but never block pricing.
5. Customer texts are in Italian or English (`toCustomerLanguage`: Italian or unknown → Italian, any other detected language → English), with a professional private-transfer tone. The word "taxi" is never used.
6. Commands are valid only from `FOUNDER_WHATSAPP_PHONE`, and only through the button. A typed "APPROVA" is answered with "use the buttons".

## Safety properties

- **Only the founder.** The webhook's Meta signature proves `from`. Messages from `FOUNDER_WHATSAPP_PHONE` never reach client matching or `transfer_requests`. Other numbers can't trigger commands, because their messages never reach `handleFounderMessage`.
- **Only the quote named by the button.** The button id is `qa:<quote_approval_requests.id>:<action>`. After a MODIFICA the old round becomes `superseded`, so its old buttons can't approve the old price.
- **No double sends.**
  - A Meta retry of the same tap is dropped by the unique `(tenant_id, whatsapp_message_id)` on `founder_whatsapp_messages`.
  - A double tap: the first tap moves the round `awaiting_decision → processing` with a conditional UPDATE. The second finds nothing to claim and gets "già approvato" / "sto già elaborando".
  - The customer message: its idempotency key is `transfer_quote_offer:<transfer_request_id>`, and `executeCommunication` now claims the row atomically (`provider IS NULL`) before calling Meta.
- **Failures are retryable and honest.** An error before the customer send (e.g. booking creation failed) returns the round to `awaiting_decision`, and the same button retries. A failed customer send is reported to the founder as failed, never as sent. A `processing` claim older than 5 minutes (a crashed invocation) can be claimed again.
- **Price shown = price sent.** If the request was approved elsewhere (admin panel) at a different price, APPROVA sends nothing and says so.
- **One typed price at a time.** A partial unique index allows only one round per tenant in `awaiting_price`, so a bare "280" is never ambiguous.

## Founder channel and the 24h window

WhatsApp only delivers free-form or button messages to someone who wrote to the business number in the last 24 hours, and that includes the founder. `founder-channel.ts` checks the founder's last message in `founder_whatsapp_messages`:
- If the window is closed, or the WhatsApp send fails for any other reason, the same content goes by email via Resend to `MARKETING_ALERT_EMAIL`.
- The email explains that writing any message to the business number brings back all pending quotes with their buttons.
- If both channels fail, the round is marked `notification_status = 'failed'`. It is never reported as sent.

## Known limits

- **Customer 24h window.** If the founder approves more than 24 hours after the customer's last message, the WhatsApp to the customer is either rejected or replaced by the static template (`WHATSAPP_TEMPLATE_NAME`, if configured), which does not contain the quote. In both cases the founder gets a reply saying so.
- **Booking before customer acceptance.** APPROVA still creates the booking snapshot immediately (existing `acceptTransferRequest` behavior), before the customer has accepted.
- **Late messages don't update a pending request.** A customer message with children or luggage that arrives after the request reached `pending_admin_approval` is not merged into it. That is the existing matching rule for a live offer.
- **Speed.** Everything runs inline in the webhook, like the rest of the WhatsApp pipeline.
