import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PermitRecord } from "./types";

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
