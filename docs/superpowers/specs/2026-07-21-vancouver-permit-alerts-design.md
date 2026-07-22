# Design Spec: Vancouver Building Permit Alerts (Weekly Email)

**Date:** 2026-07-21
**Status:** Approved (pending spec review)

## Goal

A small Next.js (App Router) project deployed on Vercel that sends a weekly
email summarizing newly issued City of Vancouver building permits with a
construction value of CAD $20,000,000 or higher. Designed to be extended
later with more data sources (rezoning applications, development permits,
other municipalities).

## Decisions (differences from original brief)

- **Email delivery: Gmail SMTP via Nodemailer** (not Resend). The deployed
  Vercel app authenticates to Gmail with an App Password. From address is
  `"Matthijs Weggemans" <mfweggemans@gmail.com>` (Gmail SMTP requires the
  From to match the authenticated account; only the display name is custom).
- **No backfill.** Always use a strict 7-day window. Only send an email when
  there is genuinely new information in the last 7 days; otherwise exit
  silently.
- **Supabase: new project**, created and configured via the Supabase MCP.
- **Initial recipient:** `mweggemans@cressey.com` (seeded active).
- **AI enrichment (new).** Each new permit is researched and summarized by
  Claude Sonnet 5 with the server-side web search tool, producing a
  newsletter-style write-up aimed at a real estate developer (what the
  project is — tower / community centre / etc. — location, construction
  value, developer/applicant, and any renderings or article links Claude
  finds). The email leads with these summaries, followed by the full
  technical data table.

## Data source

City of Vancouver Open Data Portal, Opendatasoft Explore API v2.1.
No API key required.

Endpoint:
```
https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/issued-building-permits/records
```

Query (URL-encode properly):
```
?where=projectvalue>=20000000 AND issuedate>=date'{SEVEN_DAYS_AGO}'
&order_by=issuedate desc
&limit=100
```
- Use ISO dates (YYYY-MM-DD).
- Handle pagination via `offset` in case more than 100 results.
- Fields of interest (include ALL non-geometry returned fields in the email
  table): permitnumber, permitnumbercreateddate, issuedate,
  permitelapseddays, projectvalue, typeofwork, address, projectdescription,
  permitcategory, applicant, applicantaddress, propertyuse,
  specificusecategory, buildingcontractor, buildingcontractoraddress,
  issueyear, geolocalarea, yearmonth. Skip geometry fields (geom /
  geo_point_2d).
- **On first implementation pass, verify the actual field names** by fetching
  one record and inspecting the JSON. Do not assume — confirm.

## Architecture

1. **Vercel Cron** — `vercel.json` cron entry, every Monday 15:00 UTC. Calls
   `GET /api/cron/permit-alerts`.
2. **Route handler** `app/api/cron/permit-alerts/route.ts`:
   - Protect with `CRON_SECRET`. Vercel Cron sends
     `Authorization: Bearer <CRON_SECRET>`; the handler rejects mismatches
     with 401. For manual browser testing (dryRun), the secret may also be
     passed as `?secret=<CRON_SECRET>` since browsers cannot set the header.
   - Loop over a `SOURCES` array of source functions. For each source:
     - Fetch its data (last 7 days, `projectvalue >= 20,000,000`), paginated
       via `offset`, normalized into `PermitRecord[]`.
   - Dedup: query `notified_permits` for permit numbers already sent (keyed on
     `permit_number` + `source`); filter those out.
   - If nothing new across all sources: log to console and exit silently, send
     no email.
   - **Enrich** each new permit via `enrichPermits()` (Claude Sonnet 5 + web
     search) → a per-permit newsletter HTML block. Enrichment runs with
     limited concurrency; a per-permit failure (or a missing
     `ANTHROPIC_API_KEY`) falls back to a basic block built from the permit
     fields, so the email still sends.
   - If new permits: render an inline-CSS HTML email with (a) the newsletter
     section — one summary block per permit — followed by (b) a table (one row
     per permit, all non-geometry fields as columns; `projectvalue` formatted
     as `$XX,XXX,XXX CAD`; dates formatted as `YYYY-MM-DD`).
   - Send via Gmail SMTP as **individual sends** — one message per active
     recipient in `alert_recipients` where `active=true`. This isolates
     per-recipient failures and keeps recipients from seeing each other.
   - Insert the sent permit numbers into `notified_permits` — only after a
     successful send, and never in dryRun mode.

## Files

- `lib/types.ts` — `PermitRecord` normalized shape + `PermitSource` type.
- `lib/sources/cov-building-permits.ts` — `fetchCovBuildingPermits(days: number): Promise<PermitRecord[]>`.
- `lib/sources/index.ts` — `SOURCES` array of source descriptors/functions.
- `lib/enrich.ts` — Anthropic client + `enrichPermits(records): Promise<EnrichedPermit[]>` (Sonnet 5, adaptive thinking, `web_search_20260209`).
- `lib/email.ts` — Nodemailer Gmail transport, `renderPermitEmail()`, `sendEmail()`.
- `lib/supabase.ts` — service-role Supabase client.
- `app/api/cron/permit-alerts/route.ts` — orchestrator route handler (`export const maxDuration` set generously for web-search enrichment).
- `vercel.json` — cron entry.

## Normalized type (extensibility)

`PermitRecord` in `lib/types.ts` is the shared shape all sources map into, so
future sources (rezoning, development permits, other cities) reuse the dedup +
email pipeline. Each record carries a `source` identifier. Adding a source
later = one new file in `lib/sources/` + one entry in the `SOURCES` array.

`PermitRecord` fields (proposed, confirmed against live API during build):
- `source: string` (e.g. `'cov-issued-building-permits'`)
- `permitNumber: string`
- `projectValue: number`
- `issueDate: string` (YYYY-MM-DD)
- `address: string | null`
- `raw: Record<string, unknown>` — all original non-geometry fields, so the
  email table can render every field without the type enumerating each one.

The email renderer iterates `raw` (minus geometry keys) for table columns;
the typed fields drive dedup and the `notified_permits` insert.

## AI enrichment

`lib/enrich.ts` exports `enrichPermits(records: PermitRecord[]): Promise<EnrichedPermit[]>`
where `EnrichedPermit = PermitRecord & { summaryHtml: string }`.

- SDK: `@anthropic-ai/sdk`. Model: `claude-sonnet-5` (chosen over Opus to
  save credits — ample for weekly summarization). Adaptive thinking
  (`thinking: { type: "adaptive" }`). Server-side web search tool
  (`web_search_20260209`) so Claude can research each project.
- One streamed API call per permit (streaming avoids HTTP timeouts on
  web-search + thinking); collect via `.finalMessage()`. Concurrency is
  capped (e.g. 3 at a time) to stay within rate limits and function time.
- Prompt: system role = a newsletter writer briefing a Vancouver real estate
  developer; user message = the permit's fields. Claude is instructed to
  search the web for the project (name, developer, what's being built,
  renderings/coverage) and return a self-contained inline-CSS HTML block
  following a fixed template (headline, 2–3 sentence summary, key-facts list,
  any links found). Links are only included when Claude actually finds them —
  no fabricated URLs.
- Graceful degradation: on any per-permit API error, or when
  `ANTHROPIC_API_KEY` is unset, `summaryHtml` falls back to a basic block
  rendered from the permit fields. The email always sends.
- The route sets `export const maxDuration` high enough for sequential/limited-
  concurrency enrichment of a weekly batch (typically 0–5 permits).

## Supabase schema

Created in the **new** Supabase project via MCP. RLS enabled on both tables
with no public policies (server uses the service role key only).

```sql
create table notified_permits (
  permit_number text primary key,
  project_value numeric,
  issue_date date,
  address text,
  notified_at timestamptz default now(),
  source text default 'cov-issued-building-permits'
);

create table alert_recipients (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  active boolean default true,
  created_at timestamptz default now()
);
```

Seed: `insert into alert_recipients (email, name) values ('mweggemans@cressey.com', null);`

## Email

- Transport: Nodemailer over `smtp.gmail.com` (port 465, SSL) using
  `GMAIL_USER` + `GMAIL_APP_PASSWORD`.
- From: `"Matthijs Weggemans" <mfweggemans@gmail.com>` (via `ALERT_FROM_EMAIL`).
- Subject: `Vancouver Permits $20M+ — Week of {date}: {N} new permit(s)`
- Body: short intro line, then the **newsletter section** (one AI summary
  block per permit, from `enrichPermits`), then the **technical table**, then
  a footer linking to the dataset page:
  https://opendata.vancouver.ca/explore/dataset/issued-building-permits/
- Table styled with inline CSS (email clients often ignore `<style>`).
  Horizontal scroll acceptable; key fields (value, address, applicant,
  description) emphasized.

## Env vars

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GMAIL_USER` (mfweggemans@gmail.com), `GMAIL_APP_PASSWORD`
- `ALERT_FROM_EMAIL` (`"Matthijs Weggemans" <mfweggemans@gmail.com>`)
- `ANTHROPIC_API_KEY` (AI enrichment; enrichment degrades gracefully if unset)
- `CRON_SECRET`
- `TEST_EMAIL` (dryRun target)

## Testing

- Manual trigger via `?dryRun=true`: fetches and renders the email HTML,
  returns the HTML in the response, and optionally sends only to `TEST_EMAIL`.
  Does NOT write to `notified_permits`.
- Auth for dryRun: `?secret=<CRON_SECRET>` accepted in addition to the Bearer
  header.
- dryRun enriches by default (so the preview matches a real send); pass
  `?enrich=false` to skip the Anthropic calls for fast, cheap iteration on
  layout.

## Do NOT

- Do not use the Supabase CLI for migrations — use the MCP / SQL editor.
- Do not hardcode recipient emails.
- Do not send duplicate notifications for the same permit number.
