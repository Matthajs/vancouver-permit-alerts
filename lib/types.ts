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
