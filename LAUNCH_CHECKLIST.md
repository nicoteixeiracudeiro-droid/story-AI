# StudyAI Launch Checklist

Use this before taking real money from customers.

## Step 5 - Stripe Test Payments

- Create or finish the Stripe account with a parent/adult business owner.
- Stay in Stripe test mode first.
- Add these values to `.env`:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=http://localhost:5173
```

- Run the local server:

```bash
node server.mjs
```

- Start Stripe webhook forwarding:

```bash
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

- Create a StudyAI account in the website.
- Click a premium plan.
- Pay with a Stripe test card.
- Confirm premium activates only after Stripe confirms payment.
- Confirm premium does not activate when checkout is cancelled.

## Step 6 - Hosting

Choose a hosting provider with your father. The app needs:

- Node server hosting
- Environment variables
- HTTPS
- A persistent database
- A public URL for Stripe success/cancel URLs and webhooks

Good next options:

- Render or Railway for the Node backend
- Supabase or PostgreSQL for the real database
- A real domain name when ready

Do not rely on `data/studyai-db.json` for the final public version. It is useful for local development, but production should use Supabase/Postgres through `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Step 7 - Legal And Final Checks

- Review `terms.html`, `privacy.html`, and `refunds.html` with a parent/adult.
- Replace starter legal text with the final business name, address, support email, and local legal requirements.
- Add a real support email.
- Test account creation, login, logout, free limits, premium checkout, and premium access.
- Rotate any API keys that were pasted into chat or shared accidentally.
- Switch Stripe from test mode to live mode only after test payments work.
- Add live Stripe keys to the hosted server, not to frontend files.
- Make one small real payment test with your father before advertising the site.
