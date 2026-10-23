# Rubika bot expansion — staged, not enabled

## Verified provider contracts

- Rubika [official Bot API](https://rubika.ir/botapi) accepts `POST https://botapi.rubika.ir/v3/{token}/{method}`. It has native chat keypads and a `receiveUpdate` HTTPS endpoint configured with `updateBotEndpoints`. `chat_id` and `sender_id` are **strings**; do not pass them into Bale `bale_id bigint`.
- Bale [official bot API](https://docs.bale.ai/) has `sendInvoice` (delivers an invoice to a **Bale chat**) and `createInvoiceLink`. **The latter returns a mini-app invoice parameter, NOT a public bank payment URL.** It only opens in the Bale mini-app JS `openInvoice` API, per [the Bale mini-app docs](https://docs.bale.ai/miniapp).
- A legitimate alternative using only the existing Bale wallet is a **Bale bot deep link**, e.g. `https://ble.ir/<bot>?start=rb_<random-nonce>`. This requires the customer to open Bale and pay there. It does not keep the customer wholly inside Rubika.

## Already prepared (feature branch only)

- `rubika.js`: typed/stable Persian button IDs, Rubika v3 sendMessage transport, strict private chat update normalization with stable message key. No real credentials are embedded.
- `rubika-payment.js`: secure bridge link formatting and server-side payment assertion. This is **not** a payment service, and is not wired to live payment routes.
- `tests/rubika-adapter.test.js`: regression checks for update isolation, keyboard mapping, provider errors and payment matching.

## Remaining work before production parity

1. The administrator creates a Rubika bot with Rubika BotFather and configures its token through a secure server-side integration; never place credentials in source, GitHub Pages, or chat messages. Validate with `getMe`.
2. Apply an isolated, access-controlled mapping from Rubika `(sender_id, chat_id)` to an internal customer ID. Keep existing Bale numeric identities and all Bale sessions/orders untouched. Never identify customers merely by name.
3. Implement and register an unguessable HTTPS webhook URL using `updateBotEndpoints` and type `ReceiveUpdate` (verify actual enum against user's documentation). Require idempotent update receipt and per-user locks; ignore group messages, edits, and duplicate IDs.
4. Share the existing business rules/flow engine for: OS choice/tutorial, purchase (first & last names), renewal (existing extension subscriber name), coupons including free/100%, supported duration/extension limits, order history, token binding, delivery/resend, and support. Route *all replies* to Rubika for Rubika orders.
5. Provide a payment integration that genuinely produces a **public customer-payable URL** and authentic server-side verification, or the explicit **Bale-app handoff** described above. Do not fabricate a `createInvoiceLink` URL or turn a precheckout/web redirect into a successful payment.
6. For Bale-app handoff, generate cryptographically random single-use nonce; persist only its hash with Rubika order/customer and expiry. Open Bale bot by deep link, bind verified Bale sender, issue `sendInvoice` in that Bale conversation, accept signed Bale webhook `successful_payment` plus `inquireTransaction`, check payer, order payload, currency, total amount and unique charge in a transaction; then deliver to Rubika, not Bale. Do not reuse existing `gpyb_precheckout` identity checks unchanged.
7. Ensure processing the *same* Bale wallet charge, replayed webhook, refresh, or repeated message never sends or renews multiple accounts. Pending/free/paid/review statuses must be consistent across platforms. Maintain audit and reporting by channel.
8. Verify test-mode and live-mode transactions end to end. Only then make the user-facing Rubika integration and live webhook available.

## Constraints

No Rubika bot token, confirmed public payment-gateway API, or user's promised Rubika docs link has been supplied in this turn. Therefore **Rubika live webhook, payments and fulfillment intentionally remain disabled**. The existing production Bale bot and Edge Function have not been altered by this feature branch. The decision whether customers can be sent into Bale to pay is a product requirement because the official wallet does not offer a standalone browser payment link via `createInvoiceLink`.
