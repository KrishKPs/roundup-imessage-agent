// The itinerary PDF (plan.md section 5): one link, always current. Built on request from the public trip view
// (tripPage), so it can only contain what the public page may show. Pure JS (pdfkit), no headless browser.
// Designed, not plain: one accent color picked from the trip's place/name (beach, mountains, camping, city),
// light tints and dark text so it still prints cleanly in black and white.
import PDFDocument from "pdfkit";

type Page = ReturnType<typeof import("../engine/itinerary.js").tripPage> & Record<string, any>;
type Doc = InstanceType<typeof PDFDocument>;

/** Built-in PDF fonts are Latin-1 only: keep accents, map smart punctuation, drop emoji and anything else. */
export function pdfSafe(s: unknown): string {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------- theme from the trip's place

export interface Theme {
  name: "beach" | "mountain" | "camping" | "city" | "default";
  accent: string; // headings, timeline, header band
  deep: string; // header band gradient end
  tint: string; // soft background boxes
  chip: string; // chips and seat circles
}

const THEMES: Record<Theme["name"], Theme> = {
  beach: { name: "beach", accent: "#1b8a9a", deep: "#0f5f73", tint: "#f4efe3", chip: "#dff1f1" },
  mountain: { name: "mountain", accent: "#3f7a52", deep: "#2b4f3c", tint: "#eef3ec", chip: "#dde9df" },
  camping: { name: "camping", accent: "#5b7d3a", deep: "#3c5428", tint: "#f2f1e6", chip: "#e3ead6" },
  city: { name: "city", accent: "#4b4fa8", deep: "#2c2f6e", tint: "#eff0f8", chip: "#e2e3f4" },
  default: { name: "default", accent: "#2f8fd0", deep: "#1f5f8b", tint: "#eef6fb", chip: "#dcedf8" },
};

export function themeFor(title: string, place: string | null): Theme {
  const t = `${title} ${place ?? ""}`.toLowerCase();
  // The trip's own name wins ("Camping trip" at "Jordan Lake" is camping, not beach).
  const named = title.toLowerCase();
  if (/\b(camp|camping|campfire|cabin|tent)\b/.test(named)) return THEMES.camping;
  if (/\b(hike|hiking|ski|mountain|trail)\b/.test(named)) return THEMES.mountain;
  if (/\b(beach|lake|surf|boat)\b/.test(named)) return THEMES.beach;
  if (/\b(concert|show|city|club|museum|festival|game)\b/.test(named)) return THEMES.city;
  if (/\b(beach|lake|ocean|sea|shore|island|bay|surf|pier|coast|river|pool|wrightsville|outer banks)\b/.test(t)) return THEMES.beach;
  if (/\b(camp|camping|campfire|cabin|bonfire|tent|state park|forest)\b/.test(t)) return THEMES.camping;
  if (/\b(hike|hiking|trail|mountain|mt\.?|summit|ski|peak|ridge|falls|waterfall|blue ridge)\b/.test(t)) return THEMES.mountain;
  if (/\b(city|downtown|concert|show|nyc|club|bar|museum|game|stadium|festival|dinner|brunch)\b/.test(t)) return THEMES.city;
  return THEMES.default;
}

// ---------------------------------------------------------------- drawing helpers

const INK = "#1d2b36", SOFT = "#5b6b78", LINE = "#d9e2e8";
const KIND_COLOR: Record<string, string> = { food: "#e39b2d", free: "#4fae6a", drive: "#7b8a96" };

/** A faint motif in the header band, in white: waves, mountains, trees, a skyline, or bubbles. */
function motif(doc: Doc, th: Theme, x: number, y: number, w: number, h: number) {
  doc.save().fillColor("#ffffff").strokeColor("#ffffff").opacity(0.14);
  if (th.name === "beach") {
    for (let row = 0; row < 3; row++) {
      const yy = y + h - 16 - row * 14;
      doc.moveTo(x + w * 0.45, yy);
      for (let i = 0; i < 9; i++) { const sx = x + w * 0.45 + i * (w * 0.55 / 9); doc.bezierCurveTo(sx + 8, yy - 6, sx + 18, yy + 6, sx + w * 0.55 / 9, yy); }
      doc.lineWidth(2).stroke();
    }
    doc.circle(x + w - 70, y + 34, 18).fill();
  } else if (th.name === "mountain") {
    doc.polygon([x + w * 0.5, y + h], [x + w * 0.68, y + 30], [x + w * 0.86, y + h]).fill();
    doc.polygon([x + w * 0.7, y + h], [x + w * 0.86, y + 48], [x + w, y + h]).fill();
  } else if (th.name === "camping") {
    for (let i = 0; i < 6; i++) { const tx = x + w * 0.55 + i * 34, s = 14 + (i % 3) * 6; doc.polygon([tx, y + h - 8], [tx + s, y + h - 8 - s * 2.2], [tx + 2 * s, y + h - 8]).fill(); }
  } else if (th.name === "city") {
    let bx = x + w * 0.5;
    for (const bh of [40, 64, 30, 78, 52, 36, 70, 44]) { doc.rect(bx, y + h - bh, 22, bh).fill(); bx += 28; }
  } else {
    for (const [cx, cy, r] of [[w - 80, 40, 26], [w - 140, 80, 14], [w - 40, 96, 18]]) doc.circle(x + cx, y + cy, r).fill();
  }
  doc.restore();
}

function sectionTitle(doc: Doc, th: Theme, text: string, x: number, y: number) {
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(th.accent).text(text.toUpperCase(), x, y, { characterSpacing: 1.4, lineBreak: false });
  return y + 16;
}

function ensureSpace(doc: Doc, need: number, top = 54) {
  if (doc.y + need > doc.page.height - 70) { doc.addPage(); doc.y = top; }
}

const cache = new Map<string, Buffer>(); // key: code + version + content

export async function itineraryPdf(code: string, page: Page, pageUrl: string): Promise<Buffer> {
  const key = `${code}:${page.version}:${page.updatedAt}:${JSON.stringify([page.going, page.maybe, page.cars, page.bring, page.goodToKnow, page.dateText, page.place, page.items, page.title])}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const th = themeFor(page.title, page.place);
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 64, left: 54, right: 54 }, bufferPages: true, info: { Title: pdfSafe(`${page.title} itinerary`) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const L = 54, W = doc.page.width - 108;

  // ---- 1. header band: gradient in the trip's color, title, date/place, organizer, version badge
  const bandH = 138;
  const grad = doc.linearGradient(0, 0, doc.page.width, bandH);
  grad.stop(0, th.accent).stop(1, th.deep);
  doc.rect(0, 0, doc.page.width, bandH).fill(grad);
  motif(doc, th, 0, 0, doc.page.width, bandH);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9.5).text("ROUNDUP TRIP PLAN", L, 34, { characterSpacing: 1.6 });
  doc.font("Helvetica-Bold").fontSize(30).text(pdfSafe(page.title) || "Trip", L, 50, { width: W - 150 });
  const sub = pdfSafe([page.dateText, page.place].filter(Boolean).join("   ·   "));
  doc.font("Helvetica").fontSize(12).fillColor("#ffffff").opacity(0.92).text(sub || " ", L, doc.y + 2, { width: W - 150 });
  doc.text(pdfSafe(`organized by ${page.organizer}`), L, doc.y + 1).opacity(1);
  // version badge, top right
  const when = page.updatedAt ? new Date(page.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toLowerCase() : null;
  const badge = page.version ? `VERSION ${page.version}` : "DRAFT";
  doc.roundedRect(doc.page.width - L - 120, 34, 120, 44, 10).fill("#ffffff");
  doc.fillColor(th.deep).font("Helvetica-Bold").fontSize(13).text(badge, doc.page.width - L - 120, 42, { width: 120, align: "center" });
  doc.font("Helvetica").fontSize(8.5).fillColor(SOFT).text(page.version && when ? `updated ${when}` : "not final yet", doc.page.width - L - 120, 60, { width: 120, align: "center" });

  // ---- 2. the day: a timeline in the accent color
  let y = bandH + 28;
  y = sectionTitle(doc, th, "The day", L, y);
  if (page.items.length) {
    const lineX = L + 7;
    const startY = y + 6;
    for (const it of page.items) {
      doc.y = y; ensureSpace(doc, 34); if (doc.y !== y) y = doc.y;
      const dot = KIND_COLOR[it.kind] ?? th.accent;
      doc.circle(lineX, y + 7, 5.5).fill(dot);
      doc.circle(lineX, y + 7, 2.2).fill("#ffffff");
      doc.font("Helvetica-Bold").fontSize(11).fillColor(th.deep).text(pdfSafe(it.time ?? ""), L + 22, y + 1, { width: 70 });
      doc.font("Helvetica").fontSize(11.5).fillColor(INK).text(pdfSafe(it.title), L + 98, y + 1, { width: W - 98 });
      y = Math.max(doc.y, y + 16) + 6;
    }
    doc.save().moveTo(lineX, startY).lineTo(lineX, y - 14).lineWidth(1.6).strokeColor(th.accent).opacity(0.35).stroke().restore();
  } else {
    doc.roundedRect(L, y, W, 46, 10).fill(th.tint);
    doc.font("Helvetica").fontSize(11.5).fillColor(INK).text(pdfSafe(`${page.organizer} and roundup are still putting the day together. this page fills in as the plan comes together.`), L + 14, y + 10, { width: W - 28 });
    y += 58;
  }

  // ---- 3 + 4. rides (car cards) and what to bring (chips), side by side
  y += 8; doc.y = y; ensureSpace(doc, 120); y = doc.y;
  const colW = (W - 20) / 2, rx = L, bx = L + colW + 20;
  let ly = sectionTitle(doc, th, page.ridesOn ? "Rides" : "Who's going", rx, y);
  let ry = sectionTitle(doc, th, "What to bring", bx, y);

  if (page.ridesOn) {
    if (page.cars.length) {
      for (const c of page.cars) {
        const seats = Math.max(0, c.seats - 1), rows = Math.ceil(Math.max(1, seats) / 6), h = 30 + rows * 24;
        doc.roundedRect(rx, ly, colW, h, 9).fill(th.tint);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(pdfSafe(`${c.driver} drives`), rx + 12, ly + 9, { width: colW - 24 });
        for (let i = 0; i < seats; i++) {
          const cx = rx + 24 + (i % 6) * 27, cy = ly + 38 + Math.floor(i / 6) * 24;
          if (c.riders[i]) {
            doc.circle(cx, cy, 10).fill(th.chip);
            doc.font("Helvetica-Bold").fontSize(7.5).fillColor(th.deep).text(pdfSafe(c.riders[i].slice(0, 2).toUpperCase()), cx - 10, cy - 3.5, { width: 20, align: "center" });
          } else doc.save().circle(cx, cy, 9).dash(2, { space: 2 }).lineWidth(1).strokeColor(LINE).stroke().undash().restore();
        }
        ly += h + 8;
      }
    } else {
      doc.font("Helvetica").fontSize(11).fillColor(SOFT).text(pdfSafe(`rides are being sorted, ${page.seatsSoFar} seats so far`), rx, ly, { width: colW });
      ly = doc.y + 8;
    }
  } else {
    ly = peopleCircles(doc, th, page, rx, ly, colW);
  }

  if (page.bring.length) {
    let cx = bx, cy = ry;
    for (const b of page.bring) {
      const label = pdfSafe(b.who.length ? `${b.item} - ${b.who.join(", ")}` : `${b.item} - needed`);
      doc.font("Helvetica-Bold").fontSize(9.5);
      const w = Math.min(colW, doc.widthOfString(label) + 20);
      if (cx + w > bx + colW) { cx = bx; cy += 26; }
      if (b.who.length) doc.roundedRect(cx, cy, w, 20, 10).fill(th.chip);
      else doc.save().roundedRect(cx, cy, w, 20, 10).dash(3, { space: 2 }).lineWidth(1).strokeColor("#d9a441").stroke().undash().restore();
      doc.fillColor(b.who.length ? th.deep : "#8a5a00").text(label, cx + 10, cy + 5.5, { width: w - 16, lineBreak: false });
      cx += w + 6;
    }
    ry = cy + 32;
  } else {
    doc.font("Helvetica").fontSize(11).fillColor(SOFT).text("nothing on the list yet", bx, ry, { width: colW });
    ry = doc.y + 8;
  }
  y = Math.max(ly, ry) + 10;

  // ---- 5. who's going (when rides took the left column)
  if (page.ridesOn) {
    doc.y = y; ensureSpace(doc, 70); y = doc.y;
    y = sectionTitle(doc, th, "Who's going", L, y);
    y = peopleCircles(doc, th, page, L, y, W) + 6;
  }

  // ---- 6. good to know: a tinted box
  const g = page.goodToKnow;
  const facts = [
    ["meeting spot", g.meetAt], ["leaving at", g.leaveAt], ["back by", g.backBy], ["notes", g.notes],
    ["budget", page.budget !== null ? `everyone's comfortable up to $${page.budget}` : null],
  ].filter(([, v]) => v) as [string, string][];
  if (facts.length) {
    doc.y = y; ensureSpace(doc, 40 + facts.length * 18); y = doc.y;
    const boxH = 28 + facts.length * 16;
    doc.roundedRect(L, y, W, boxH, 10).fill(th.tint);
    sectionTitle(doc, th, "Good to know", L + 14, y + 12);
    let fy = y + 30;
    for (const [k, v] of facts) {
      doc.font("Helvetica").fontSize(10).fillColor(SOFT).text(k, L + 14, fy, { width: 90 });
      doc.font("Helvetica").fontSize(11).fillColor(INK).text(pdfSafe(v), L + 108, fy - 1, { width: W - 122 });
      fy = Math.max(doc.y, fy + 13) + 3;
    }
    y += boxH + 14;
  }

  // ---- 7. what changed
  if (page.changes.length) {
    doc.y = y; ensureSpace(doc, 30 + page.changes.length * 14); y = doc.y;
    y = sectionTitle(doc, th, "What changed", L, y);
    for (const c of page.changes) {
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(th.deep).text(`v${c.version}`, L, y, { width: 30 });
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(pdfSafe(c.summary), L + 30, y, { width: W - 30 });
      y = doc.y + 3;
    }
  }

  // ---- 8. footer on every page: a thin accent rule, page number, where the latest version lives
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing in the bottom margin must not start a new page
    const fy = doc.page.height - 44;
    doc.save().moveTo(L, fy - 8).lineTo(L + W, fy - 8).lineWidth(0.8).strokeColor(th.accent).opacity(0.4).stroke().restore();
    doc.font("Helvetica").fontSize(8.5).fillColor(SOFT)
      .text(pdfSafe(`page ${i + 1} of ${range.count}  ·  latest version always at ${pageUrl}`), L, fy, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  const buf = await done;
  if (cache.size > 50) cache.clear();
  cache.set(key, buf);
  return buf;
}

/** Initial circles with first names under them (organizer marked, maybes lighter). Returns the next y. */
function peopleCircles(doc: Doc, th: Theme, page: Page, x: number, y: number, w: number): number {
  const people = [...page.going.map((p: { name: string; organizer: boolean }) => ({ ...p, maybe: false })), ...page.maybe.map((n: string) => ({ name: n, organizer: false, maybe: true }))];
  if (!people.length) {
    doc.font("Helvetica").fontSize(11).fillColor(SOFT).text("nobody yet", x, y);
    return doc.y + 6;
  }
  const per = Math.max(1, Math.floor(w / 52));
  people.forEach((p, i) => {
    const cx = x + 18 + (i % per) * 52, cy = y + 16 + Math.floor(i / per) * 42;
    doc.save().opacity(p.maybe ? 0.45 : 1).circle(cx, cy, 14).fill(p.organizer ? th.accent : th.chip).restore();
    doc.font("Helvetica-Bold").fontSize(10).fillColor(p.organizer ? "#ffffff" : th.deep).text(pdfSafe(p.name.slice(0, 1).toUpperCase()), cx - 14, cy - 4, { width: 28, align: "center" });
    doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(pdfSafe(p.name + (p.maybe ? " (maybe)" : "")), cx - 25, cy + 17, { width: 50, align: "center", lineBreak: false });
  });
  return y + Math.ceil(people.length / per) * 42 + 4;
}
