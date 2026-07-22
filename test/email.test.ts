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
