import "dotenv/config";
import fs from "node:fs";
import { SOURCES } from "../lib/sources/index";
import {
  getNotifiedPermitNumbers,
  filterNewPermits,
  recordNotified,
  getActiveRecipients,
  getHistoricalStats,
} from "../lib/supabase";
import { enrichPermits } from "../lib/enrich";
import { renderPermitEmail, sendEmail } from "../lib/email";
import type { PermitRecord } from "../lib/types";

const WINDOW_DAYS = 7;

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const weekOf = new Date().toISOString().slice(0, 10);

  // 1. Fetch from all sources.
  const fetched: PermitRecord[] = [];
  for (const source of SOURCES) {
    const rows = await source.fetch(WINDOW_DAYS);
    console.log(`[${source.id}] fetched ${rows.length} permit(s) in last ${WINDOW_DAYS}d`);
    fetched.push(...rows);
  }
  if (fetched.length === 0) {
    console.log("No permits in window. Nothing to do.");
    return;
  }

  // 2. Dedup.
  const existing = await getNotifiedPermitNumbers(fetched.map((r) => r.permitNumber));
  const fresh = filterNewPermits(fetched, existing);
  console.log(`${fresh.length} new permit(s) after dedup.`);
  if (fresh.length === 0) {
    console.log("Nothing new. Exiting silently.");
    return;
  }

  // 3. Enrich.
  const enriched = await enrichPermits(fresh);

  // 4. Render.
  const stats = await getHistoricalStats(new Date());
  const { subject, html } = renderPermitEmail(enriched, weekOf, stats);

  // 5. Send.
  if (dryRun) {
    fs.writeFileSync("dry-run-preview.html", html);
    console.log(`DRY_RUN: wrote dry-run-preview.html — "${subject}"`);
    const test = process.env.TEST_EMAIL;
    if (test) {
      await sendEmail({ to: test, subject: `[DRY RUN] ${subject}`, html });
      console.log(`DRY_RUN: sent preview to ${test}`);
    }
    console.log("DRY_RUN: not writing to notified_permits.");
    return;
  }

  const recipients = await getActiveRecipients();
  if (recipients.length === 0) {
    console.log("No active recipients; skipping send. Not recording as notified.");
    return;
  }
  // All-or-nothing: if any recipient send throws, main() rejects before
  // recordNotified runs, so nothing is recorded and the whole batch is
  // retried next run (recipients who already received this send may get a duplicate).
  for (const r of recipients) {
    await sendEmail({ to: r.email, subject, html });
    console.log(`Sent to ${r.email}`);
  }

  // 6. Record only after a successful send.
  await recordNotified(fresh);
  console.log(`Recorded ${fresh.length} permit(s) as notified.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
