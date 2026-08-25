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
