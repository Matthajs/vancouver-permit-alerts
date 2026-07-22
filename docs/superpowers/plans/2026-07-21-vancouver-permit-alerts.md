# Vancouver Building Permit Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly TypeScript job, run by GitHub Actions, that finds newly issued City of Vancouver building permits ≥ CAD $20M, has Claude Sonnet 5 research and summarize each into a newsletter, and emails the result via Gmail.

**Architecture:** A plain Node/TypeScript project (no web framework). `src/run.ts` orchestrates a pipeline: fetch from a pluggable `SOURCES` array → dedup against a Supabase table → enrich each new permit with Claude Sonnet 5 + web search → render an HTML email (newsletter section + data table) → send via Gmail SMTP → record what was sent. A GitHub Actions cron runs it weekly.

**Tech Stack:** TypeScript, `tsx` (run TS directly, no build), `vitest` (tests), `@anthropic-ai/sdk`, `@supabase/supabase-js`, `nodemailer`, `dotenv`. GitHub Actions for scheduling. Supabase (Postgres) for state.

## Global Constraints

- Language: TypeScript, ESM (`"type": "module"` in package.json). Node 20.
- Model: `claude-sonnet-5` only. Adaptive thinking (`thinking: { type: "adaptive" }`). Web search tool `web_search_20260209` (name `web_search`). Stream requests and collect via `.finalMessage()`.
- Email From: `"Matthijs Weggemans" <mfweggemans@gmail.com>` (via `ALERT_FROM_EMAIL`). Gmail SMTP `smtp.gmail.com:465` SSL, auth `GMAIL_USER` + `GMAIL_APP_PASSWORD`.
- Permit threshold: `projectvalue >= 20000000`. Window: strict 7 days. No backfill.
- Only send when there is ≥1 new permit; otherwise exit 0 silently.
- Value format: `$XX,XXX,XXX CAD` (no decimals). Date format: `YYYY-MM-DD`.
- Dedup key: `permitNumber` (matches `notified_permits` primary key).
- Never write to `notified_permits` when `DRY_RUN=true`.
- Never fabricate URLs in AI summaries — links only when web search finds them.
- Secrets come from env vars only; never hardcode. Never commit `.env`.
- Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ALERT_FROM_EMAIL`, `ANTHROPIC_API_KEY`, `TEST_EMAIL`, plus flags `DRY_RUN`, `ENRICH`.

---

## File map

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example` — scaffold.
- `lib/types.ts` — `PermitRecord`, `EnrichedPermit`, `PermitSource`.
- `lib/sources/cov-building-permits.ts` — CoV fetch + normalize + source object.
- `lib/sources/index.ts` — `SOURCES` array.
- `lib/supabase.ts` — client, dedup query, `filterNewPermits`, insert, recipients.
- `lib/email.ts` — formatting, `renderPermitEmail`, transport, `sendEmail`.
- `lib/enrich.ts` — `fallbackSummaryHtml`, prompt, `extractHtml`, `enrichPermits`.
- `src/run.ts` — orchestrator `main()`.
- `.github/workflows/permit-alerts.yml` — weekly cron + manual dispatch.
- `README.md` — setup + secrets + keepalive note.
- Test files colocated under `test/`.

---

### Task 1: Project scaffold + shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `lib/types.ts`, `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PermitRecord { source: string; permitNumber: string; projectValue: number; issueDate: string; address: string | null; raw: Record<string, unknown> }`
  - `EnrichedPermit = PermitRecord & { summaryHtml: string }`
  - `PermitSource { id: string; label: string; fetch: (days: number) => Promise<PermitRecord[]> }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "vancouver-permit-alerts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/run.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.0",
    "nodemailer": "^6.9.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/nodemailer": "^6.4.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["lib", "src", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
.env
dry-run-preview.html
out/
```

- [ ] **Step 5: Create `.env.example`**

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GMAIL_USER=mfweggemans@gmail.com
GMAIL_APP_PASSWORD=
ALERT_FROM_EMAIL="Matthijs Weggemans" <mfweggemans@gmail.com>
ANTHROPIC_API_KEY=
TEST_EMAIL=
# flags
DRY_RUN=false
ENRICH=true
```

- [ ] **Step 6: Create `lib/types.ts`**

```ts
export interface PermitRecord {
  source: string;
  permitNumber: string;
  projectValue: number;
  issueDate: string; // YYYY-MM-DD
  address: string | null;
  raw: Record<string, unknown>;
}

export type EnrichedPermit = PermitRecord & { summaryHtml: string };

export interface PermitSource {
  id: string;
  label: string;
  fetch: (days: number) => Promise<PermitRecord[]>;
}
```

- [ ] **Step 7: Write the failing test `test/types.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { PermitRecord, EnrichedPermit } from "../lib/types";

describe("types", () => {
  it("constructs a PermitRecord and EnrichedPermit", () => {
    const r: PermitRecord = {
      source: "cov-issued-building-permits",
      permitNumber: "BP-123",
      projectValue: 25000000,
      issueDate: "2026-07-20",
      address: "123 Main St",
      raw: { permitnumber: "BP-123" },
    };
    const e: EnrichedPermit = { ...r, summaryHtml: "<div>hi</div>" };
    expect(e.summaryHtml).toContain("hi");
    expect(e.permitNumber).toBe("BP-123");
  });
});
```

- [ ] **Step 8: Install deps and run test**

Run: `npm install && npx vitest run test/types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold TS project and shared types"
```

---

### Task 2: City of Vancouver source (fetch + normalize)

**Files:**
- Create: `lib/sources/cov-building-permits.ts`, `lib/sources/index.ts`, `test/cov-source.test.ts`

**Interfaces:**
- Consumes: `PermitRecord`, `PermitSource` from `lib/types`.
- Produces:
  - `COV_SOURCE_ID = "cov-issued-building-permits"`
  - `isoDaysAgo(days: number, now?: Date): string`
  - `buildCovUrl(days: number, offset: number, now?: Date): string`
  - `normalizeCovRecord(raw: Record<string, unknown>): PermitRecord`
  - `fetchCovBuildingPermits(days: number): Promise<PermitRecord[]>`
  - `covBuildingPermitsSource: PermitSource`
  - `SOURCES: PermitSource[]` (from `lib/sources/index.ts`)

- [ ] **Step 1: Verify the live API field names (one-time check)**

Run:
```bash
npx tsx -e "fetch('https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/issued-building-permits/records?limit=1').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.results[0],null,2)))"
```
Expected: one record printed. Confirm these keys exist (v2.1 returns flat records under `results`): `permitnumber`, `projectvalue`, `issuedate`, `address`, and geometry keys `geom` / `geo_point_2d`. If a key differs, adjust the field names in Step 4 accordingly before implementing.

- [ ] **Step 2: Write failing tests `test/cov-source.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  isoDaysAgo,
  buildCovUrl,
  normalizeCovRecord,
  COV_SOURCE_ID,
} from "../lib/sources/cov-building-permits";

describe("cov source pure helpers", () => {
  it("isoDaysAgo returns a YYYY-MM-DD date N days before now", () => {
    const now = new Date("2026-07-21T15:00:00Z");
    expect(isoDaysAgo(7, now)).toBe("2026-07-14");
  });

  it("buildCovUrl encodes the where clause and paging", () => {
    const now = new Date("2026-07-21T15:00:00Z");
    const url = buildCovUrl(7, 100, now);
    expect(url).toContain("projectvalue%3E%3D20000000");
    expect(url).toContain("issuedate%3E%3Ddate%272026-07-14%27");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=100");
    expect(url).toContain("order_by=issuedate%20desc");
  });

  it("normalizeCovRecord maps fields and strips geometry from raw", () => {
    const raw = {
      permitnumber: "BP-2026-001",
      projectvalue: 30000000,
      issuedate: "2026-07-20",
      address: "500 Granville St",
      typeofwork: "New Building",
      geom: { type: "Point" },
      geo_point_2d: { lon: -123, lat: 49 },
    };
    const r = normalizeCovRecord(raw);
    expect(r.source).toBe(COV_SOURCE_ID);
    expect(r.permitNumber).toBe("BP-2026-001");
    expect(r.projectValue).toBe(30000000);
    expect(r.issueDate).toBe("2026-07-20");
    expect(r.address).toBe("500 Granville St");
    expect(r.raw.geom).toBeUndefined();
    expect(r.raw.geo_point_2d).toBeUndefined();
    expect(r.raw.typeofwork).toBe("New Building");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/cov-source.test.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 4: Implement `lib/sources/cov-building-permits.ts`**

```ts
import type { PermitRecord, PermitSource } from "../types";

export const COV_SOURCE_ID = "cov-issued-building-permits";

const BASE =
  "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/issued-building-permits/records";
const GEOMETRY_KEYS = ["geom", "geo_point_2d"];
const MIN_VALUE = 20_000_000;
const PAGE = 100;

export function isoDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function buildCovUrl(days: number, offset: number, now: Date = new Date()): string {
  const since = isoDaysAgo(days, now);
  const where = `projectvalue>=${MIN_VALUE} AND issuedate>=date'${since}'`;
  const params = new URLSearchParams({
    where,
    order_by: "issuedate desc",
    limit: String(PAGE),
    offset: String(offset),
  });
  return `${BASE}?${params.toString()}`;
}

export function normalizeCovRecord(raw: Record<string, unknown>): PermitRecord {
  const clean: Record<string, unknown> = { ...raw };
  for (const k of GEOMETRY_KEYS) delete clean[k];
  const addr = raw["address"];
  return {
    source: COV_SOURCE_ID,
    permitNumber: String(raw["permitnumber"] ?? ""),
    projectValue: Number(raw["projectvalue"] ?? 0),
    issueDate: String(raw["issuedate"] ?? "").slice(0, 10),
    address: addr == null ? null : String(addr),
    raw: clean,
  };
}

export async function fetchCovBuildingPermits(days: number): Promise<PermitRecord[]> {
  const out: PermitRecord[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(buildCovUrl(days, offset));
    if (!res.ok) throw new Error(`CoV API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { results?: Record<string, unknown>[] };
    const rows = json.results ?? [];
    for (const row of rows) out.push(normalizeCovRecord(row));
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return out.filter((r) => r.permitNumber !== "");
}

export const covBuildingPermitsSource: PermitSource = {
  id: COV_SOURCE_ID,
  label: "City of Vancouver — Issued Building Permits",
  fetch: fetchCovBuildingPermits,
};
```

- [ ] **Step 5: Create `lib/sources/index.ts`**

```ts
import type { PermitSource } from "../types";
import { covBuildingPermitsSource } from "./cov-building-permits";

export const SOURCES: PermitSource[] = [covBuildingPermitsSource];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/cov-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Smoke-test the live fetch**

Run: `npx tsx -e "import('./lib/sources/cov-building-permits').then(m=>m.fetchCovBuildingPermits(30)).then(r=>console.log(r.length,'permits', r[0]?.permitNumber))"`
Expected: prints a count (may be 0–several) with no error. Confirms pagination + normalization work end to end.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: City of Vancouver building-permits source"
```

---

### Task 3: Supabase module (dedup + recipients)

**Files:**
- Create: `lib/supabase.ts`, `test/supabase.test.ts`

**Interfaces:**
- Consumes: `PermitRecord` from `lib/types`.
- Produces:
  - `getSupabase(): SupabaseClient`
  - `filterNewPermits(records: PermitRecord[], existing: Set<string>): PermitRecord[]`
  - `getNotifiedPermitNumbers(numbers: string[]): Promise<Set<string>>`
  - `recordNotified(records: PermitRecord[]): Promise<void>`
  - `getActiveRecipients(): Promise<{ email: string; name: string | null }[]>`

- [ ] **Step 1: Write failing test `test/supabase.test.ts`** (pure function only)

```ts
import { describe, it, expect } from "vitest";
import { filterNewPermits } from "../lib/supabase";
import type { PermitRecord } from "../lib/types";

const mk = (n: string): PermitRecord => ({
  source: "cov-issued-building-permits",
  permitNumber: n,
  projectValue: 20000000,
  issueDate: "2026-07-20",
  address: null,
  raw: {},
});

describe("filterNewPermits", () => {
  it("removes permits whose number is already notified", () => {
    const records = [mk("A"), mk("B"), mk("C")];
    const existing = new Set(["B"]);
    const result = filterNewPermits(records, existing);
    expect(result.map((r) => r.permitNumber)).toEqual(["A", "C"]);
  });

  it("returns all when nothing is known", () => {
    const records = [mk("A"), mk("B")];
    expect(filterNewPermits(records, new Set()).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/supabase.test.ts`
Expected: FAIL (module/function not found).

- [ ] **Step 3: Implement `lib/supabase.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PermitRecord } from "./types";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export function filterNewPermits(
  records: PermitRecord[],
  existing: Set<string>,
): PermitRecord[] {
  return records.filter((r) => !existing.has(r.permitNumber));
}

export async function getNotifiedPermitNumbers(numbers: string[]): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const { data, error } = await getSupabase()
    .from("notified_permits")
    .select("permit_number")
    .in("permit_number", numbers);
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.permit_number as string));
}

export async function recordNotified(records: PermitRecord[]): Promise<void> {
  if (records.length === 0) return;
  const rows = records.map((r) => ({
    permit_number: r.permitNumber,
    project_value: r.projectValue,
    issue_date: r.issueDate || null,
    address: r.address,
    source: r.source,
  }));
  const { error } = await getSupabase()
    .from("notified_permits")
    .upsert(rows, { onConflict: "permit_number", ignoreDuplicates: true });
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
}

export async function getActiveRecipients(): Promise<{ email: string; name: string | null }[]> {
  const { data, error } = await getSupabase()
    .from("alert_recipients")
    .select("email, name")
    .eq("active", true);
  if (error) throw new Error(`Supabase recipients failed: ${error.message}`);
  return (data ?? []) as { email: string; name: string | null }[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/supabase.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Supabase dedup and recipients module"
```

---

### Task 4: Email rendering + Gmail transport

**Files:**
- Create: `lib/email.ts`, `test/email.test.ts`

**Interfaces:**
- Consumes: `EnrichedPermit`, `PermitRecord` from `lib/types`.
- Produces:
  - `formatCad(value: number): string`
  - `formatDate(iso: string): string`
  - `renderPermitEmail(permits: EnrichedPermit[], weekOf: string): { subject: string; html: string }`
  - `sendEmail(args: { to: string; subject: string; html: string }): Promise<void>`

- [ ] **Step 1: Write failing tests `test/email.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { formatCad, renderPermitEmail } from "../lib/email";
import type { EnrichedPermit } from "../lib/types";

const permit: EnrichedPermit = {
  source: "cov-issued-building-permits",
  permitNumber: "BP-2026-001",
  projectValue: 25000000,
  issueDate: "2026-07-20",
  address: "500 Granville St",
  raw: { permitnumber: "BP-2026-001", projectvalue: 25000000, address: "500 Granville St" },
  summaryHtml: "<div class='block'>A shiny tower</div>",
};

describe("email rendering", () => {
  it("formats CAD without decimals", () => {
    expect(formatCad(25000000)).toBe("$25,000,000 CAD");
  });

  it("subject includes count and week", () => {
    const { subject } = renderPermitEmail([permit], "2026-07-21");
    expect(subject).toContain("1 new permit");
    expect(subject).toContain("2026-07-21");
  });

  it("html contains the newsletter block, the formatted value, and the address", () => {
    const { html } = renderPermitEmail([permit], "2026-07-21");
    expect(html).toContain("A shiny tower");
    expect(html).toContain("$25,000,000 CAD");
    expect(html).toContain("500 Granville St");
    expect(html).toContain("issued-building-permits"); // dataset footer link
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/email.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/email.ts`**

```ts
import nodemailer from "nodemailer";
import type { EnrichedPermit } from "./types";

const DATASET_URL =
  "https://opendata.vancouver.ca/explore/dataset/issued-building-permits/";

// Preferred column order for the data table; any extra raw keys are appended.
const COLUMN_ORDER = [
  "permitnumber", "permitnumbercreateddate", "issuedate", "permitelapseddays",
  "projectvalue", "typeofwork", "address", "projectdescription", "permitcategory",
  "applicant", "applicantaddress", "propertyuse", "specificusecategory",
  "buildingcontractor", "buildingcontractoraddress", "issueyear", "geolocalarea",
  "yearmonth",
];

export function formatCad(value: number): string {
  return "$" + Math.round(value).toLocaleString("en-US") + " CAD";
}

export function formatDate(iso: string): string {
  return (iso || "").slice(0, 10);
}

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableColumns(permits: EnrichedPermit[]): string[] {
  const seen = new Set<string>();
  for (const p of permits) for (const k of Object.keys(p.raw)) seen.add(k);
  const ordered = COLUMN_ORDER.filter((c) => seen.has(c));
  const extras = [...seen].filter((c) => !COLUMN_ORDER.includes(c));
  return [...ordered, ...extras];
}

function cell(key: string, value: unknown): string {
  if (key === "projectvalue" && value != null && value !== "") {
    return formatCad(Number(value));
  }
  if (key === "issuedate" || key === "permitnumbercreateddate") {
    return escapeHtml(formatDate(String(value ?? "")));
  }
  return escapeHtml(value);
}

export function renderPermitEmail(
  permits: EnrichedPermit[],
  weekOf: string,
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
  <p style="font-size:12px;color:#666;margin-top:16px;">Source: <a href="${DATASET_URL}">City of Vancouver — Issued Building Permits</a></p>
</div>`;

  return { subject, html };
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const from = process.env.ALERT_FROM_EMAIL || user;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  await transport.sendMail({ from, to: args.to, subject: args.subject, html: args.html });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/email.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: email rendering and Gmail SMTP transport"
```

---

### Task 5: AI enrichment (Claude Sonnet 5 + web search)

**Files:**
- Create: `lib/enrich.ts`, `test/enrich.test.ts`

**Interfaces:**
- Consumes: `PermitRecord`, `EnrichedPermit` from `lib/types`; `formatCad` from `lib/email`.
- Produces:
  - `fallbackSummaryHtml(r: PermitRecord): string`
  - `extractHtml(content: Array<{ type: string; text?: string }>): string`
  - `enrichPermits(records: PermitRecord[]): Promise<EnrichedPermit[]>`

- [ ] **Step 1: Write failing tests `test/enrich.test.ts`** (pure functions only)

```ts
import { describe, it, expect } from "vitest";
import { fallbackSummaryHtml, extractHtml } from "../lib/enrich";
import type { PermitRecord } from "../lib/types";

const permit: PermitRecord = {
  source: "cov-issued-building-permits",
  permitNumber: "BP-2026-001",
  projectValue: 25000000,
  issueDate: "2026-07-20",
  address: "500 Granville St",
  raw: { projectdescription: "New 30-storey tower", applicant: "Acme Dev" },
};

describe("enrich pure helpers", () => {
  it("fallbackSummaryHtml includes value, address, and description", () => {
    const html = fallbackSummaryHtml(permit);
    expect(html).toContain("$25,000,000 CAD");
    expect(html).toContain("500 Granville St");
    expect(html).toContain("New 30-storey tower");
  });

  it("extractHtml joins text blocks and strips code fences", () => {
    const content = [
      { type: "thinking", text: "ignore me" },
      { type: "text", text: "```html\n<div>Hello</div>\n```" },
    ];
    expect(extractHtml(content)).toBe("<div>Hello</div>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/enrich.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/enrich.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { PermitRecord, EnrichedPermit } from "./types";
import { formatCad } from "./email";

const MODEL = "claude-sonnet-5";
const CONCURRENCY = 3;

export function fallbackSummaryHtml(r: PermitRecord): string {
  const desc = r.raw["projectdescription"];
  const applicant = r.raw["applicant"];
  const type = r.raw["typeofwork"];
  const parts: string[] = [];
  if (desc) parts.push(`<p style="margin:4px 0;">${String(desc)}</p>`);
  const facts: string[] = [`Value: ${formatCad(r.projectValue)}`];
  if (r.address) facts.push(`Address: ${r.address}`);
  if (applicant) facts.push(`Applicant: ${String(applicant)}`);
  if (type) facts.push(`Type: ${String(type)}`);
  return `<div style="border:1px solid #eee;border-left:4px solid #b5651d;padding:12px;margin:12px 0;">
    <h3 style="margin:0 0 6px;font-family:Georgia,serif;">${r.address ?? r.permitNumber}</h3>
    ${parts.join("")}
    <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#444;">
      ${facts.map((f) => `<li>${f}</li>`).join("")}
    </ul>
  </div>`;
}

export function extractHtml(content: Array<{ type: string; text?: string }>): string {
  const text = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  // Strip a ```html ... ``` or ``` ... ``` code fence if present.
  const fence = text.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
  return (fence ? fence[1] : text).trim();
}

function systemPrompt(): string {
  return [
    "You are a newsletter writer briefing a Vancouver commercial real estate developer.",
    "You are given one newly issued City of Vancouver building permit (value >= $20M).",
    "Use the web_search tool to research the project: its name, the developer, what is",
    "being built (e.g. residential tower, office, community centre, mixed-use), and any",
    "renderings or news coverage. Then write a short newsletter blurb.",
    "",
    "Output ONLY a self-contained HTML block (no markdown, no code fences) exactly like:",
    '<div style="border:1px solid #eee;border-left:4px solid #b5651d;padding:12px;margin:12px 0;">',
    '  <h3 style="margin:0 0 6px;font-family:Georgia,serif;">HEADLINE</h3>',
    '  <p style="margin:4px 0;">2-3 sentence summary of what is happening and why it matters.</p>',
    '  <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#444;">',
    "    <li>Value: ...</li><li>Address: ...</li><li>Developer/Applicant: ...</li><li>Type: ...</li>",
    "  </ul>",
    '  <p style="font-size:12px;margin:6px 0 0;">Links: <a href=\\"URL\\">label</a></p>',
    "</div>",
    "",
    "Only include a Links line if web_search actually found relevant URLs. Never invent URLs.",
  ].join("\n");
}

function userPrompt(r: PermitRecord): string {
  return `Permit fields (JSON):\n${JSON.stringify(
    { ...r.raw, permitNumber: r.permitNumber, projectValue: r.projectValue, address: r.address },
    null,
    2,
  )}`;
}

async function enrichOne(client: Anthropic, r: PermitRecord): Promise<string> {
  try {
    // Cast the request to `any`: the `web_search_20260209` tool type and
    // adaptive-thinking shape may be newer than the installed SDK's static
    // types. They are valid at the API level; the cast avoids version-locked
    // TS union errors without changing runtime behaviour.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: systemPrompt(),
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [{ role: "user", content: userPrompt(r) }],
    } as any);
    const msg = await stream.finalMessage();
    const html = extractHtml(msg.content as Array<{ type: string; text?: string }>);
    return html || fallbackSummaryHtml(r);
  } catch (err) {
    console.error(`enrich failed for ${r.permitNumber}:`, err);
    return fallbackSummaryHtml(r);
  }
}

export async function enrichPermits(records: PermitRecord[]): Promise<EnrichedPermit[]> {
  const enrichDisabled = process.env.ENRICH === "false" || !process.env.ANTHROPIC_API_KEY;
  if (enrichDisabled) {
    return records.map((r) => ({ ...r, summaryHtml: fallbackSummaryHtml(r) }));
  }
  const client = new Anthropic();
  const out: EnrichedPermit[] = [];
  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const batch = records.slice(i, i + CONCURRENCY);
    const summaries = await Promise.all(batch.map((r) => enrichOne(client, r)));
    batch.forEach((r, j) => out.push({ ...r, summaryHtml: summaries[j] }));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/enrich.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: AI enrichment via Claude Sonnet 5 + web search"
```

---

### Task 6: Provision Supabase (project, schema, seed) via MCP

**Files:** none (infrastructure via Supabase MCP tools).

**Interfaces:**
- Produces: a live Supabase project; `notified_permits` and `alert_recipients` tables with RLS enabled and no public policies; one seeded active recipient; the project URL + service-role key to place in env/secrets.

- [ ] **Step 1: Create the project**

Use the Supabase MCP: `list_organizations` → pick org → `create_project` (name e.g. `vancouver-permit-alerts`, region close to the user). Wait until it is ACTIVE (`get_project`).

- [ ] **Step 2: Apply the schema**

Use `apply_migration` (name `init_permit_alerts`) with:

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

alter table notified_permits enable row level security;
alter table alert_recipients enable row level security;
-- No policies created: service role bypasses RLS; anon/authenticated get no access.
```

- [ ] **Step 3: Seed the recipient**

Use `execute_sql`:

```sql
insert into alert_recipients (email, name)
values ('mweggemans@cressey.com', null)
on conflict (email) do nothing;
```

- [ ] **Step 4: Verify**

- `list_tables` → confirm both tables exist.
- `execute_sql`: `select email, active from alert_recipients;` → confirm the seeded row.
- `get_advisors` (type `security`) → confirm no RLS-disabled warnings.
- Retrieve the project URL (`get_project_url`) and service-role key; give these to the user to store as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (local `.env` and later GitHub secrets). **Do not commit them.**

- [ ] **Step 5: Commit** (nothing to commit; note completion)

No files changed. Proceed to Task 7.

---

### Task 7: Orchestrator (`src/run.ts`) + dry-run verification

**Files:**
- Create: `src/run.ts`

**Interfaces:**
- Consumes: `SOURCES` (`lib/sources`), `getNotifiedPermitNumbers` / `filterNewPermits` / `recordNotified` / `getActiveRecipients` (`lib/supabase`), `enrichPermits` (`lib/enrich`), `renderPermitEmail` / `sendEmail` (`lib/email`). Week label is today's date (`new Date().toISOString().slice(0,10)`).
- Produces: an executable entry point (`tsx src/run.ts`).

- [ ] **Step 1: Implement `src/run.ts`**

```ts
import "dotenv/config";
import fs from "node:fs";
import { SOURCES } from "../lib/sources/index";
import {
  getNotifiedPermitNumbers,
  filterNewPermits,
  recordNotified,
  getActiveRecipients,
} from "../lib/supabase";
import { enrichPermits } from "../lib/enrich";
import { renderPermitEmail, sendEmail } from "../lib/email";
import type { PermitRecord } from "../lib/types";

const WINDOW_DAYS = 7;

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const weekOf = new Date().toISOString().slice(0, 10);

  // 1. Fetch from all sources.
  const fetched: PermitRecord[] = [];
  for (const source of SOURCES) {
    const rows = await source.fetch(WINDOW_DAYS);
    console.log(`[${source.id}] fetched ${rows.length} permit(s) in last ${WINDOW_DAYS}d`);
    fetched.push(...rows);
  }
  if (fetched.length === 0) {
    console.log("No permits in window. Nothing to do.");
    return;
  }

  // 2. Dedup.
  const existing = await getNotifiedPermitNumbers(fetched.map((r) => r.permitNumber));
  const fresh = filterNewPermits(fetched, existing);
  console.log(`${fresh.length} new permit(s) after dedup.`);
  if (fresh.length === 0) {
    console.log("Nothing new. Exiting silently.");
    return;
  }

  // 3. Enrich.
  const enriched = await enrichPermits(fresh);

  // 4. Render.
  const { subject, html } = renderPermitEmail(enriched, weekOf);

  // 5. Send.
  if (dryRun) {
    fs.writeFileSync("dry-run-preview.html", html);
    console.log(`DRY_RUN: wrote dry-run-preview.html — "${subject}"`);
    const test = process.env.TEST_EMAIL;
    if (test) {
      await sendEmail({ to: test, subject: `[DRY RUN] ${subject}`, html });
      console.log(`DRY_RUN: sent preview to ${test}`);
    }
    console.log("DRY_RUN: not writing to notified_permits.");
    return;
  }

  const recipients = await getActiveRecipients();
  if (recipients.length === 0) {
    console.log("No active recipients; skipping send. Not recording as notified.");
    return;
  }
  for (const r of recipients) {
    await sendEmail({ to: r.email, subject, html });
    console.log(`Sent to ${r.email}`);
  }

  // 6. Record only after a successful send.
  await recordNotified(fresh);
  console.log(`Recorded ${fresh.length} permit(s) as notified.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Dry-run without AI (fast, no Anthropic calls)**

Ensure `.env` has the Supabase + Gmail + `TEST_EMAIL` values from Task 6. Run:
```bash
DRY_RUN=true ENRICH=false npx tsx src/run.ts
```
Expected: logs fetch count and new-permit count; writes `dry-run-preview.html`; if `TEST_EMAIL` set, a `[DRY RUN]` email arrives; **no** rows written to `notified_permits`. Open `dry-run-preview.html` in a browser and confirm the newsletter (fallback blocks) + table render.

Note: if there are 0 new permits this week, temporarily widen the window in `WINDOW_DAYS` to 60 for this manual check, then revert to 7 before committing.

- [ ] **Step 3: Dry-run WITH AI (one real enrichment pass)**

Run:
```bash
DRY_RUN=true npx tsx src/run.ts
```
Expected: takes longer (web search per permit); `dry-run-preview.html` now shows AI-written blurbs with any links Claude found; still no DB writes. Verify a blurb looks sensible and no fabricated links.

- [ ] **Step 4: Verify dedup safety of a real send path (optional, controlled)**

Confirm `notified_permits` is still empty after the dry runs:
```bash
# via Supabase MCP execute_sql:
select count(*) from notified_permits;
```
Expected: `0` (dry runs never write).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pipeline orchestrator (src/run.ts) with dry-run"
```

---

### Task 8: GitHub Actions workflow + README

**Files:**
- Create: `.github/workflows/permit-alerts.yml`, `README.md`

**Interfaces:**
- Consumes: `npm start` (`tsx src/run.ts`) and all env vars as GitHub Actions secrets.
- Produces: a weekly scheduled run + a manual dispatch with `dry_run` / `enrich` inputs.

- [ ] **Step 1: Create `.github/workflows/permit-alerts.yml`**

```yaml
name: Weekly Permit Alerts

on:
  schedule:
    - cron: "0 15 * * 1" # Mondays 15:00 UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run (no DB writes; preview to TEST_EMAIL)"
        type: boolean
        default: false
      enrich:
        description: "Run AI enrichment"
        type: boolean
        default: true

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - name: Run permit alerts
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          GMAIL_USER: ${{ secrets.GMAIL_USER }}
          GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
          ALERT_FROM_EMAIL: ${{ secrets.ALERT_FROM_EMAIL }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TEST_EMAIL: ${{ secrets.TEST_EMAIL }}
          DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || 'false' }}
          ENRICH: ${{ github.event_name == 'workflow_dispatch' && inputs.enrich || 'true' }}
        run: npm start
```

- [ ] **Step 2: Create `README.md`**

````markdown
# Vancouver Building Permit Alerts

Weekly email of newly issued City of Vancouver building permits ≥ CAD $20M,
each researched and summarized by Claude Sonnet 5, delivered via Gmail. Runs
on a free GitHub Actions cron.

## How it works
`src/run.ts` → fetch (`lib/sources`) → dedup (Supabase `notified_permits`) →
enrich (`lib/enrich`, Sonnet 5 + web search) → render + send (`lib/email`,
Gmail SMTP) → record sent permits. See `docs/superpowers/specs/` for the design.

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

## ⚠️ Keepalive
GitHub disables scheduled workflows after **60 days of no repo activity**. Push
a commit occasionally, or the weekly email will silently stop until you
re-enable the workflow in the Actions tab.

## Extending with new sources
Add `lib/sources/<name>.ts` exporting a `PermitSource` (normalize into
`PermitRecord`), then add it to the `SOURCES` array in `lib/sources/index.ts`.
The dedup, enrichment, and email pipeline reuse it automatically.
````

- [ ] **Step 3: Verify the workflow file parses**

Run: `npx tsx -e "import('node:fs').then(fs=>console.log(fs.readFileSync('.github/workflows/permit-alerts.yml','utf8').includes('workflow_dispatch')))"`
Expected: prints `true`. (Full validation happens when GitHub parses it on push.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: weekly GitHub Actions workflow and README"
```

---

## Post-implementation (manual, by the user)

1. Create a GitHub repo and push this project.
2. Add the secrets from the README table.
3. Trigger **Actions → Weekly Permit Alerts → Run workflow** with `dry_run = true` to confirm an email arrives, then run once with `dry_run = false` to send the first real email and populate `notified_permits`.
4. Leave the weekly schedule to run; remember the 60-day keepalive.
