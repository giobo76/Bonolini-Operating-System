# quote-approval — WhatsApp quote approval flow

**Status:** implemented 2026-09-24. Not yet validated live.

**Owns:** `quote_approval_requests` (one row per "PREVENTIVO PRONTO" round) and `founder_whatsapp_messages` (the founder's own inbound messages, used only if a founder WhatsApp number is ever configured). Migration `0028_quote_approval.sql`.

**Exposes:**
- `handleCustomerMessageOutcome` and `handleFounderMessage`, called by the WhatsApp webhook.
- The decisions `approveQuoteRound`, `rejectQuoteRound` and `reviseQuoteRound`, with the panel queries `listPendingForPanel` and `getRoundForPanel`.
- `quoteApprovalRouter` (`appRouter.quoteApproval`), used by the admin pages `/preventivi` and `/preventivi/[id]`.

**Emits / listens to:** nothing. Called inline from the WhatsApp webhook and from the admin panel.

## How the founder works (decision of 2026-09-24)

There is no founder WhatsApp number (`FOUNDER_WHATSAPP_PHONE` empty):
- The founder is notified **by email only**, via Resend, to `FOUNDER_NOTIFICATION_EMAIL`, or `MARKETING_ALERT_EMAIL` if that is empty.
- The founder decides **in the admin panel**, under "Preventivi in attesa".
- No WhatsApp is ever attempted towards the founder, and nothing is logged as an error for it.

The WhatsApp button code (APPROVA / MODIFICA / RIFIUTA replies) is kept but dormant. It turns on only if `FOUNDER_WHATSAPP_PHONE` is set, and it calls exactly the same decision functions as the panel.

## Switches (`config.ts`)

- `QUOTE_APPROVAL_ENABLED` — only the exact string `"true"` turns the flow on. Anything else means:
  - the webhook behaves exactly as before this module existed;
  - no question to the customer and no email;
  - the panel shows "flusso disattivato" and refuses every decision.
- `QUOTE_APPROVAL_TEST_PHONES` — comma-separated E.164 list. When set:
  - the automatic question, the emails, the panel lists and the quote to the customer only concern these customers;
  - Approva refuses, before approving anything, for anyone else;
  - it fails closed: set but with no valid number means nobody.

  Empty/unset means everyone.
- `ADMIN_BASE_URL` — the panel address, used for the links in the emails. Without it the emails go out without links and say where to go.

All are read on every call; on Vercel a change takes effect with the next deploy.

## The flow

```
customer WhatsApp ─▶ transfer-requests (merge, availability, pricing)
   │
   ├─ collecting_info ─────────▶ automatic question to the customer (missing data + children/ages + luggage)
   ├─ pending_admin_approval ──▶ email "PREVENTIVO PRONTO" (data, exact customer text, link to /preventivi/<id>)
   └─ ready_for_pricing + manual_required ─▶ email "PREZZO DA INSERIRE" (link to /preventivi)

panel Approva  ─▶ acceptTransferRequest (or modifyPrice for a modified round), with the round's deposit,
                  approver = logged-in profile
               ─▶ booking created at pending_deposit (deal stays "quoted")
               ─▶ communications: prepare → submit → approve → execute ─▶ quote to the customer
                  (total, deposit to confirm the booking, balance to the driver on the day)
               ─▶ email "IN ATTESA DI ACCONTO" (link to the customer page with the booking)
panel Modifica ─▶ price (+ optional deposit; empty = 50% rule): this round superseded, new round
                  (no email, the page opens it)
panel Rifiuta  ─▶ rejectTransferRequest, nothing sent to the customer
panel Crea preventivo (Prezzo da inserire) ─▶ request to pending_admin_approval at the typed price
               (and deposit: empty = 50% rule)
               ─▶ new PREVENTIVO PRONTO round (Approva / Modifica / Rifiuta), nothing sent
panel "Acconto ricevuto" (Preventivi in attesa, or the customer page)
               ─▶ bookings.confirmBookingDeposit: pending_deposit → confirmed, deal confirmed
               ─▶ communications.sendBookingConfirmation ─▶ confirmation to the customer (automatic)
any customer send that fails ─▶ email "INVIO AL CLIENTE NON RIUSCITO" (once)
```

**Deposit rule** (`pricing/deposit.ts`): 50% of the total, rounded to the nearest 10 €, halves up (390 € → 200 €). It is never zero and never more than the total. The founder can override it per quote in Modifica. BOS never generates a payment link: the founder sends the SumUp link.

**Confirmation to the customer** (founder decision, 2026-09-24): sent automatically after "Acconto ricevuto", in IT/EN with the booking's date and time. `confirmDepositReceived` is shared by the panel (the list and the customer page) and the dormant WhatsApp button. It follows the same switches, 24h window and double-send protection as every other message (idempotency key `booking_confirmation:<booking id>`). If the send fails, the page says so and an alert email goes out.

**Texts:** the founder's final wording (2026-09-24), in `communications/content.ts` and tested verbatim:
- the price lines of the quote: total, deposit to confirm the booking, balance "preferibilmente in contanti", and the line announcing the deposit payment link;
- the confirmation message: the balance line, and "driver's name and contact the day before".

The quote reaches the customer **only** from Approva, whether from the panel or a dormant WhatsApp button. That is the only code path that calls `approveCommunication` for a `quote_offer`.

## Founder decisions (2026-09-24)

1. The missing-data question goes out automatically. It uses fixed texts, no AI and no price. `communications.sendMissingInfoRequest` is the one customer message that skips approval, and its `policy_decision` records this rule.
2. Rifiuta: the customer receives nothing.
3. Manual price (2026-09-25): in "Preventivi in attesa", each "Prezzo da inserire" card has a price field and **Crea preventivo** (`enterManualPrice`).
   - The card's row is closed (`info → superseded`, conditional, so a double click creates one round only).
   - The request moves to `pending_admin_approval` through `transfer-requests.enterManualPriceForTransferRequest`. `calculatedAmountCents` stays null and the price is recorded in `pricingBreakdown.manualPrice`.
   - A normal PREVENTIVO PRONTO round opens at that price, marked "prezzo inserito a mano", with Approva / Modifica / Rifiuta.
   - Approva goes through `modifyPriceForTransferRequest`, now allowed without a calculated amount only for `manual_required` requests.
   - Nothing is sent to the customer before Approva.
4. Children (number and ages) and luggage are asked for, but never block pricing.
5. Customer texts are the founder's own wording, in `communications/content.ts`, tested verbatim:
   - register "Lei", signature "Bonolini Transfer – Private Transfers";
   - fixed vehicle line "minivan premium con autista privato", price "per l'intero veicolo";
   - Italian or English: Italian or unknown → Italian, any other detected language → English;
   - never the word "taxi".
6. Panel decisions are allowed for admin and dispatcher (`staffProcedure`), like `transferRequests.accept/reject/modifyPrice`.

## Safety properties

- **Double click / double tap.** Approva and Rifiuta first move the round `awaiting_decision → processing` with a conditional UPDATE. A second click finds nothing to claim and gets "già approvato" / "già rifiutato" / "sto già elaborando". The panel button is also disabled while the request runs.
- **Only the round shown.** Every page and button names one `quote_approval_requests.id`. After Modifica the old round is `superseded`, and its page and buttons can no longer approve the old price.
- **No double sends to the customer.** The quote's idempotency key is `transfer_quote_offer:<transfer_request_id>`, and `executeCommunication` claims the row atomically (`provider IS NULL`) before calling Meta.
- **Failure alerts exactly once.** `executeCommunicationDetailed` says whether *this* call attempted the send. Only that call emails "INVIO AL CLIENTE NON RIUSCITO", so retries and duplicate webhooks don't repeat it.
- **Failures are retryable and honest.** An error before the customer send (e.g. booking creation failed) returns the round to `awaiting_decision`, and Approva can be pressed again. A failed send is reported as failed, never as sent. A `processing` claim older than 5 minutes (a crashed invocation) can be claimed again.
- **Price shown = price sent.** If the request was approved elsewhere at a different price, Approva sends nothing and says so.
- **Only the founder's WhatsApp commands** (if the number is ever set): the webhook's Meta signature proves `from`, and messages from `FOUNDER_WHATSAPP_PHONE` never reach client matching.

## 24h window

It applies to the customer: WhatsApp free-form messages only reach someone who wrote in the last 24 hours. If the founder approves later than that, the quote is rejected by Meta, or replaced by the static template (`WHATSAPP_TEMPLATE_NAME`, if configured), which does not contain the quote. The panel shows it, and the founder gets the "INVIO AL CLIENTE NON RIUSCITO" email with the text to send by hand.

## Known limits

- **No deposit deadline.** A booking stays `pending_deposit` until the founder confirms or cancels it; nothing expires automatically.
- **Late messages don't update a pending request.** A customer message with children or luggage that arrives after `pending_admin_approval` is not merged into it: that is the existing matching rule for a live offer.
- **Speed.** Everything runs inline in the webhook or the panel request.
