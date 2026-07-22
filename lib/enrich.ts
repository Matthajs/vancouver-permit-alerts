import Anthropic from "@anthropic-ai/sdk";
import type { PermitRecord, EnrichedPermit } from "./types";
import { formatCad } from "./email";

const MODEL = "claude-sonnet-5";
const CONCURRENCY = 3;

export function fallbackSummaryHtml(r: PermitRecord): string {
  const desc = r.raw["projectdescription"];
  const applicant = r.raw["applicant"];
  const type = r.raw["typeofwork"];
  const parts: string[] = [];
  if (desc) parts.push(`<p style="margin:4px 0;">${String(desc)}</p>`);
  const facts: string[] = [`Value: ${formatCad(r.projectValue)}`];
  if (r.address) facts.push(`Address: ${r.address}`);
  if (applicant) facts.push(`Applicant: ${String(applicant)}`);
  if (type) facts.push(`Type: ${String(type)}`);
  return `<div style="border:1px solid #eee;border-left:4px solid #b5651d;padding:12px;margin:12px 0;">
    <h3 style="margin:0 0 6px;font-family:Georgia,serif;">${r.address ?? r.permitNumber}</h3>
    ${parts.join("")}
    <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#444;">
      ${facts.map((f) => `<li>${f}</li>`).join("")}
    </ul>
  </div>`;
}

export function extractHtml(content: Array<{ type: string; text?: string }>): string {
  const text = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  // Strip a ```html ... ``` or ``` ... ``` code fence if present.
  const fence = text.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
  return (fence ? fence[1] : text).trim();
}

function systemPrompt(): string {
  return [
    "You are a newsletter writer briefing a Vancouver commercial real estate developer.",
    "You are given one newly issued City of Vancouver building permit (value >= $20M).",
    "Use the web_search tool to research the project: its name, the developer, what is",
    "being built (e.g. residential tower, office, community centre, mixed-use), and any",
    "renderings or news coverage. Then write a short newsletter blurb.",
    "",
    "Output ONLY a self-contained HTML block (no markdown, no code fences) exactly like:",
    '<div style="border:1px solid #eee;border-left:4px solid #b5651d;padding:12px;margin:12px 0;">',
    '  <h3 style="margin:0 0 6px;font-family:Georgia,serif;">HEADLINE</h3>',
    '  <p style="margin:4px 0;">2-3 sentence summary of what is happening and why it matters.</p>',
    '  <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#444;">',
    "    <li>Value: ...</li><li>Address: ...</li><li>Developer/Applicant: ...</li><li>Type: ...</li>",
    "  </ul>",
    '  <p style="font-size:12px;margin:6px 0 0;">Links: <a href=\\"URL\\">label</a></p>',
    "</div>",
    "",
    "Only include a Links line if web_search actually found relevant URLs. Never invent URLs.",
  ].join("\n");
}

function userPrompt(r: PermitRecord): string {
  return `Permit fields (JSON):\n${JSON.stringify(
    { ...r.raw, permitNumber: r.permitNumber, projectValue: r.projectValue, address: r.address },
    null,
    2,
  )}`;
}

async function enrichOne(client: Anthropic, r: PermitRecord): Promise<string> {
  try {
    // Cast the request to `any`: the `web_search_20260209` tool type and
    // adaptive-thinking shape may be newer than the installed SDK's static
    // types. They are valid at the API level; the cast avoids version-locked
    // TS union errors without changing runtime behaviour.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: systemPrompt(),
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [{ role: "user", content: userPrompt(r) }],
    } as any);
    const msg = await stream.finalMessage();
    const html = extractHtml(msg.content as Array<{ type: string; text?: string }>);
    return html || fallbackSummaryHtml(r);
  } catch (err) {
    console.error(`enrich failed for ${r.permitNumber}:`, err);
    return fallbackSummaryHtml(r);
  }
}

export async function enrichPermits(records: PermitRecord[]): Promise<EnrichedPermit[]> {
  const enrichDisabled = process.env.ENRICH === "false" || !process.env.ANTHROPIC_API_KEY;
  if (enrichDisabled) {
    return records.map((r) => ({ ...r, summaryHtml: fallbackSummaryHtml(r) }));
  }
  const client = new Anthropic();
  const out: EnrichedPermit[] = [];
  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const batch = records.slice(i, i + CONCURRENCY);
    const summaries = await Promise.all(batch.map((r) => enrichOne(client, r)));
    batch.forEach((r, j) => out.push({ ...r, summaryHtml: summaries[j] }));
  }
  return out;
}
