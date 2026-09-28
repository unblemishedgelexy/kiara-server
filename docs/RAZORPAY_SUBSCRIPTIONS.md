# Razorpay Subscriptions

## Plans and limits

The server plan catalog lives in `src/config/subscriptionPlans.js`. Prices and monthly limits are configurable in the backend environment:

- Starter: INR 199/month, 60 live minutes, 300 chat messages
- Pro: INR 299/month, 180 live minutes, 1,000 chat messages
- Premium: INR 399/month, 400 live minutes, 2,500 chat messages

Free users retain the current product access and have no subscription quota. MongoDB stores subscription state and monthly usage; Redis is not used as the entitlement source.

## Razorpay setup

1. Create or select a Razorpay account and use Test Mode keys for initial testing.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in the backend environment only.
3. Run `npm run razorpay:plans` from `kiara-server`. The script creates any plans whose IDs are not configured and prints the three resulting IDs.
4. Set `RAZORPAY_PLAN_STARTER_ID`, `RAZORPAY_PLAN_PRO_ID`, and `RAZORPAY_PLAN_PREMIUM_ID` to those IDs in the backend environment. Do not mix IDs created with Test Mode keys and Live Mode keys.
5. Configure `RAZORPAY_WEBHOOK_SECRET` in the backend and the same secret in Razorpay Dashboard.
6. Configure the webhook URL as `https://<backend-host>/api/subscriptions/webhook/razorpay` and enable the subscription lifecycle events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.cancelled`, `subscription.completed`, and `subscription.expired`.
7. Restart the backend and verify `/api/subscriptions/plans` reports checkout as available before attempting a test checkout.

Do not place the secret key or webhook secret in frontend environment variables. The public Key ID is returned only after checkout is fully configured. Entitlements activate from backend-fetched Razorpay state or signature-verified webhooks, never from local storage or client state.

## API overview

- `GET /api/subscriptions/plans`: public plan catalog and checkout availability
- `GET /api/subscriptions/me`: authenticated plan, status, and monthly usage
- `POST /api/subscriptions/checkout`: create or schedule a plan change
- `POST /api/subscriptions/verify`: verify the checkout subscription signature and fetch payment/provider status
- `POST /api/subscriptions/cancel`: schedule cancellation for the end of the current cycle
- `POST /api/subscriptions/usage/chat/reserve`, `/commit`, `/release`: authenticated chat usage reservations
- `GET /api/subscriptions/usage/live/active`, `POST /api/subscriptions/usage/live/heartbeat`, `/end`: authenticated live-session metering
- `POST /api/subscriptions/webhook/razorpay`: signed, event-ID-idempotent provider lifecycle endpoint

## Cost and metering note

The repository does not include Gemini provider price data, so no infrastructure-cost or margin claim is made. Plan limits are centralized and configurable. Live usage is metered by server timestamps and authenticated heartbeats; the server denies new tokens and Home closes its live page when a heartbeat reaches quota.

Gemini Live and text messages currently use a direct client-to-Gemini WebSocket. Therefore the backend cannot independently inspect each successful text send or forcibly close a WebSocket that a modified client keeps open. Chat reservations and client heartbeat shutdown protect normal product use, but a fully adversarial enforcement boundary requires routing message/session traffic through a server-controlled proxy, which is outside the current Gemini runtime constraints.
