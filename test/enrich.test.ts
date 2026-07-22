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

  it("fallbackSummaryHtml escapes HTML metacharacters from raw fields", () => {
    const malicious: PermitRecord = {
      source: "cov-issued-building-permits",
      permitNumber: "BP-2026-002",
      projectValue: 30000000,
      issueDate: "2026-07-20",
      address: "600 Granville St",
      raw: {
        projectdescription: 'Tower <script>x</script> & "quotes"',
        applicant: 'Acme <img src=x onerror=alert(1)> & Co',
        typeofwork: 'New <b>Build</b>',
      },
    };
    const html = fallbackSummaryHtml(malicious);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<b>Build</b>");
  });
});
