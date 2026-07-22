# Design Spec: Vancouver Building Permit Alerts (Weekly Email)

**Date:** 2026-07-21
**Status:** Approved (pending spec review)

## Goal

A small TypeScript project that sends a weekly email summarizing newly issued
City of Vancouver building permits with a construction value of CAD
$20,000,000 or higher. Each new permit is researched and summarized by an AI
model into a newsletter-style write-up for a real estate developer. Designed
to be extended later with more data sources (rezoning applications,
development permits, other municipalities).

## Hosting & scheduling

**GitHub Actions scheduled workflow** — not Vercel/Next.js. The whole
pipeline is a Node/TypeScript script run on a weekly cron by GitHub Actions
(free tier; no per-run timeout, so the AI web-search enrichment can take as
long as it needs).

- Workflow: `.github/workflows/permit-alerts.yml`.
- Schedule: `cron: "0 15 * * 1"` (Mondays 15:00 UTC). GitHub schedules can
  drift/delay by minutes; acceptable for a weekly email.
- Manual runs via `workflow_dispatch`, with inputs `dry_run` (boolean) and
  `enrich` (boolean) for testing.
- **Keepalive note:** GitHub disables scheduled workflows after 60 days with
  no repo activity. Mitigate with occasional commits or a tiny scheduled
  keepalive; documented in the repo README.
- Runner: `ubuntu-latest`, Node 20, run via `tsx` (no build step needed).

## Decisions

- **Email delivery: Gmail SMTP via Nodemailer.** From address is
  `"Matthijs Weggemans" <mfweggemans@gmail.com>` (Gmail SMTP requires the From
  to match the authenticated account; only the display name is custom).
  Requires a Google App Password (2-Step Verification enabled).
- **No backfill.** Always a strict 7-day window. Only send an email when there
  is genuinely new information in the last 7 days; otherwise exit silently.
- **Supabase: new project**, created and configured via the Supabase MCP.
- **Initial recipient:** `mweggemans@cressey.com` (seeded active).
- **AI enrichment.** Each new permit is researched and summarized by
  **Claude Sonnet 5** (chosen over Opus to save credits) with the server-side
  web search tool, producing a newsletter-style write-up aimed at a real
  estate developer (what the project is — tower / community centre / etc. —
  location, construction value, developer/applicant, and any renderings or
  article links Claude finds). The email leads with these summaries, followed
  by the full technical data table.

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

## Pipeline (the script's `main()`)

1. Determine flags from `workflow_dispatch` inputs / env: `DRY_RUN`, `ENRICH`.
2. Loop over a `SOURCES` array of source functions. For each source, fetch its
   data (last 7 days, `projectvalue >= 20,000,000`), paginated via `offset`,
   normalized into `PermitRecord[]`.
3. Dedup: query `notified_permits` for permit numbers already sent (keyed on
   `permit_number` + `source`); filter those out.
4. If nothing new across all sources: log to console and exit 0 silently, send
   no email.
5. **Enrich** each new permit via `enrichPermits()` (Sonnet 5 + web search) →
   a per-permit newsletter HTML block. A per-permit failure (or a missing
   `ANTHROPIC_API_KEY`, or `ENRICH=false`) falls back to a basic block built
   from the permit fields, so the email still sends.
6. Render an inline-CSS HTML email with (a) the newsletter section — one
   summary block per permit — followed by (b) a table (one row per permit, all
   non-geometry fields as columns; `projectvalue` formatted as
   `$XX,XXX,XXX CAD`; dates formatted as `YYYY-MM-DD`).
7. Send via Gmail SMTP as **individual sends** — one message per active
   recipient in `alert_recipients` where `active=true`. Isolates per-recipient
   failures; recipients don't see each other.
8. Insert the sent permit numbers into `notified_permits` — only after a
   successful send, and **never** when `DRY_RUN` is set.

## Files

- `lib/types.ts` — `PermitRecord`, `EnrichedPermit` (= `PermitRecord & { summaryHtml: string }`), `PermitSource`.
- `lib/sources/cov-building-permits.ts` — `fetchCovBuildingPermits(days: number): Promise<PermitRecord[]>`.
- `lib/sources/index.ts` — `SOURCES` array of source descriptors/functions.
- `lib/enrich.ts` — Anthropic client + `enrichPermits(records): Promise<EnrichedPermit[]>` (Sonnet 5, adaptive thinking, `web_search_20260209`).
- `lib/email.ts` — Nodemailer Gmail transport, `renderPermitEmail()`, `sendEmail()`.
- `lib/supabase.ts` — service-role Supabase client.
- `src/run.ts` — orchestrator `main()` (the pipeline above); the workflow's entry point via `tsx src/run.ts`.
- `.github/workflows/permit-alerts.yml` — weekly cron + `workflow_dispatch`.
- `package.json`, `tsconfig.json`, `README.md`.

## Normalized type (extensibility)

`PermitRecord` in `lib/types.ts` is the shared shape all sources map into, so
future sources (rezoning, development permits, other cities) reuse the dedup +
enrichment + email pipeline. Adding a source later = one new file in
`lib/sources/` + one entry in the `SOURCES` array.

`PermitRecord` fields:
- `source: string` (e.g. `'cov-issued-building-permits'`)
- `permitNumber: string`
- `projectValue: number`
- `issueDate: string` (YYYY-MM-DD)
- `address: string | null`
- `raw: Record<string, unknown>` — all original non-geometry fields, so the
  email table can render every field without the type enumerating each one.

The email renderer iterates `raw` (minus geometry keys) for table columns; the
typed fields drive dedup, the `notified_permits` insert, and the enrichment
prompt.

## AI enrichment

`lib/enrich.ts` exports `enrichPermits(records: PermitRecord[]): Promise<EnrichedPermit[]>`.

- SDK: `@anthropic-ai/sdk`. Model: `claude-sonnet-5` (ample for weekly
  summarization; cheaper than Opus). Adaptive thinking
  (`thinking: { type: "adaptive" }`). Server-side web search tool
  (`web_search_20260209`) so Claude can research each project.
- One streamed API call per permit (streaming avoids HTTP timeouts on
  web-search + thinking); collect via `.finalMessage()`. No GitHub Actions
  timeout pressure, so permits can be enriched sequentially (simplest) or with
  light concurrency.
- Prompt: system role = a newsletter writer briefing a Vancouver real estate
  developer; user message = the permit's fields. Claude is instructed to
  search the web for the project (name, developer, what's being built,
  renderings/coverage) and return a self-contained inline-CSS HTML block
  following a fixed template (headline, 2–3 sentence summary, key-facts list,
  any links found). Links are only included when Claude actually finds them —
  no fabricated URLs.
- Graceful degradation: on any per-permit API error, when `ANTHROPIC_API_KEY`
  is unset, or when `ENRICH=false`, `summaryHtml` falls back to a basic block
  rendered from the permit fields. The email always sends.

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
  block per permit), then the **technical table**, then a footer linking to
  the dataset page:
  https://opendata.vancouver.ca/explore/dataset/issued-building-permits/
- Table styled with inline CSS (email clients often ignore `<style>`).
  Horizontal scroll acceptable; key fields (value, address, applicant,
  description) emphasized.

## Secrets / env vars (GitHub Actions secrets)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GMAIL_USER` (mfweggemans@gmail.com), `GMAIL_APP_PASSWORD`
- `ALERT_FROM_EMAIL` (`"Matthijs Weggemans" <mfweggemans@gmail.com>`)
- `ANTHROPIC_API_KEY` (AI enrichment; enrichment degrades gracefully if unset)
- `TEST_EMAIL` (dry-run target)

No `CRON_SECRET` — there is no public HTTP endpoint to protect.

## Testing / dry run

- Local run: `tsx src/run.ts` with the env vars set (e.g. via a local
  `.env` that is git-ignored).
- `DRY_RUN=true`: fetch, dedup, enrich, and render the email; send only to
  `TEST_EMAIL` (or write the HTML to a local file / stdout) and do **not**
  write to `notified_permits`.
- `ENRICH=false`: skip the Anthropic calls (use fallback blocks) for fast,
  cheap iteration on layout.
- Manual trigger in CI via `workflow_dispatch` with `dry_run` / `enrich`
  inputs mapped to those env vars.

## Do NOT

- Do not use the Supabase CLI for migrations — use the MCP / SQL editor.
- Do not hardcode recipient emails.
- Do not send duplicate notifications for the same permit number.
- Do not fabricate URLs in AI summaries — links only when web search finds them.
