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
   - If new permits: render an inline-CSS HTML email with a table (one row per
     permit, all non-geometry fields as columns; `projectvalue` formatted as
     `$XX,XXX,XXX CAD`; dates formatted as `YYYY-MM-DD`).
   - Send via Gmail SMTP as **individual sends** — one message per active
     recipient in `alert_recipients` where `active=true`. This isolates
     per-recipient failures and keeps recipients from seeing each other.
   - Insert the sent permit numbers into `notified_permits` — only after a
     successful send, and never in dryRun mode.

## Files

- `lib/types.ts` — `PermitRecord` normalized shape + `PermitSource` type.
- `lib/sources/cov-building-permits.ts` — `fetchCovBuildingPermits(days: number): Promise<PermitRecord[]>`.
- `lib/sources/index.ts` — `SOURCES` array of source descriptors/functions.
- `lib/email.ts` — Nodemailer Gmail transport, `renderPermitEmail()`, `sendEmail()`.
- `lib/supabase.ts` — service-role Supabase client.
- `app/api/cron/permit-alerts/route.ts` — orchestrator route handler.
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
- Body: short intro line, then the table, then a footer linking to the
  dataset page: https://opendata.vancouver.ca/explore/dataset/issued-building-permits/
- Table styled with inline CSS (email clients often ignore `<style>`).
  Horizontal scroll acceptable; key fields (value, address, applicant,
  description) emphasized.

## Env vars

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GMAIL_USER` (mfweggemans@gmail.com), `GMAIL_APP_PASSWORD`
- `ALERT_FROM_EMAIL` (`"Matthijs Weggemans" <mfweggemans@gmail.com>`)
- `CRON_SECRET`
- `TEST_EMAIL` (dryRun target)

## Testing

- Manual trigger via `?dryRun=true`: fetches and renders the email HTML,
  returns the HTML in the response, and optionally sends only to `TEST_EMAIL`.
  Does NOT write to `notified_permits`.
- Auth for dryRun: `?secret=<CRON_SECRET>` accepted in addition to the Bearer
  header.

## Do NOT

- Do not use the Supabase CLI for migrations — use the MCP / SQL editor.
- Do not hardcode recipient emails.
- Do not send duplicate notifications for the same permit number.
