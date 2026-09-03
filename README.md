# Ink — author list marketing

Ink is a mailing-list manager, sender, and marketing coach for fiction authors. It owns the subscriber list (no MailerLite), sends through Resend, keeps a campaign schedule, drafts each letter with Gemini a few days before it is due, and never sends anything without the author's approval.

Live app: https://ink.jacobsiler.com (GitHub Pages, this repo). Server: a Cloudflare Worker in `worker/`.

```
index.html            the app (single file, Firebase SDK from CDN, no build)
shared/render.js      email renderer + merge fields — used by app preview AND Worker
shared/templates.js   20 templates + 6 playbooks + welcome sequence
worker/               Cloudflare Worker: API, sending, webhooks, cron, public pages
firestore.rules       Firestore security rules
legacy/index.html     the original single-author Ink Room page
```

## What it does

- **Readers** — add, import CSV, tag, search, export; hosted join page (`/join/<slug>`), embeddable form (`/embed.js`), optional double opt-in, one-click unsubscribe with `List-Unsubscribe` headers.
- **Letters** — editor with live preview; "Ask Ink to write it" from a two-line brief; subject suggestions; "tweak" instructions; segments by tag and engagement; test sends; approve & schedule or approve & send now.
- **Plan** — playbooks (steady nurture, book launch, Kickstarter, re-warm, sale week, ARC team) or an AI-chosen plan from a goal. Ink auto-drafts each item `leadDays` before it is due, puts it in **Approvals**, and emails the author a link that approves and schedules it in one click.
- **Welcome series** — automated drip to new readers, editable, with test sends.
- **Analytics** — per-letter delivered/open/click/unsub/bounce from Resend webhooks, reader growth, benchmarks, list-health score, and "Ask Ink for insights" (suggestions land in Approvals). Ink emails a 48-hour report after every send.
- **Nudges** — daily check at the author's chosen hour: drafts ready, approvals overdue, quiet list with no plan.

## Setup (one-time)

### 1. Firebase (project `miscellaneous-117e9`)
1. Authentication → enable **Google** and **Email/Password**. Add `ink.jacobsiler.com` to authorised domains (authDomain is already `auth.jacobsiler.com`).
2. Firestore rules: `firestore.rules` is the full merged file (Boxes + Folio + Ink). `deploy.cmd` publishes it via the Firebase CLI (`npm i -g firebase-tools`, then `firebase login` once); or paste it into the console.
3. Project settings → Service accounts → **Generate new private key**. Keep the JSON; it becomes the `FIREBASE_SERVICE_ACCOUNT` secret.

### 2. Resend
1. Create an API key → `RESEND_API_KEY`.
2. Domains → add `mail.ink.jacobsiler.com` (or whatever you set as `INK_FROM_DOMAIN`) and add the DNS records in Cloudflare. This is the shared sending domain for every author; authors can verify their own later from Settings.
3. Webhooks → add `https://<worker-url>/webhooks/resend` with events `email.delivered, email.opened, email.clicked, email.bounced, email.complained, email.delivery_delayed`. Copy the signing secret → `RESEND_WEBHOOK_SECRET`.
4. In the Resend domain settings turn on **open and click tracking**.

### 3. Gemini
Create a key at aistudio.google.com → `GEMINI_API_KEY`. Model is set in `wrangler.toml` (`gemini-2.5-flash`).

### 4. Deploy the Worker
```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # paste the JSON on one line
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INK_SIGNING_SECRET         # e.g. openssl rand -base64 48
npx wrangler deploy
```
Check `PUBLIC_URL` in `wrangler.toml` matches the deployed URL (or add a route like `ink-api.jacobsiler.com`), and `WORKER` at the top of `index.html` matches too. The cron (`*/5 * * * *`) is registered on deploy.

### 5. Publish the app
Double-click `deploy.cmd` (edit `COMMIT_MESSAGE.txt` first): it adds, commits and pushes, deploys the Firestore rules, and deploys the Worker. Or push to GitHub manually; Pages serves `index.html` at ink.jacobsiler.com. Sign in, complete onboarding, add your postal address (required in every marketing email), and import your existing list (MailerLite export CSV works as-is).

## Data model (Firestore)

```
authors/{uid}                    profile, voice, books, sender settings, brand, counters, nudgeNextAt
  subscribers/{sha(email)}       email, name, status, tags, source, opens, clicks, lastOpenAt…
  campaigns/{id}                 subject, body, segment, status, scheduledAt, stats{…}, report
    recipients/{sid}             per-recipient delivery/open/click (Worker-only writes)
  plans/{id}                     playbookId, anchorDate, items[{dueDate,status,campaignId,brief}]
  suggestions/{id}               the Approvals inbox: drafts, insights, reports
  automations/welcome            enabled, steps[]
  metricsDaily/{yyyy-mm-dd}      subscribed, unsubscribed, opens, clicks, sent
slugs/{slug} · jobs · schedule · automationRuns · emailIndex   (Worker-only)
```
Times are ISO strings. Subscriber ids are the first 20 chars of base64url(sha256(lowercased email)), so imports dedupe naturally.

## Worker API (Bearer = Firebase ID token)

| Route | Purpose |
|---|---|
| `GET /me` · `POST /me/slug` · `POST /me/recount` | profile, sign-up address, recount actives |
| `POST /subscribers/add` | add one reader (triggers welcome series) |
| `POST /ai/draft` `/ai/subjects` `/ai/polish` `/ai/plan` `/ai/insights` | Gemini |
| `POST /campaigns/:id/test` `/send` `/schedule` `/unschedule` `/report` · `GET /campaigns/:id/job` | sending |
| `POST /domain` · `POST /domain/verify` · `DELETE /domain` | author's own sending domain via Resend |
| `POST /nudge/run` · `POST /automations/welcome/test` | manual triggers |
| public: `GET/POST /join/:slug` · `GET /embed.js` · `GET /confirm/:token` · `GET/POST /u/:uid/:sid/:token` · `GET/POST /approve/:token` · `POST /webhooks/resend` | |

Sends run as resumable jobs (`jobs/{uid}_{cid}`): 100-recipient Resend batches, continued by the cron if a request runs out of time, so large lists are fine on the free Workers plan.

## Local testing
`node --check` all files; `worker/` runs under `wrangler dev` with `.dev.vars` holding the secrets. The renderer can be exercised in Node directly (`import './shared/render.js'`).
