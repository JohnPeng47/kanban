#!/usr/bin/env node
// Detect box bounds and child-text wall distances from a diagram source.
//
// Two source formats are supported (auto-detected by extension):
//   .txt  – ASCII diagram (```diagram + ```entities fenced blocks)
//   .html – SVG diagram (entities encoded as <g data-interactive="EXX">)
//
// When the paired file is also present, both formats are reported side-by-side
// per box so you can visually compare.
//
// Output is grouped by box. Each text child of a box is shown as a tuple
//   (top, bot, left, right)
// of distances from each of the four walls of its parent box. Units are
// chars/lines for ASCII, SVG user-space px for SVG.
//
// Usage:
//   node scripts/diagram/detect-box-bounds.mjs <file.txt|.html>
//   node scripts/diagram/detect-box-bounds.mjs <ascii.txt> <svg.html>
//   add --json to also emit a structured dump.

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { argv, exit } from "node:process";

// ─── ASCII PARSING ──────────────────────────────────────────────────────────

const FENCE_RE = (name) =>
  new RegExp("```" + name + "\\n([\\s\\S]*?)\\n```", "m");

function extractFence(text, name) {
  const m = text.match(FENCE_RE(name));
  return m ? m[1] : null;
}

function parseEntitiesBlock(block) {
  const lines = block.split("\n");
  const header = lines.find((l) =>
    /^#\s*name\s+id_type\s+id\s+parent\s+description/.test(l),
  );
  if (!header) {
    throw new Error(
      "entities block is missing the `# name id_type id parent description` header",
    );
  }
  let cursor = 0;
  const colOf = (label) => {
    const idx = header.indexOf(label, cursor);
    if (idx < 0) throw new Error(`entities header missing column "${label}"`);
    cursor = idx + label.length;
    return idx;
  };
  const cols = {
    name: colOf("name"),
    idType: colOf("id_type"),
    id: colOf("id"),
    parent: colOf("parent"),
    description: colOf("description"),
  };
  const slice = (line, start, end) =>
    line.length <= start ? "" : line.slice(start, end ?? line.length).trim();

  const entities = [];
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const idType = slice(raw, cols.idType, cols.id);
    if (idType !== "box" && idType !== "text") continue;
    const id = slice(raw, cols.id, cols.parent);
    const parent = slice(raw, cols.parent, cols.description) || null;
    if (id) entities.push({ id, kind: idType, parent });
  }
  return entities;
}

function findAsciiMarker(lines, id) {
  const marker = `[${id}]`;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].indexOf(marker);
    if (c >= 0) return { line: i, col: c };
  }
  return null;
}

function findAsciiBoxBounds(lines, boxId) {
  const m = findAsciiMarker(lines, boxId);
  if (!m) return { id: boxId, error: "opening marker not found" };

  let top = -1;
  let left = -1;
  for (let i = m.line - 1; i >= 0; i--) {
    const line = lines[i];
    let bestCol = -1;
    for (let j = 0; j <= m.col && j < line.length; j++) {
      if (line[j] === "┌") bestCol = j;
    }
    if (bestCol >= 0) {
      top = i;
      left = bestCol;
      break;
    }
  }
  if (top < 0) return { id: boxId, error: "top-left ┌ not found" };

  const topLine = lines[top];
  let right = -1;
  for (let j = left + 1; j < topLine.length; j++) {
    if (topLine[j] === "┐") {
      right = j;
      break;
    }
  }
  if (right < 0) return { id: boxId, error: "top-right ┐ not found" };

  let bottom = -1;
  for (let i = top + 1; i < lines.length; i++) {
    if (left < lines[i].length && lines[i][left] === "└") {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return { id: boxId, error: "bottom-left └ not found" };

  return {
    id: boxId,
    top,
    left,
    bottom,
    right,
    width: right - left + 1,
    height: bottom - top + 1,
    markerLine: m.line,
    markerCol: m.col,
  };
}

function analyzeAscii(text) {
  const diagram = extractFence(text, "diagram");
  const entitiesBlock = extractFence(text, "entities");
  if (!diagram) throw new Error("no ```diagram block found");
  if (!entitiesBlock) throw new Error("no ```entities block found");

  const lines = diagram.split("\n");
  const entities = parseEntitiesBlock(entitiesBlock);

  const boxes = entities
    .filter((e) => e.kind === "box")
    .map((b) => ({ parent: b.parent, ...findAsciiBoxBounds(lines, b.id) }));
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  const childDistances = [];
  for (const t of entities) {
    if (t.kind !== "text" || !t.parent) continue;
    const box = boxById.get(t.parent);
    if (!box || box.error) {
      childDistances.push({ id: t.id, parent: t.parent, error: "parent box not resolved" });
      continue;
    }
    const m = findAsciiMarker(lines, t.id);
    if (!m) {
      childDistances.push({ id: t.id, parent: t.parent, error: "marker not found" });
      continue;
    }
    childDistances.push({
      id: t.id,
      parent: t.parent,
      pos: { line: m.line, col: m.col },
      top: m.line - box.top,
      bottom: box.bottom - m.line,
      left: m.col - box.left,
      right: box.right - m.col,
    });
  }

  return { format: "ascii", entities, boxes, childDistances };
}

// ─── SVG PARSING ────────────────────────────────────────────────────────────

// Layout heuristics used when estimating text bounding boxes for whitespace
// analysis. The diagrams use a monospace font (JetBrains Mono / Fira Code) so
// these constants are reasonable approximations of real glyph metrics.
const FONT_SIZE_DEFAULT = 11;
const CHAR_WIDTH_RATIO = 0.6; // approx em width for the mono fonts used
const TEXT_HEIGHT_RATIO = 1.2; // line-box height
const TEXT_BASELINE_RATIO = 0.8; // baseline-to-top distance

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[2];
  return attrs;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractCssFontSizes(svg) {
  const styleBlock = svg.match(/<style>([\s\S]*?)<\/style>/);
  const sizes = {};
  if (!styleBlock) return sizes;
  const ruleRe = /\.([\w-]+)\s*\{[^}]*?font-size:\s*(\d+(?:\.\d+)?)px/g;
  let m;
  while ((m = ruleRe.exec(styleBlock[1]))) sizes[m[1]] = parseFloat(m[2]);
  return sizes;
}

function pickFontSize(className, classMap, baseFontSize) {
  if (!className) return baseFontSize;
  for (const cls of className.split(/\s+/)) {
    if (classMap[cls] !== undefined) return classMap[cls];
  }
  return baseFontSize;
}

// Walk the SVG once and capture:
//   - entities[]   each <g data-interactive="…"> with its direct rect/text anchor
//   - boxContents  Map<boxId, { texts, rects }> – every <text>/<rect> visually
//                  contained inside that box but not inside a nested box. Box
//                  outlines of a child box are recorded as a 'rect' on the
//                  parent box (so the parent doesn't see that area as empty).
function parseSvgFull(svg) {
  const baseFontSize = parseFloat(
    svg.match(/<svg\b[^>]*\bfont-size="(\d+(?:\.\d+)?)"/)?.[1] ??
      FONT_SIZE_DEFAULT,
  );
  const cssFontSizes = extractCssFontSizes(svg);

  const entities = [];
  const boxContents = new Map();
  const stack = [];

  const innermostBox = (skipFromTop = 0) => {
    for (let i = stack.length - 1 - skipFromTop; i >= 0; i--) {
      const f = stack[i];
      if (f.entityIdx !== undefined && entities[f.entityIdx].kind === "box") {
        return entities[f.entityIdx].id;
      }
    }
    return null;
  };
  const ensureBox = (id) => {
    if (!boxContents.has(id)) boxContents.set(id, { texts: [], rects: [] });
    return boxContents.get(id);
  };

  const tagRe = /<(\/?)(g|rect|text)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const isClose = m[1] === "/";
    const tag = m[2];
    const attrsStr = m[3];
    const selfClose = m[4] === "/";

    if (isClose) {
      stack.pop();
      continue;
    }
    const attrs = parseAttrs(attrsStr);
    let entityIdx;

    if (tag === "g" && attrs["data-interactive"]) {
      entityIdx = entities.length;
      entities.push({
        id: attrs["data-interactive"],
        kind: attrs["data-entity-kind"] || null,
        parent: attrs["data-entity-parent"] || null,
        rect: null,
        text: null,
      });
    }

    if (tag === "text") {
      const x = parseFloat(attrs.x);
      const y = parseFloat(attrs.y);
      const fontSize = pickFontSize(attrs.class, cssFontSizes, baseFontSize);
      const openEnd = tagRe.lastIndex;
      const closeIdx = svg.indexOf("</text>", openEnd);
      const content = closeIdx >= 0 ? decodeEntities(svg.slice(openEnd, closeIdx)) : "";

      const top = stack[stack.length - 1];
      if (top && top.entityIdx !== undefined) {
        const ent = entities[top.entityIdx];
        if (!ent.text) ent.text = { x, y };
      }
      const boxId = innermostBox();
      if (boxId) {
        ensureBox(boxId).texts.push({
          x,
          y,
          fontSize,
          length: content.length,
          text: content,
        });
      }
    }

    if (tag === "rect") {
      const x = parseFloat(attrs.x);
      const y = parseFloat(attrs.y);
      const width = parseFloat(attrs.width);
      const height = parseFloat(attrs.height);
      const top = stack[stack.length - 1];
      let isBoxOutline = false;
      let ofBoxId = null;
      if (top && top.entityIdx !== undefined) {
        const ent = entities[top.entityIdx];
        if (!ent.rect) {
          ent.rect = { x, y, width, height };
          if (ent.kind === "box") {
            isBoxOutline = true;
            ofBoxId = ent.id;
          }
        }
      }
      // Box outline → contributes to the *grandparent* box's occupancy
      // (the box itself doesn't count its own wall as content).
      const boxId = isBoxOutline ? innermostBox(1) : innermostBox();
      if (boxId) {
        ensureBox(boxId).rects.push({
          x,
          y,
          width,
          height,
          isBoxOutline,
          ofBoxId,
        });
      }
    }

    if (!selfClose) stack.push({ tag, entityIdx });
  }
  return { entities, boxContents, baseFontSize, cssFontSizes };
}

function analyzeSvg(text) {
  const { entities: raw, boxContents } = parseSvgFull(text);

  const boxes = [];
  const textPos = new Map();
  const entitySummary = [];
  for (const e of raw) {
    entitySummary.push({ id: e.id, kind: e.kind, parent: e.parent });
    if (e.kind === "box") {
      if (!e.rect) {
        boxes.push({ id: e.id, parent: e.parent, error: "no <rect> child" });
      } else {
        const { x, y, width, height } = e.rect;
        boxes.push({
          id: e.id,
          parent: e.parent,
          top: y,
          left: x,
          bottom: y + height,
          right: x + width,
          width,
          height,
        });
      }
    } else if (e.kind === "text" && e.text) {
      textPos.set(e.id, e.text);
    }
  }
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  const childDistances = [];
  for (const e of raw) {
    if (e.kind !== "text" || !e.parent) continue;
    const box = boxById.get(e.parent);
    if (!box || box.error) {
      childDistances.push({ id: e.id, parent: e.parent, error: "parent box not resolved" });
      continue;
    }
    const pos = textPos.get(e.id);
    if (!pos) {
      childDistances.push({ id: e.id, parent: e.parent, error: "no <text> child" });
      continue;
    }
    childDistances.push({
      id: e.id,
      parent: e.parent,
      pos,
      top: pos.y - box.top,
      bottom: box.bottom - pos.y,
      left: pos.x - box.left,
      right: box.right - pos.x,
    });
  }

  return {
    format: "svg",
    entities: entitySummary,
    boxes,
    childDistances,
    boxContents,
  };
}

// ─── WHITESPACE ANALYSIS ────────────────────────────────────────────────────

function computeBoxWhitespace(box, contents) {
  // Two items belong to the same visual row only when their center-y values
  // are within ROW_TOL of each other. We use the *first* item's center as the
  // row's reference so iterative inclusion can't drag a row down indefinitely
  // (which is what produced the 70-px-tall mega-rows in earlier output).
  const ROW_TOL = 6;
  const items = [];

  for (const t of contents.texts) {
    const top = t.y - t.fontSize * TEXT_BASELINE_RATIO;
    const height = t.fontSize * TEXT_HEIGHT_RATIO;
    items.push({
      x: t.x,
      y: top,
      width: t.length * t.fontSize * CHAR_WIDTH_RATIO,
      height,
      centerY: top + height / 2,
      kind: "text",
      label: (t.text || "").trim().slice(0, 40),
    });
  }
  for (const r of contents.rects) {
    items.push({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      centerY: r.y + r.height / 2,
      kind: r.isBoxOutline ? "box" : "rect",
      label: r.ofBoxId ? `[${r.ofBoxId}]` : "<rect>",
    });
  }

  if (items.length === 0) {
    return { empty: true, padTop: box.height, padBottom: 0, gaps: [], rows: [] };
  }

  const sorted = [...items].sort((a, b) => a.centerY - b.centerY);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.centerY - last.refCenter) <= ROW_TOL) {
      last.items.push(it);
      last.yTop = Math.min(last.yTop, it.y);
      last.yBottom = Math.max(last.yBottom, it.y + it.height);
    } else {
      rows.push({
        refCenter: it.centerY,
        items: [it],
        yTop: it.y,
        yBottom: it.y + it.height,
      });
    }
  }
  // Display order = top-to-bottom of yTop, regardless of clustering insertion
  // order (a tall background rect can have a higher centerY than texts that
  // sit visually above its top edge).
  rows.sort((a, b) => a.yTop - b.yTop);

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.padLeft = row.items[0].x - box.left;
    const last = row.items[row.items.length - 1];
    row.padRight = box.right - (last.x + last.width);
    row.colGaps = [];
    for (let i = 0; i < row.items.length - 1; i++) {
      const a = row.items[i];
      const b = row.items[i + 1];
      row.colGaps.push(b.x - (a.x + a.width));
    }
  }

  const padTop = rows[0].yTop - box.top;
  const padBottom = box.bottom - rows[rows.length - 1].yBottom;
  const gaps = [];
  for (let i = 0; i < rows.length - 1; i++) {
    gaps.push(rows[i + 1].yTop - rows[i].yBottom);
  }
  return { empty: false, padTop, padBottom, gaps, rows };
}

function flagWhitespace(box, ws, opts = {}) {
  const absT = opts.absThreshold ?? 30;
  const fracT = opts.fracThreshold ?? 0.12;
  const flags = [];
  const checkV = (label, val) => {
    if (val > absT && val / box.height > fracT)
      flags.push({ label, value: val, frac: val / box.height });
  };
  const checkH = (label, val) => {
    if (val > absT && val / box.width > fracT)
      flags.push({ label, value: val, frac: val / box.width });
  };
  if (ws.empty) {
    flags.push({ label: "empty box", value: box.width * box.height, frac: 1 });
    return flags;
  }
  checkV("padTop", ws.padTop);
  checkV("padBottom", ws.padBottom);
  ws.gaps.forEach((g, i) => checkV(`row-gap[${i}→${i + 1}]`, g));
  ws.rows.forEach((row, i) => {
    // Single-item rows are usually short labels/headings; their right-padding
    // is "text doesn't fill the row" rather than misalignment. Skip those.
    if (row.items.length >= 2) {
      checkH(`row[${i}].padLeft`, row.padLeft);
      checkH(`row[${i}].padRight`, row.padRight);
    }
    row.colGaps.forEach((g, j) => checkH(`row[${i}].colGap[${j}→${j + 1}]`, g));
  });
  return flags;
}

// ─── PATH PAIRING ───────────────────────────────────────────────────────────

function derivePair(p) {
  // Project layout: diagrams/<format>/<name>.html ↔ docs/diagram/ascii/<format>/<name>.txt
  const segReplace = (path, from, to) => {
    const re = new RegExp(`(^|/)${from}/`);
    return re.test(path) ? path.replace(re, `$1${to}/`) : null;
  };
  if (p.endsWith(".html")) {
    const swapped = segReplace(p, "diagrams", "docs/diagram/ascii");
    const candidate = swapped && swapped.replace(/\.html$/, ".txt");
    return candidate && existsSync(candidate) ? candidate : null;
  }
  if (p.endsWith(".txt")) {
    const swapped = segReplace(p, "docs/diagram/ascii", "diagrams");
    const candidate = swapped && swapped.replace(/\.txt$/, ".html");
    return candidate && existsSync(candidate) ? candidate : null;
  }
  return null;
}

// ─── PRINTING (per-box sections) ────────────────────────────────────────────

function groupChildrenByParent(childDistances) {
  const m = new Map();
  for (const c of childDistances) {
    if (!c.parent) continue;
    if (!m.has(c.parent)) m.set(c.parent, []);
    m.get(c.parent).push(c);
  }
  return m;
}

function fmtAsciiBox(b) {
  if (!b) return "(not in source)";
  if (b.error) return `ERROR — ${b.error}`;
  // Display 1-indexed line/col so they match the source-file numbering.
  return (
    `top=${b.top + 1} left=${b.left + 1} ` +
    `bottom=${b.bottom + 1} right=${b.right + 1}  ` +
    `(${b.width}w × ${b.height}h)`
  );
}

function fmtSvgBox(b) {
  if (!b) return "(not in source)";
  if (b.error) return `ERROR — ${b.error}`;
  return (
    `top=${b.top} left=${b.left} bottom=${b.bottom} right=${b.right}  ` +
    `(${b.width}w × ${b.height}h)`
  );
}

function fmtChild(c) {
  if (!c) return "—";
  if (c.error) return `ERROR (${c.error})`;
  return `(${c.top}, ${c.bottom}, ${c.left}, ${c.right})`;
}

function printPerBoxReport(asciiResult, svgResult) {
  const aBoxes = new Map((asciiResult?.boxes ?? []).map((b) => [b.id, b]));
  const sBoxes = new Map((svgResult?.boxes ?? []).map((b) => [b.id, b]));
  const aChildByParent = groupChildrenByParent(asciiResult?.childDistances ?? []);
  const sChildByParent = groupChildrenByParent(svgResult?.childDistances ?? []);

  // Box order: ASCII order (source of truth) first, then any SVG-only boxes.
  const orderedBoxIds = [];
  const seen = new Set();
  for (const b of asciiResult?.boxes ?? []) {
    orderedBoxIds.push(b.id);
    seen.add(b.id);
  }
  for (const b of svgResult?.boxes ?? []) {
    if (!seen.has(b.id)) orderedBoxIds.push(b.id);
  }

  console.log(
    `Children tuple = (top, bottom, left, right) distance to parent walls.\n` +
      `ASCII units: chars/lines (1-indexed coords). SVG units: user-space px.\n`,
  );

  for (const boxId of orderedBoxIds) {
    const a = aBoxes.get(boxId);
    const s = sBoxes.get(boxId);
    const parent = a?.parent ?? s?.parent ?? null;

    console.log(`═══ Box ${boxId}${parent ? `   parent=${parent}` : ""} ═══`);
    if (asciiResult) console.log(`  ASCII bounds: ${fmtAsciiBox(a)}`);
    if (svgResult) console.log(`  SVG   bounds: ${fmtSvgBox(s)}`);

    // Text children (from either format).
    const aChildren = aChildByParent.get(boxId) ?? [];
    const sChildren = sChildByParent.get(boxId) ?? [];
    const aMap = new Map(aChildren.map((c) => [c.id, c]));
    const sMap = new Map(sChildren.map((c) => [c.id, c]));

    const childIds = [];
    for (const c of aChildren) childIds.push(c.id);
    for (const c of sChildren) if (!aMap.has(c.id)) childIds.push(c.id);

    if (childIds.length) {
      console.log(`  Text children:`);
      for (const cid of childIds) {
        const ac = aMap.get(cid);
        const sc = sMap.get(cid);
        const lines = [];
        if (asciiResult) lines.push(`ASCII ${fmtChild(ac)}`);
        if (svgResult) lines.push(`SVG ${fmtChild(sc)}`);
        console.log(`    ${cid.padEnd(6)}  ${lines.join("   ")}`);
      }
    }

    // Nested-box children — just list IDs; each gets its own section.
    const nestedBoxIds = orderedBoxIds.filter((id) => {
      const ab = aBoxes.get(id);
      const sb = sBoxes.get(id);
      return (ab && ab.parent === boxId) || (sb && sb.parent === boxId);
    });
    if (nestedBoxIds.length) {
      console.log(`  Box children: ${nestedBoxIds.join(", ")}  (see their own sections)`);
    }
    console.log("");
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

function main() {
  const args = argv.slice(2).filter((a) => !a.startsWith("--"));
  const wantsJson = argv.includes("--json");
  if (args.length === 0) {
    console.error(
      "usage: node scripts/diagram/detect-box-bounds.mjs <file.txt|.html> [other-format-file]",
    );
    exit(2);
  }

  let asciiPath = null;
  let svgPath = null;
  for (const p of args) {
    const ext = extname(p).toLowerCase();
    if (ext === ".txt") asciiPath = p;
    else if (ext === ".html" || ext === ".svg") svgPath = p;
    else {
      console.error(`unsupported file extension: ${p}`);
      exit(2);
    }
  }
  if (!asciiPath && svgPath) asciiPath = derivePair(svgPath);
  if (!svgPath && asciiPath) svgPath = derivePair(asciiPath);

  const asciiResult = asciiPath ? analyzeAscii(readFileSync(asciiPath, "utf8")) : null;
  const svgResult = svgPath ? analyzeSvg(readFileSync(svgPath, "utf8")) : null;

  if (asciiPath) console.log(`ASCII source: ${asciiPath}`);
  if (svgPath) console.log(`SVG source:   ${svgPath}`);
  console.log("");

  printPerBoxReport(asciiResult, svgResult);
  if (svgResult) printWhitespaceReport(svgResult);

  if (wantsJson) {
    console.log(JSON.stringify({ ascii: asciiResult, svg: svgResult }, null, 2));
  }
}

function printWhitespaceReport(svgResult, opts = {}) {
  const absT = opts.absThreshold ?? 30;
  const fracT = opts.fracThreshold ?? 0.12;
  console.log(`\n══ SVG whitespace findings ══`);
  console.log(
    `Flagging gaps/padding > ${absT}px AND > ${(fracT * 100).toFixed(0)}% ` +
      `of the box dimension along that axis. Units = SVG user-space px.\n`,
  );

  let flaggedAny = false;
  for (const box of svgResult.boxes) {
    if (box.error) continue;
    const contents = svgResult.boxContents.get(box.id) ?? { texts: [], rects: [] };
    const ws = computeBoxWhitespace(box, contents);
    const flags = flagWhitespace(box, ws, { absThreshold: absT, fracThreshold: fracT });
    if (flags.length === 0) continue;
    flaggedAny = true;

    console.log(`Box ${box.id}  (${box.width}w × ${box.height}h)`);
    for (const f of flags) {
      const px = `${f.value.toFixed(0)}px`;
      const pct = `${(f.frac * 100).toFixed(0)}%`;
      console.log(`  ⚠ ${f.label.padEnd(28)} ${px.padStart(7)} (${pct})`);
    }
    if (!ws.empty) {
      console.log(`  rows (top→bottom):`);
      ws.rows.forEach((row, i) => {
        const items = row.items
          .map((it) => {
            const tag =
              it.kind === "box"
                ? `box${it.label}`
                : it.kind === "rect"
                  ? "rect"
                  : `"${it.label}"`;
            return `${tag}@x=${it.x.toFixed(0)}`;
          })
          .join(", ");
        console.log(
          `    [${i}] y=${row.yTop.toFixed(0)}–${row.yBottom.toFixed(0)}: ${items}`,
        );
      });
    }
    console.log("");
  }

  if (!flaggedAny) {
    console.log(`  ✓ no boxes have whitespace exceeding thresholds`);
  }
}

main();
