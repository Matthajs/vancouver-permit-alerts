# Supabase Keep-Alive + Historical Permit Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Supabase project from auto-pausing on its weekly-only traffic pattern, fix the related GitHub 60-day scheduled-workflow dormancy risk in the same job, and add rolling 30/90/365-day permit count + value stats to the bottom of the weekly alert email.

**Architecture:** A new `keepalive.yml` GitHub Actions workflow runs every 3 days, executing `src/keepalive.ts` (a trivial Supabase read) and committing a timestamp file back to the repo. Separately, `lib/supabase.ts` gains a pure bucketing function plus a thin fetch wrapper that computes historical stats from the existing `notified_permits` table; `lib/email.ts` renders those stats as a new table in the email; `src/run.ts` wires the two together.

**Tech Stack:** TypeScript (ESM, `tsx` runner), Vitest, `@supabase/supabase-js`, GitHub Actions.

## Global Constraints

- Node 22, matching the existing `permit-alerts.yml` workflow.
- No new secrets — reuse `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
- Historical stats cover only permits already in `notified_permits` (≥ CAD $20M) — no new fetching, no new table.
- Time windows are rolling (trailing 30/90/365 days from the run date), not calendar-aligned.
- Follow the existing codebase convention: separate pure/testable logic from functions that call Supabase; only pure functions get Vitest unit tests (see `lib/sources/cov-building-permits.ts` and `test/cov-source.test.ts` for the pattern).
- Spec: `docs/superpowers/specs/2026-08-13-keepalive-and-historical-stats-design.md`.

---

### Task 1: Historical stats data layer

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/supabase.ts`
- Test: `test/supabase.test.ts`

**Interfaces:**
- Consumes: `getSupabase()` from `lib/supabase.ts` (existing).
- Produces:
  - `HistoricalStats` type (in `lib/types.ts`): `{ label: string; days: number; count: number; totalValue: number }`.
  - `HistoricalStatRow` type (in `lib/supabase.ts`): `{ issue_date: string; project_value: number }`.
  - `bucketHistoricalStats(rows: HistoricalStatRow[], asOf: Date): HistoricalStats[]` (pure, exported from `lib/supabase.ts`).
  - `getHistoricalStats(asOf: Date): Promise<HistoricalStats[]>` (exported from `lib/supabase.ts`, used by Task 4).

- [ ] **Step 1: Add the `HistoricalStats` type**

Append to `lib/types.ts`:

```ts
export interface HistoricalStats {
  label: string;
  days: number;
  count: number;
  totalValue: number;
}
```

- [ ] **Step 2: Write the failing test for `bucketHistoricalStats`**

Add to `test/supabase.test.ts` (new `describe` block, keep the existing `filterNewPermits` block as-is):

```ts
import { filterNewPermits, bucketHistoricalStats } from "../lib/supabase";
import type { HistoricalStatRow } from "../lib/supabase";

describe("bucketHistoricalStats", () => {
  const asOf = new Date("2026-08-13T12:00:00Z");

  const rows: HistoricalStatRow[] = [
    { issue_date: "2026-08-10", project_value: 20_000_000 }, // 3 days ago -> in all windows
    { issue_date: "2026-07-20", project_value: 25_000_000 }, // 24 days ago -> in all windows
    { issue_date: "2026-06-01", project_value: 30_000_000 }, // 73 days ago -> in 90d & 365d only
    { issue_date: "2026-01-01", project_value: 40_000_000 }, // 224 days ago -> in 365d only
    { issue_date: "2024-01-01", project_value: 50_000_000 }, // >365 days ago -> in none
  ];

  it("returns three windows in order: 30, 90, 365 days", () => {
    const stats = bucketHistoricalStats(rows, asOf);
    expect(stats.map((s) => s.days)).toEqual([30, 90, 365]);
    expect(stats.map((s) => s.label)).toEqual([
      "Past 30 days",
      "Past quarter",
      "Past year",
    ]);
  });

  it("buckets rows into the correct windows by count", () => {
    const stats = bucketHistoricalStats(rows, asOf);
    const byDays = Object.fromEntries(stats.map((s) => [s.days, s]));
    expect(byDays[30].count).toBe(2);
    expect(byDays[90].count).toBe(3);
    expect(byDays[365].count).toBe(4);
  });

  it("sums project value within each window", () => {
    const stats = bucketHistoricalStats(rows, asOf);
    const byDays = Object.fromEntries(stats.map((s) => [s.days, s]));
    expect(byDays[30].totalValue).toBe(45_000_000);
    expect(byDays[90].totalValue).toBe(75_000_000);
    expect(byDays[365].totalValue).toBe(115_000_000);
  });

  it("returns zeroed stats for an empty input", () => {
    const stats = bucketHistoricalStats([], asOf);
    expect(stats.every((s) => s.count === 0 && s.totalValue === 0)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/supabase.test.ts`
Expected: FAIL with `bucketHistoricalStats is not a function` (or similar import error) — the function doesn't exist yet.

- [ ] **Step 4: Implement `bucketHistoricalStats` and `getHistoricalStats`**

Add to `lib/supabase.ts` (below the existing `getSupabase` export, above or below the other functions — keep `HistoricalStatRow`/`bucketHistoricalStats`/`getHistoricalStats` together as one block):

```ts
import type { HistoricalStats } from "./types";

export interface HistoricalStatRow {
  issue_date: string;
  project_value: number;
}

const STATS_WINDOWS: { label: string; days: number }[] = [
  { label: "Past 30 days", days: 30 },
  { label: "Past quarter", days: 90 },
  { label: "Past year", days: 365 },
];

export function bucketHistoricalStats(
  rows: HistoricalStatRow[],
  asOf: Date,
): HistoricalStats[] {
  return STATS_WINDOWS.map(({ label, days }) => {
    const cutoffIso = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const inWindow = rows.filter((r) => r.issue_date >= cutoffIso);
    return {
      label,
      days,
      count: inWindow.length,
      totalValue: inWindow.reduce((sum, r) => sum + r.project_value, 0),
    };
  });
}

export async function getHistoricalStats(asOf: Date): Promise<HistoricalStats[]> {
  const { data, error } = await getSupabase()
    .from("notified_permits")
    .select("issue_date, project_value");
  if (error) throw new Error(`Supabase stats select failed: ${error.message}`);
  return bucketHistoricalStats((data ?? []) as HistoricalStatRow[], asOf);
}
```

Note: `lib/supabase.ts` already imports `PermitRecord` from `./types` at the top — add `HistoricalStats` to that same `import type` line rather than a second import statement.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/supabase.test.ts`
Expected: PASS, all `bucketHistoricalStats` and `filterNewPermits` tests green.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts lib/supabase.ts test/supabase.test.ts
git commit -m "feat: add historical permit stats bucketing"
```

---

### Task 2: Render historical stats in the email

**Files:**
- Modify: `lib/email.ts`
- Test: `test/email.test.ts`

**Interfaces:**
- Consumes: `HistoricalStats` type from `lib/types.ts` (Task 1). `formatCad`, `escapeHtml` (existing, in this same file).
- Produces: `renderPermitEmail(permits: EnrichedPermit[], weekOf: string, stats: HistoricalStats[]): { subject: string; html: string }` — signature change (adds required third parameter), used by Task 3.

- [ ] **Step 1: Write the failing test**

Update `test/email.test.ts`: add `HistoricalStats` import and a `stats` fixture, update existing calls to pass it, and add a new assertion block.

```ts
import { describe, it, expect } from "vitest";
import { formatCad, renderPermitEmail } from "../lib/email";
import type { EnrichedPermit, HistoricalStats } from "../lib/types";

const permit: EnrichedPermit = {
  source: "cov-issued-building-permits",
  permitNumber: "BP-2026-001",
  projectValue: 25000000,
  issueDate: "2026-07-20",
  address: "500 Granville St",
  raw: { permitnumber: "BP-2026-001", projectvalue: 25000000, address: "500 Granville St" },
  summaryHtml: "<div class='block'>A shiny tower</div>",
};

const stats: HistoricalStats[] = [
  { label: "Past 30 days", days: 30, count: 1, totalValue: 25_000_000 },
  { label: "Past quarter", days: 90, count: 2, totalValue: 50_000_000 },
  { label: "Past year", days: 365, count: 5, totalValue: 150_000_000 },
];

describe("email rendering", () => {
  it("formats CAD without decimals", () => {
    expect(formatCad(25000000)).toBe("$25,000,000 CAD");
  });

  it("subject includes count and week", () => {
    const { subject } = renderPermitEmail([permit], "2026-07-21", stats);
    expect(subject).toContain("1 new permit");
    expect(subject).toContain("2026-07-21");
  });

  it("html contains the newsletter block, the formatted value, and the address", () => {
    const { html } = renderPermitEmail([permit], "2026-07-21", stats);
    expect(html).toContain("A shiny tower");
    expect(html).toContain("$25,000,000 CAD");
    expect(html).toContain("500 Granville St");
    expect(html).toContain("issued-building-permits"); // dataset footer link
  });

  it("html contains a historical stats table with all three windows", () => {
    const { html } = renderPermitEmail([permit], "2026-07-21", stats);
    expect(html).toContain("Past 30 days");
    expect(html).toContain("Past quarter");
    expect(html).toContain("Past year");
    expect(html).toContain("$150,000,000 CAD");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/email.test.ts`
Expected: FAIL — TypeScript error (missing 3rd argument) or the new "historical stats table" assertion fails since the table doesn't exist yet.

- [ ] **Step 3: Implement the stats table in `renderPermitEmail`**

In `lib/email.ts`, change the function signature and add the table. Full replacement of `renderPermitEmail`:

```ts
import type { EnrichedPermit, HistoricalStats } from "./types";

export function renderPermitEmail(
  permits: EnrichedPermit[],
  weekOf: string,
  stats: HistoricalStats[],
): { subject: string; html: string } {
  const n = permits.length;
  const subject = `Vancouver Permits $20M+ — Week of ${weekOf}: ${n} new permit${n === 1 ? "" : "s"}`;

  const newsletter = permits.map((p) => p.summaryHtml).join("\n");

  const cols = tableColumns(permits);
  const thead =
    "<tr>" +
    cols.map((c) => `<th style="text-align:left;border:1px solid #ddd;padding:6px;background:#f4f1ea;">${escapeHtml(c)}</th>`).join("") +
    "</tr>";
  const rows = permits
    .map(
      (p) =>
        "<tr>" +
        cols.map((c) => `<td style="border:1px solid #ddd;padding:6px;vertical-align:top;">${cell(c, p.raw[c])}</td>`).join("") +
        "</tr>",
    )
    .join("");

  const statsThead =
    '<tr><th style="text-align:left;border:1px solid #ddd;padding:6px;background:#f4f1ea;">Period</th>' +
    '<th style="text-align:left;border:1px solid #ddd;padding:6px;background:#f4f1ea;">Permits</th>' +
    '<th style="text-align:left;border:1px solid #ddd;padding:6px;background:#f4f1ea;">Total value</th></tr>';
  const statsRows = stats
    .map(
      (s) =>
        `<tr><td style="border:1px solid #ddd;padding:6px;">${escapeHtml(s.label)}</td>` +
        `<td style="border:1px solid #ddd;padding:6px;">${s.count}</td>` +
        `<td style="border:1px solid #ddd;padding:6px;">${formatCad(s.totalValue)}</td></tr>`,
    )
    .join("");

  const html = `<div style="font-family:Georgia,serif;color:#222;max-width:100%;">
  <p>${n} new City of Vancouver building permit${n === 1 ? "" : "s"} of $20M+ issued in the last 7 days (week of ${escapeHtml(weekOf)}).</p>
  <h2 style="font-family:Georgia,serif;">This week's projects</h2>
  ${newsletter}
  <h2 style="font-family:Georgia,serif;">All fields</h2>
  <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <h2 style="font-family:Georgia,serif;">Historical stats ($20M+ permits)</h2>
  <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">
    <thead>${statsThead}</thead>
    <tbody>${statsRows}</tbody>
  </table>
  <p style="font-size:12px;color:#666;margin-top:16px;">Source: <a href="${DATASET_URL}">City of Vancouver — Issued Building Permits</a></p>
</div>`;

  return { subject, html };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/email.test.ts`
Expected: PASS, all assertions green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts test/email.test.ts
git commit -m "feat: render historical stats table in weekly email"
```

---

### Task 3: Wire historical stats into the run pipeline

**Files:**
- Modify: `src/run.ts`

**Interfaces:**
- Consumes: `getHistoricalStats(asOf: Date): Promise<HistoricalStats[]>` (Task 1), `renderPermitEmail(permits, weekOf, stats)` (Task 2).
- Produces: nothing consumed by later tasks — this is the integration point.

- [ ] **Step 1: Add the import**

In `src/run.ts`, update the existing import block:

```ts
import {
  getNotifiedPermitNumbers,
  filterNewPermits,
  recordNotified,
  getActiveRecipients,
  getHistoricalStats,
} from "../lib/supabase";
```

- [ ] **Step 2: Compute stats and pass them into rendering**

Replace:

```ts
  // 4. Render.
  const { subject, html } = renderPermitEmail(enriched, weekOf);
```

with:

```ts
  // 4. Render.
  const stats = await getHistoricalStats(new Date());
  const { subject, html } = renderPermitEmail(enriched, weekOf, stats);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual dry-run verification**

This step requires a working `.env` with real `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (see README setup). If not available in this environment, note that and defer to the user.

Run: `DRY_RUN=true npm start`
Expected: exits 0, writes `dry-run-preview.html`. Open it (or `grep` it) and confirm it contains `Historical stats` and the three period labels.

Run: `grep -o 'Historical stats.*Total value' dry-run-preview.html | head -c 300`
Expected: non-empty output showing the new section header and table headers.

- [ ] **Step 5: Commit**

```bash
git add src/run.ts
git commit -m "feat: wire historical stats into weekly run"
```

---

### Task 4: Keep-alive script

**Files:**
- Create: `src/keepalive.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getSupabase()` from `lib/supabase.ts` (existing, unchanged).
- Produces: `keepalive/last-ping.txt` file on disk (consumed by Task 5's workflow commit step, not by any TS code).

- [ ] **Step 1: Write `src/keepalive.ts`**

```ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getSupabase } from "../lib/supabase";

async function main(): Promise<void> {
  const { error } = await getSupabase()
    .from("alert_recipients")
    .select("email")
    .limit(1);
  if (error) throw new Error(`Supabase keep-alive query failed: ${error.message}`);

  const dir = path.join(process.cwd(), "keepalive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "last-ping.txt"), new Date().toISOString() + "\n");
  console.log("Keep-alive ping succeeded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"` (alongside the existing `start` and `test`):

```json
"keepalive": "tsx src/keepalive.ts"
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

This step requires a working `.env` with real Supabase credentials. If not available in this environment, note that and defer to the user.

Run: `npm run keepalive`
Expected: prints `Keep-alive ping succeeded.`, exits 0, and creates `keepalive/last-ping.txt` containing an ISO timestamp.

Run: `cat keepalive/last-ping.txt`
Expected: a single line like `2026-08-13T18:05:00.000Z`.

- [ ] **Step 5: Commit**

```bash
git add src/keepalive.ts package.json keepalive/last-ping.txt
git commit -m "feat: add Supabase keep-alive script"
```

(If Step 4 couldn't run for lack of credentials, still commit `src/keepalive.ts` and `package.json`; create `keepalive/last-ping.txt` by hand with a placeholder ISO timestamp so the directory exists in the repo, e.g. `mkdir -p keepalive && date -u +%Y-%m-%dT%H:%M:%S.000Z > keepalive/last-ping.txt`, and commit it too — the first real workflow run will overwrite it.)

---

### Task 5: Keep-alive GitHub Actions workflow

**Files:**
- Create: `.github/workflows/keepalive.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `npm run keepalive` (Task 4).
- Produces: nothing consumed by other tasks — this is the final integration point, deployed by merge.

- [ ] **Step 1: Write the workflow file**

```yaml
name: Supabase Keep-Alive

on:
  schedule:
    - cron: "0 12 */3 * *" # Every 3 days at 12:00 UTC
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  ping:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - name: Ping Supabase and write timestamp
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: npm run keepalive
      - name: Commit keep-alive timestamp
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add keepalive/last-ping.txt
          git diff --staged --quiet || git commit -m "chore: keep-alive ping"
          git push
```

- [ ] **Step 2: Update the README**

Replace the existing `## ⚠️ Keepalive` section:

```markdown
## ⚠️ Keepalive
GitHub disables scheduled workflows after **60 days of no repo activity**. Push
a commit occasionally, or the weekly email will silently stop until you
re-enable the workflow in the Actions tab.
```

with:

```markdown
## Keep-alive
`.github/workflows/keepalive.yml` runs every 3 days: it pings Supabase (a
trivial read) so the free-tier project doesn't auto-pause after 7 days of
inactivity, and commits a timestamp to `keepalive/last-ping.txt`, which also
resets GitHub's 60-day scheduled-workflow dormancy clock. No action needed
unless both this workflow and `permit-alerts.yml` stop running — check the
Actions tab in that case.
```

Also add a short mention of the new email content under "How it works" — change:

```markdown
### How it works
`src/run.ts` → fetch (`lib/sources`) → dedup (Supabase `notified_permits`) →
enrich (`lib/enrich`, Sonnet 5 + web search) → render + send (`lib/email`,
Gmail SMTP) → record sent permits. See `docs/superpowers/specs/` for the design.
```

to:

```markdown
### How it works
`src/run.ts` → fetch (`lib/sources`) → dedup (Supabase `notified_permits`) →
enrich (`lib/enrich`, Sonnet 5 + web search) → render + send (`lib/email`,
Gmail SMTP, includes a rolling 30/90/365-day stats table) → record sent
permits. See `docs/superpowers/specs/` for the design.
```

- [ ] **Step 3: Validate YAML syntax**

Run: `npx -y js-yaml .github/workflows/keepalive.yml`
Expected: prints the parsed YAML back out (or valid JSON-ish structure) with no error. (`js-yaml` is a zero-config way to catch YAML syntax mistakes without needing `actionlint` installed.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/keepalive.yml README.md
git commit -m "ci: add Supabase keep-alive workflow"
```

- [ ] **Step 5: Full verification pass**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

Note in the final report to the user: the `keepalive.yml` schedule can only be truly verified by pushing to GitHub and either waiting for the cron or triggering it manually via **Actions → Supabase Keep-Alive → Run workflow**. Recommend the user do a manual `workflow_dispatch` run right after merging to confirm the Supabase dashboard's "last active" timestamp updates and `keepalive/last-ping.txt` gets committed.

---

## Self-Review Notes

- **Spec coverage:** Keep-alive workflow (§1) → Tasks 4–5. Historical stats data layer (§2 data layer) → Task 1. Rendering (§2 rendering) → Task 2. Orchestration (§2 orchestration) → Task 3. Bonus GitHub dormancy fix → folded into Task 5 (commit step + README). Testing section's guidance (pure-function tests only, manual verification for Supabase-touching code) → reflected in every task's test/verification steps.
- **Type consistency:** `HistoricalStats` defined once in `lib/types.ts` (Task 1), imported by `lib/supabase.ts` (Task 1) and `lib/email.ts` (Task 2) — no duplicate/divergent definitions. `renderPermitEmail`'s new third parameter name (`stats`) and type (`HistoricalStats[]`) match between Task 2's implementation and Task 3's call site.
- **Placeholder scan:** no TBD/TODO; all code blocks are complete and copy-pasteable; manual-verification steps that depend on real credentials explicitly say what to do if credentials aren't available in the execution environment, rather than silently skipping.
