import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getSupabase } from "../lib/supabase";

async function main(): Promise<void> {
  const { error } = await getSupabase()
    .from("alert_recipients")
    .select("email")
    .limit(1);
  if (error) throw new Error(`Supabase keep-alive query failed: ${error.message}`);

  const dir = path.join(process.cwd(), "keepalive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "last-ping.txt"), new Date().toISOString() + "\n");
  console.log("Keep-alive ping succeeded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
