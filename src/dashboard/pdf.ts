// The itinerary PDF (plan.md section 5): one link, always current. Built on request from the public trip view
// (tripPage), so it can only contain what the public page may show. Pure JS (pdfkit), no headless browser.
import PDFDocument from "pdfkit";

type Page = ReturnType<typeof import("../engine/itinerary.js").tripPage> & Record<string, any>;

/** Built-in PDF fonts are Latin-1 only: keep accents, map smart punctuation, drop emoji and anything else. */
export function pdfSafe(s: unknown): string {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const cache = new Map<string, Buffer>(); // key: code + version + updatedAt

export async function itineraryPdf(code: string, page: Page, pageUrl: string): Promise<Buffer> {
  const key = `${code}:${page.version}:${page.updatedAt}:${JSON.stringify([page.going, page.cars, page.bring, page.goodToKnow, page.dateText, page.place])}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 64, left: 54, right: 54 }, bufferPages: true, info: { Title: pdfSafe(`${page.title} itinerary`) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 108;
  const h2 = (t: string) => { doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#000").text(pdfSafe(t).toUpperCase(), { characterSpacing: 1 }); doc.moveDown(0.25); };
  const body = (t: string) => doc.font("Helvetica").fontSize(11).fillColor("#000").text(pdfSafe(t), { width: W });

  // 1. Header, with the version up front so two printouts can be told apart.
  doc.font("Helvetica-Bold").fontSize(24).text(pdfSafe(page.title) || "Trip");
  doc.font("Helvetica").fontSize(12).text(pdfSafe([page.dateText, page.place].filter(Boolean).join("  ·  ")), { continued: false });
  doc.text(pdfSafe(`organized by ${page.organizer}`));
  const when = page.updatedAt ? new Date(page.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toLowerCase() : null;
  doc.moveDown(0.3).font("Helvetica-Bold").fontSize(12)
    .text(page.version ? `version ${page.version}${when ? `  ·  updated ${when}` : ""}` : "draft: the plan isn't final yet");

  // 2. The day.
  h2("The day");
  if (page.items.length) {
    for (const it of page.items) {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(11).text(pdfSafe(it.time ?? ""), 54, y, { width: 70 });
      doc.font("Helvetica").fontSize(11).text(pdfSafe(it.title), 130, y, { width: W - 76 });
      doc.moveDown(0.3);
      doc.x = 54;
    }
  } else body(`${page.organizer} and roundup are still putting the day together.`);

  // 3. Rides.
  if (page.ridesOn) {
    h2("Rides");
    if (page.cars.length) for (const c of page.cars) body(`${c.driver} drives${c.riders.length ? `: ${c.riders.join(", ")}` : ""}  (${c.seats} seats)`);
    else body(`rides are being sorted, ${page.seatsSoFar} seats so far`);
  }

  // 4. What to bring.
  if (page.bring.length) {
    h2("What to bring");
    for (const b of page.bring) body(`${b.item}: ${b.who.length ? b.who.join(", ") : "needed"}`);
  }

  // 5. Good to know.
  const g = page.goodToKnow;
  const facts = [
    g.meetAt && `meeting spot: ${g.meetAt}`, g.leaveAt && `leaving at: ${g.leaveAt}`, g.backBy && `back by: ${g.backBy}`,
    g.notes && `notes: ${g.notes}`, page.budget !== null && `budget: everyone's comfortable up to $${page.budget}`,
  ].filter(Boolean) as string[];
  if (facts.length) { h2("Good to know"); for (const f of facts) body(f); }

  // 6. Who's going (first names only).
  h2("Who's going");
  body([...page.going.map((p: { name: string; organizer: boolean }) => p.name + (p.organizer ? " (organizer)" : "")), ...page.maybe.map((n: string) => `${n} (maybe)`)].join(", ") || "nobody yet");

  // 7. What changed.
  if (page.changes.length) {
    h2("What changed");
    for (const c of page.changes) body(`v${c.version}: ${c.summary}`);
  }

  // 8. Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing in the bottom margin must not start a new page
    doc.font("Helvetica").fontSize(9).fillColor("#444")
      .text(pdfSafe(`page ${i + 1} of ${range.count}  ·  latest version always at ${pageUrl}`), 54, doc.page.height - 44, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  const buf = await done;
  if (cache.size > 50) cache.clear();
  cache.set(key, buf);
  return buf;
}
