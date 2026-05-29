# StudyAI Web

StudyAI is a web demo for a study-focused AI tutor. The goal is to show a professional landing page where students can try a tutor-style chat, use a limited free plan, and see premium subscription options.

## Current Status

This is now a simple frontend plus Node backend demo using plain HTML, CSS, JavaScript, and `server.mjs`.

The chat sends questions to `/api/study`. The site also checks `/api/status` to show whether it is using real OpenAI mode or backend fallback mode. If `OPENAI_API_KEY` is configured, the backend can call OpenAI. If it is not configured, the backend returns a safe fallback demo answer.

User accounts now work in the backend:

- create account
- log in
- log out
- session cookie
- password hashing
- Supabase/Postgres database in production when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured
- local JSON database at `data/studyai-db.json` for local development without Supabase
- free question usage saved per account

The local JSON database is only for development. Production should use Supabase/Postgres so accounts, sessions, and free question limits do not disappear between deployments.

Stripe Checkout is now wired into the backend for test mode. Premium buttons require an account first, then create a Stripe Checkout Session when `STRIPE_SECRET_KEY` is configured. Premium unlocks only after Stripe confirms payment through the webhook or through the server-side checkout confirmation after the success redirect.

## Files

- `index.html` - page structure, landing sections, chat area, pricing plans
- `style.css` - full visual design and responsive layout
- `script.js` - frontend chat flow, account modal, backend account state, prompt chips, browser fallback answers
- `server.mjs` - local backend, static file server, OpenAI `/api/study`, auth endpoints, Stripe Checkout, Stripe webhook
- `.env.example` - example environment variables for API setup
- `terms.html` - starter terms page for parent/legal review
- `privacy.html` - starter privacy page for parent/legal review
- `refunds.html` - starter refund page for parent/legal review
- `LAUNCH_CHECKLIST.md` - steps to finish Stripe testing, hosting, and final launch checks
- `data/studyai-db.json` - created automatically when accounts are used; ignored by Git

## Run Locally

From this folder:

```bash
node server.mjs
```

Then open:

```text
http://localhost:5173
```

## Deploy On Vercel

This project includes `vercel.json` and `api/index.mjs` so Vercel can serve the static website and run backend API routes.

Current production domain:

```text
https://studyai.cards
```

Fallback Vercel URL:

```text
https://story-ai-5os6.vercel.app
```

In Vercel, add these environment variables:

```text
OPENAI_API_KEY=your_real_key_here
OPENAI_MODEL=gpt-5.2
APP_URL=https://studyai.cards
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_secret_key_here
```

Stripe can be added later:

```text
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_stripe_webhook_secret_here
```

Important: Vercel uses Supabase for accounts when the two Supabase environment variables are configured. If they are missing, it falls back to temporary serverless file storage, which is only for demos.

## API And Account Endpoints

- `GET /api/status` - checks backend and OpenAI mode
- `POST /api/study` - sends a study question to OpenAI or fallback
- `POST /api/auth/signup` - creates a local account
- `POST /api/auth/login` - logs in and sets a session cookie
- `POST /api/auth/logout` - logs out and clears the session cookie
- `GET /api/auth/me` - returns the current logged-in user
- `POST /api/checkout` - creates a Stripe Checkout Session for a logged-in user
- `POST /api/checkout/confirm` - verifies a returned Stripe Checkout Session with Stripe
- `POST /api/stripe/webhook` - Stripe webhook endpoint for `checkout.session.completed`

## Add The OpenAI API

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Then add your real key:

```text
OPENAI_API_KEY=your_real_key_here
OPENAI_MODEL=gpt-5.2
PORT=5173
APP_URL=http://localhost:5173
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_secret_key_here
```

Do not put the API key in `script.js` or `index.html`. The browser should only call `/api/study`; the backend should call OpenAI.

The server blocks hidden files like `.env` and the local `data/` folder from being served publicly.

## Add Stripe Checkout

Create a Stripe account with a parent/adult business owner if needed. Start in test mode.

Add these values to `.env`:

```text
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_stripe_webhook_secret_here
APP_URL=http://localhost:5173
```

The checkout flow uses one-time payments:

- monthly - 19.99 CHF, unlocks 1 month
- term - 89.99 CHF, unlocks 5 months
- annual - 179.99 CHF, unlocks 12 months

For local webhook testing with the Stripe CLI:

```bash
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

Use the `whsec_...` value from that command as `STRIPE_WEBHOOK_SECRET`.

## Product Idea

StudyAI helps students learn topics with teacher-style explanations instead of generic study tips.

The main differentiator is that StudyAI is not positioned as a general AI chat. It is positioned as a study-focused tutor that always guides students through a lesson structure and ends with practice.

The intended response structure is:

- Topic
- Key idea
- Explanation
- Example
- Practice
- Next step

## Current Plans

Free:

- 5 trial questions

Premium:

- 1 month - 19.99 CHF
- 5 months - 89.99 CHF
- 12 months - 179.99 CHF

Premium buttons currently require a real local account first, then open Stripe Checkout when Stripe keys are configured. They activate premium only after Stripe confirms payment.

## Important Notes For The Next Agent

- Keep the website in English unless the user asks otherwise.
- The user is learning and is young, so explain changes clearly and patiently.
- Do not add real payments without discussing Stripe setup, account ownership, adult/legal requirements, and secure user accounts.
- Do not claim the AI is real unless `/api/status` says OpenAI is configured.
- Keep the project simple unless the user asks to move to a framework.

## Suggested Next Steps

1. Add Stripe test keys in `.env` and test with Stripe test cards.
2. Test Supabase account creation, login, logout, and free question limits on the live Vercel site.
3. Add Stripe test keys in Vercel and test Stripe Checkout with test cards.
4. Review the legal pages with a parent/adult and replace starter text.
5. Switch Stripe from test mode to live mode only after everything is tested.

See `LAUNCH_CHECKLIST.md` for the full launch checklist.
