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
  const parts = [
    `where=${encodeURIComponent(where).replace(/'/g, "%27")}`,
    `order_by=${encodeURIComponent("issuedate desc")}`,
    `limit=${PAGE}`,
    `offset=${offset}`,
  ];
  return `${BASE}?${parts.join("&")}`;
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
