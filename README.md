# Vancouver Building Permit Alerts

Weekly email of newly issued City of Vancouver building permits ≥ CAD $20M,
each researched and summarized by Claude Sonnet 5, delivered via Gmail. Runs
on a free GitHub Actions cron.

## How it works
`src/run.ts` → fetch (`lib/sources`) → dedup (Supabase `notified_permits`) →
enrich (`lib/enrich`, Sonnet 5 + web search) → render + send (`lib/email`,
Gmail SMTP, includes a rolling 30/90/365-day stats table) → record sent
permits. See `docs/superpowers/specs/` for the design.

## Setup

### 1. Supabase
A project with `notified_permits` and `alert_recipients` tables (RLS on, no
public policies). Add/disable recipients:
```sql
insert into alert_recipients (email, name) values ('someone@example.com', 'Name');
update alert_recipients set active = false where email = 'x@example.com';
```

### 2. Gmail App Password
Enable 2-Step Verification on the Google account, then create an App Password
(myaccount.google.com/apppasswords). Use it as `GMAIL_APP_PASSWORD`.

### 3. Secrets
Add these as **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Example |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (service role key) |
| `GMAIL_USER` | `mfweggemans@gmail.com` |
| `GMAIL_APP_PASSWORD` | 16-char app password |
| `ALERT_FROM_EMAIL` | `"Matthijs Weggemans" <mfweggemans@gmail.com>` |
| `ANTHROPIC_API_KEY` | (Anthropic key) |
| `TEST_EMAIL` | your address (dry-run preview target) |

For local runs, copy `.env.example` to `.env` and fill the same values.

## Running

- Local: `npm install` then `npm start`.
- Dry run (no DB writes, preview to `TEST_EMAIL`, HTML to `dry-run-preview.html`):
  `DRY_RUN=true npm start` (add `ENRICH=false` to skip AI).
- CI: automatic Mondays 15:00 UTC; or **Actions → Weekly Permit Alerts → Run
  workflow** with the `dry_run` / `enrich` toggles.

## Keep-alive
`.github/workflows/keepalive.yml` runs every 3 days: it pings Supabase (a
trivial read) so the free-tier project doesn't auto-pause after 7 days of
inactivity, and commits a timestamp to `keepalive/last-ping.txt`, which also
resets GitHub's 60-day scheduled-workflow dormancy clock. No action needed
unless both this workflow and `permit-alerts.yml` stop running — check the
Actions tab in that case.

## Extending with new sources
Add `lib/sources/<name>.ts` exporting a `PermitSource` (normalize into
`PermitRecord`), then add it to the `SOURCES` array in `lib/sources/index.ts`.
The dedup, enrichment, and email pipeline reuse it automatically.
