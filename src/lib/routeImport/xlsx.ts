import { ImportError, LIMITS } from "./types";
import { listZip, readText } from "./zip";

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

function colIndex(ref: string): number {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out += m[1] ?? "";
  return unescapeXml(out);
}

/** Lê a primeira planilha de um .xlsx (sem dependências externas). Devolve linhas de texto. */
export async function readXlsx(buf: Uint8Array): Promise<string[][]> {
  let entries;
  try {
    entries = listZip(buf);
  } catch {
    throw new ImportError("Este não parece ser um arquivo .xlsx válido.");
  }
  const wb = await readText(buf, entries, "xl/workbook.xml");
  if (wb === null) throw new ImportError("Este não parece ser um arquivo .xlsx válido (sem workbook).");
  const rels = (await readText(buf, entries, "xl/_rels/workbook.xml.rels")) ?? "";

  const sheetTag = /<sheet\b[^>]*>/.exec(wb);
  let target = "worksheets/sheet1.xml";
  if (sheetTag) {
    const rid = attr(sheetTag[0], "r:id");
    const relRe = /<Relationship\b[^>]*>/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(rels))) {
      if (rid !== null && attr(rm[0], "Id") === rid) {
        target = attr(rm[0], "Target") ?? target;
        break;
      }
    }
  }
  const path = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
  const sheetXml = await readText(buf, entries, path);
  if (sheetXml === null) throw new ImportError("Não encontrei a primeira planilha dentro do arquivo.");

  const shared: string[] = [];
  const ss = await readText(buf, entries, "xl/sharedStrings.xml");
  if (ss) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ss))) shared.push(textOf(m[1] ?? ""));
  }

  const rows: string[][] = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  let autoRow = 0;
  while ((rm = rowRe.exec(sheetXml))) {
    autoRow++;
    const rn = parseInt(attr(rm[1] ?? "", "r") ?? "", 10);
    const rowIdx = Number.isFinite(rn) ? rn - 1 : autoRow - 1;
    if (rowIdx > LIMITS.rows + 1) throw new ImportError(`A planilha tem mais de ${LIMITS.rows} linhas.`);
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    let autoCol = 0;
    const body = rm[2] ?? "";
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] ?? "";
      const ref = attr(attrs, "r");
      const col = ref ? colIndex(ref) : autoCol;
      autoCol = col + 1;
      const t = attr(attrs, "t");
      const inner = cm[2] ?? "";
      let val = "";
      if (t === "inlineStr") val = textOf(inner);
      else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? unescapeXml(v[1] ?? "") : "";
        if (t === "s") val = shared[parseInt(raw, 10)] ?? "";
        else if (t === "b") val = raw === "1" ? "VERDADEIRO" : "FALSO";
        else val = raw;
      }
      while (cells.length < col) cells.push("");
      cells[col] = val;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = cells;
  }
  return rows;
}
