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
