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
