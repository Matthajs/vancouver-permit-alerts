import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PermitRecord, HistoricalStats } from "./types";

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

export interface HistoricalStatRow {
  issue_date: string;
  project_value: number;
}

const STATS_WINDOWS: { label: string; days: number }[] = [
  { label: "Past 30 days", days: 30 },
  { label: "Past quarter", days: 90 },
  { label: "Past year", days: 365 },
];

export function bucketHistoricalStats(
  rows: HistoricalStatRow[],
  asOf: Date,
): HistoricalStats[] {
  return STATS_WINDOWS.map(({ label, days }) => {
    const cutoffIso = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const inWindow = rows.filter((r) => r.issue_date >= cutoffIso);
    return {
      label,
      days,
      count: inWindow.length,
      totalValue: inWindow.reduce((sum, r) => sum + r.project_value, 0),
    };
  });
}

export async function getHistoricalStats(asOf: Date): Promise<HistoricalStats[]> {
  const { data, error } = await getSupabase()
    .from("notified_permits")
    .select("issue_date, project_value");
  if (error) throw new Error(`Supabase stats select failed: ${error.message}`);
  return bucketHistoricalStats((data ?? []) as HistoricalStatRow[], asOf);
}
