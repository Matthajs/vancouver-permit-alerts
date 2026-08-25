# Design Spec: Supabase Keep-Alive + Historical Permit Stats

**Date:** 2026-08-13
**Status:** Approved (pending spec review)

## Goal

Two related additions to the Vancouver Building Permit Alerts project:

1. Stop the Supabase project (`vancouver-permit-alerts`,
   `mnmjarosngqjoygqwkag`) from auto-pausing due to inactivity. It currently
   only receives traffic once a week from the alert workflow, which is right
   at Supabase's free-tier 7-day inactivity threshold — the project has been
   observed paused in the dashboard.
2. Add historical stats (permit count + total value over the past
   month/quarter/year) to the bottom of the weekly alert email, using data
   already collected in `notified_permits`.

While adding the keep-alive job, also fix a second, previously-documented
but unaddressed risk: GitHub disables scheduled workflows after 60 days of
no repository activity (see README "⚠️ Keepalive" section). One job fixes
both, at near-zero extra cost.

## 1. Keep-alive workflow

New file: `.github/workflows/keepalive.yml`.

- Schedule: every 3 days (e.g. `cron: "0 12 */3 * *"`), plus
  `workflow_dispatch` for manual runs. Comfortably inside Supabase's 7-day
  pause window even accounting for GitHub's scheduling jitter.
- Permissions: `contents: write` (needed to commit the timestamp file).
- Steps:
  1. Checkout, setup Node 22 (matches `permit-alerts.yml`).
  2. `npm ci`.
  3. Run `npm run keepalive`, which executes `src/keepalive.ts`.
- Secrets: reuses existing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. No
  new secrets required.

New script: `src/keepalive.ts`.

- Imports `getSupabase()` from `lib/supabase.ts` (no changes needed there).
- Runs a trivial read, e.g. `getSupabase().from("alert_recipients").select("email").limit(1)`.
  Throws (non-zero exit) if the query errors, so a broken keep-alive is
  visible in the Actions tab rather than silently no-op'ing.
- Writes the current UTC ISO timestamp to `keepalive/last-ping.txt`
  (new directory, file is git-tracked, not gitignored).
- Does **not** commit — committing is a workflow-level step (see below),
  keeping the script itself testable/side-effect-free beyond the Supabase
  call and file write.

Workflow commit step (after running the script):

```yaml
- name: Commit keep-alive timestamp
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add keepalive/last-ping.txt
    git diff --staged --quiet || git commit -m "chore: keep-alive ping"
    git push
```

The `git diff --staged --quiet ||` guard avoids an empty commit if the
timestamp somehow didn't change (defensive; in practice it always changes).

## 2. Historical stats in the weekly email

Scope: only permits already recorded via the existing alert pipeline
(≥ CAD $20M) — i.e. everything already in `notified_permits`. No new
fetching, no new table. Time windows are **rolling**, not calendar-aligned:
trailing 30 / 90 / 365 days from the run date.

### Data layer — `lib/supabase.ts`

New function:

```ts
export interface HistoricalStats {
  label: string; // "Past 30 days" | "Past quarter" | "Past year"
  count: number;
  totalValue: number;
}

export async function getHistoricalStats(asOf: Date): Promise<HistoricalStats[]>
```

- Selects `issue_date, project_value` from `notified_permits` (single query,
  no window filter needed server-side — data volume is small enough to
  filter in memory; a $20M+ threshold means well under a few hundred rows
  per year).
- For each of the three windows (30/90/365 days back from `asOf`), filters
  rows by `issue_date` and reduces to `{ count, totalValue }`.
- Returns an array in a fixed order: 30, 90, 365 days.

### Rendering — `lib/email.ts`

`renderPermitEmail` signature gains a `stats: HistoricalStats[]` parameter.
Appends an HTML table after the existing "All fields" table:

```html
<h2>Historical stats</h2>
<table>
  <tr><th>Period</th><th>Permits</th><th>Total value</th></tr>
  <!-- one row per HistoricalStats entry, value via formatCad() -->
</table>
```

Reuses the existing `formatCad` / `escapeHtml` helpers already in the file.

### Orchestration — `src/run.ts`

- After the dedup step (fresh permits determined) and before rendering,
  call `const stats = await getHistoricalStats(new Date())`.
- Pass `stats` into `renderPermitEmail(enriched, weekOf, stats)`.
- No change to the early-exit behavior: if there are zero new permits this
  week, the run still exits before rendering/sending (existing
  `"Nothing new. Exiting silently."` path), so no stats-only email is sent
  on quiet weeks. This matches current behavior and was confirmed
  acceptable.

## Testing

- `src/keepalive.ts`: no unit test needed (thin script wrapping an existing,
  already-tested Supabase client); verify manually via
  `workflow_dispatch` once merged, and check `keepalive/last-ping.txt` +
  Supabase dashboard "last active" timestamp update.
- `getHistoricalStats`: unit test in `test/` with a fixed `asOf` date and
  mocked Supabase rows spanning inside/outside each window, asserting
  correct bucketing and summation (mirrors existing test patterns in the
  repo, e.g. mocking `getSupabase()`).
- `renderPermitEmail` stats table: extend existing render test (if present)
  or add one asserting the stats rows appear with correctly formatted
  values.

## Out of scope

- Storing/aggregating permits below the $20M threshold.
- A dashboard or on-demand query interface for historical stats (email-only
  for now).
- Upgrading Supabase to a paid plan.
