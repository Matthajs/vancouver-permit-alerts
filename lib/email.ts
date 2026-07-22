import nodemailer from "nodemailer";
import type { EnrichedPermit } from "./types";

const DATASET_URL =
  "https://opendata.vancouver.ca/explore/dataset/issued-building-permits/";

// Preferred column order for the data table; any extra raw keys are appended.
const COLUMN_ORDER = [
  "permitnumber", "permitnumbercreateddate", "issuedate", "permitelapseddays",
  "projectvalue", "typeofwork", "address", "projectdescription", "permitcategory",
  "applicant", "applicantaddress", "propertyuse", "specificusecategory",
  "buildingcontractor", "buildingcontractoraddress", "issueyear", "geolocalarea",
  "yearmonth",
];

export function formatCad(value: number): string {
  return "$" + Math.round(value).toLocaleString("en-US") + " CAD";
}

export function formatDate(iso: string): string {
  return (iso || "").slice(0, 10);
}

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableColumns(permits: EnrichedPermit[]): string[] {
  const seen = new Set<string>();
  for (const p of permits) for (const k of Object.keys(p.raw)) seen.add(k);
  const ordered = COLUMN_ORDER.filter((c) => seen.has(c));
  const extras = [...seen].filter((c) => !COLUMN_ORDER.includes(c));
  return [...ordered, ...extras];
}

function cell(key: string, value: unknown): string {
  if (key === "projectvalue" && value != null && value !== "") {
    return formatCad(Number(value));
  }
  if (key === "issuedate" || key === "permitnumbercreateddate") {
    return escapeHtml(formatDate(String(value ?? "")));
  }
  return escapeHtml(value);
}

export function renderPermitEmail(
  permits: EnrichedPermit[],
  weekOf: string,
): { subject: string; html: string } {
  const n = permits.length;
  const subject = `Vancouver Permits $20M+ — Week of ${weekOf}: ${n} new permit${n === 1 ? "" : "s"}`;

  const newsletter = permits.map((p) => p.summaryHtml).join("\n");

  const cols = tableColumns(permits);
  const thead =
    "<tr>" +
    cols.map((c) => `<th style="text-align:left;border:1px solid #ddd;padding:6px;background:#f4f1ea;">${escapeHtml(c)}</th>`).join("") +
    "</tr>";
  const rows = permits
    .map(
      (p) =>
        "<tr>" +
        cols.map((c) => `<td style="border:1px solid #ddd;padding:6px;vertical-align:top;">${cell(c, p.raw[c])}</td>`).join("") +
        "</tr>",
    )
    .join("");

  const html = `<div style="font-family:Georgia,serif;color:#222;max-width:100%;">
  <p>${n} new City of Vancouver building permit${n === 1 ? "" : "s"} of $20M+ issued in the last 7 days (week of ${escapeHtml(weekOf)}).</p>
  <h2 style="font-family:Georgia,serif;">This week's projects</h2>
  ${newsletter}
  <h2 style="font-family:Georgia,serif;">All fields</h2>
  <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p style="font-size:12px;color:#666;margin-top:16px;">Source: <a href="${DATASET_URL}">City of Vancouver — Issued Building Permits</a></p>
</div>`;

  return { subject, html };
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const from = process.env.ALERT_FROM_EMAIL || user;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  await transport.sendMail({ from, to: args.to, subject: args.subject, html: args.html });
}
