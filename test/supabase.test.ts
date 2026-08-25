import { describe, it, expect } from "vitest";
import { filterNewPermits, bucketHistoricalStats } from "../lib/supabase";
import type { PermitRecord } from "../lib/types";
import type { HistoricalStatRow } from "../lib/supabase";

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
