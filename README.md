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
3. Project settings → Service accounts → **Generate new private key**. Save the downloaded file as `worker/service-account.json` (git-ignored); `push-secrets.cmd` uploads it as `FIREBASE_SERVICE_ACCOUNT_B64`.

### 2. Email providers (hybrid)
Ink sends through **Cloudflare Email Service** for everyone on the shared domain, and through **Resend** only for authors who verify their own domain. Opens and clicks are tracked by Ink itself (`/o/…` pixel, `/r/…` redirect), so analytics do not depend on either provider.

**Cloudflare Email Service** (needs the Workers Paid plan, $5/month; 3,000 emails/month included, then $0.35 per 1,000):
1. Cloudflare dashboard → **Compute → Email Service → Email Sending → Onboard domain** → choose `mail.ink.jacobsiler.com` (subdomains are onboarded directly, as their own sending domain). Cloudflare writes the records itself: `cf-bounce.mail.ink…` MX ×3 + SPF, `cf-bounce._domainkey.mail.ink…` DKIM, and `_dmarc.mail.ink…` (p=reject). They coexist with the Resend `send.*` / `resend._domainkey` records already there.
2. `wrangler.toml` has the `[[send_email]]` binding and `EMAIL_PROVIDER = "cloudflare"`; deploy. Until the domain is onboarded, Cloudflare answers `E_SENDER_DOMAIN_NOT_AVAILABLE` and Ink falls back to Resend for an hour at a time; the Inbox placement card in Settings says which is in use.
3. New accounts start with a conservative daily quota that Cloudflare raises with good sending (`E_DAILY_LIMIT_EXCEEDED` pauses a send until the next day; `E_RATE_LIMIT_EXCEEDED` pauses 15 minutes). Keep `DAILY_SEND_CAP` in step. Limits: 50 recipients per message, 5 MiB per message.

**Resend** (optional — only for author custom domains):
1. Create an API key → `RESEND_API_KEY`. Without it the "own sending domain" feature is simply hidden.
2. Webhooks → `https://go.jacobsiler.com/webhooks/resend` with `email.delivered, email.bounced, email.complained, email.delivery_delayed` → signing secret → `RESEND_WEBHOOK_SECRET`. (Resend's open/click events are ignored; Ink tracks those itself, so leave Resend's tracking off.)

### 3. Gemini
Create a key at aistudio.google.com → `GEMINI_API_KEY`. Model is set in `wrangler.toml` (`gemini-2.5-flash`).

### 4. Secrets — keep them in ONE file
Copy `worker/.dev.vars.example` to `worker/.dev.vars` (git-ignored), fill in the five values (each line says where it comes from), then double-click `worker/push-secrets.cmd`. That uploads them all to the Worker in one go and prints what is set. Re-run any time you change one. `wrangler dev` reads the same file for local testing.

Alternative: `worker/set-secrets.cmd` prompts for each secret interactively; or `npx wrangler secret put NAME` one at a time.

Then deploy with `deploy.cmd` (or `cd worker && npx wrangler login && npx wrangler deploy`).
Check ``wrangler.toml` binds the Worker to the custom domain `go.jacobsiler.com` (wrangler creates the DNS record in your Cloudflare zone on deploy); `PUBLIC_URL` there and `WORKER` at the top of `index.html` must match it. The cron (`*/5 * * * *`) is registered on deploy.

### 5. Publish the app
Double-click `deploy.cmd` (edit `COMMIT_MESSAGE.txt` first): it adds, commits and pushes, deploys the Firestore rules, and deploys the Worker. Or push to GitHub manually; Pages serves `index.html` at ink.jacobsiler.com. Sign in, complete onboarding, add your postal address (required in every marketing email), and import your existing list (MailerLite export CSV works as-is).

## Deploying (InkWatch)

`scripts\ink-watch-install.cmd` (double-click once) installs a login auto-start and puts **InkWatch** in the system
tray: a green disc with an "I". It polls `.deploy-tick` every 15 seconds; when Claude rewrites that file after a
substantial change ("ticks the canary"), InkWatch waits 20 seconds for files to settle and runs
`scripts\ink-push.ps1`: git add/commit/push (GitHub Pages), `firebase deploy --only firestore:rules`, `wrangler deploy`.
The commit message comes from the canary's `subject:` and `body:` lines. A core file that shrank by more than half
holds the deploy (red icon, "Show anomaly report"; "Force deploy" overrides). `scripts\ink-push.cmd` runs the same
push by hand; `deploy.cmd` is the older equivalent and still works.

## Lists (one account, many audiences)

An account can hold several **lists** — an author list, a product or game list, a project launch list. Each list is a
separate `authors/{id}` document with its own readers, letters, plans, sign-up page, sending name, voice notes and
optional sending domain. The account's own uid is its first list; extra lists have ids `<uid>_<random>` and carry
`ownerUid`. The app sends the active list in an `X-Ink-List` header and every Worker call is scoped to it, so nothing
downstream (jobs, tokens, tracking, cron) needed to change.

Plans set how many lists an account may hold (`PLAN_LISTS` in the Worker): Free 1 · Author 2 · Pro 5 · Studio 25.
The plan lives in `authors/{uid}.plan` (Worker-only field). Until billing exists, operators listed in `INK_ADMIN_UIDS`
have unlimited lists and can set anyone's plan with `POST /admin/plan { uid, plan }`. Deleting a list is a soft delete
(`deleted: true`, slug released, nudges stopped); the data stays in Firestore.

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

All authenticated routes accept `X-Ink-List: <listId>` (defaults to the account's own list).
`GET /lists` · `POST /lists {name, kind}` · `POST /lists/:id/rename {name}` · `DELETE /lists/:id` · `POST /admin/plan {uid, plan}` (admins).

| Route | Purpose |
|---|---|
| `GET /me` · `POST /me/slug` · `POST /me/recount` | profile, sign-up address, recount actives |
| `POST /subscribers/add` | add one reader (triggers welcome series) |
| `POST /ai/draft` `/ai/subjects` `/ai/polish` `/ai/plan` `/ai/insights` | Gemini |
| `POST /campaigns/:id/test` `/send` `/schedule` `/unschedule` `/report` · `GET /campaigns/:id/job` | sending |
| `POST /domain` · `POST /domain/verify` · `DELETE /domain` | author's own sending domain via Resend |
| `GET /deliverability` · `GET /list/health` · `POST /list/prune` | inbox-placement checks, list temperature, archive cold readers |
| `POST /nudge/run` · `POST /automations/welcome/test` | manual triggers |
| public: `GET/POST /join/:slug` · `GET /embed.js` · `GET /confirm/:token` · `GET/POST /u/:uid/:sid/:token` · `GET /keep/:uid/:sid/:token` · `GET /o/…` (open pixel) · `GET /r/…` (click redirect) · `GET/POST /approve/:token` · `POST /webhooks/resend` | |

Sends run as resumable jobs (`jobs/{uid}_{cid}`): an engaged-first queue in 4,000-id chunks, 100 per batch, paced for warm-up and the daily budget, continued by the cron. Provider limits or outages pause the job and rewind the batch; already-reached readers are skipped on retry, so nobody gets a letter twice.

## Local testing
`node --check` all files; `worker/` runs under `wrangler dev` with `.dev.vars` holding the secrets. The renderer can be exercised in Node directly (`import './shared/render.js'`).
