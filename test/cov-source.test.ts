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
