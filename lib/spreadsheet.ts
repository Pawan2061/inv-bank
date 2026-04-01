import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseCsv } from "@/lib/csv";

const execFileAsync = promisify(execFile);

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function columnToIndex(columnRef: string): number {
  let index = 0;
  for (const char of columnRef) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function extractSharedStrings(xml: string): string[] {
  const items = [...xml.matchAll(/<si[\s\S]*?>([\s\S]*?)<\/si>/g)];
  return items.map((item) => {
    const textNodes = [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)];
    return decodeXml(textNodes.map((node) => node[1]).join(""));
  });
}

function parseWorksheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];

  for (const rowMatch of rowMatches) {
    const rowCells = rowMatch[1];
    const parsedRow: string[] = [];
    const cellMatches = [...rowCells.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];

    for (const cell of cellMatches) {
      const attrs = cell[1];
      const body = cell[2];
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      if (!refMatch) {
        continue;
      }

      const columnIndex = columnToIndex(refMatch[1]);
      const type = typeMatch?.[1] ?? "";
      const valueMatch = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const inlineMatch = body.match(/<is[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);

      let cellValue = "";
      if (type === "s" && valueMatch) {
        const index = Number.parseInt(valueMatch[1], 10);
        cellValue = Number.isFinite(index) ? sharedStrings[index] ?? "" : "";
      } else if (inlineMatch) {
        cellValue = decodeXml(inlineMatch[1]);
      } else if (valueMatch) {
        cellValue = decodeXml(valueMatch[1]);
      }

      parsedRow[columnIndex] = cellValue;
    }

    const normalizedRow = parsedRow.map((value) => (value ?? "").trim());
    if (normalizedRow.some((value) => value.length > 0)) {
      rows.push(normalizedRow);
    }
  }

  return rows;
}

async function parseXlsxFile(file: File): Promise<string[][]> {
  const tempDir = await mkdtemp(join(tmpdir(), "xlsx-upload-"));
  const tempPath = join(tempDir, file.name || "upload.xlsx");

  try {
    const binary = Buffer.from(await file.arrayBuffer());
    await writeFile(tempPath, binary);

    const { stdout: workbookXml } = await execFileAsync("unzip", ["-p", tempPath, "xl/workbook.xml"]);
    const sheetRelMatch = workbookXml.match(/<sheet[^>]*r:id="([^"]+)"/);
    if (!sheetRelMatch) {
      throw new Error("Could not locate first sheet in workbook.");
    }

    const relId = sheetRelMatch[1];
    const { stdout: relsXml } = await execFileAsync("unzip", ["-p", tempPath, "xl/_rels/workbook.xml.rels"]);
    const relPattern = new RegExp(`<Relationship[^>]*Id="${relId}"[^>]*Target="([^"]+)"`, "i");
    const relMatch = relsXml.match(relPattern);
    if (!relMatch) {
      throw new Error("Could not resolve worksheet path.");
    }

    const worksheetTarget = relMatch[1].replace(/^\//, "");
    const worksheetPath = worksheetTarget.startsWith("xl/")
      ? worksheetTarget
      : `xl/${worksheetTarget.replace(/^\.?\//, "")}`;

    const [{ stdout: worksheetXml }, sharedStringsResult] = await Promise.all([
      execFileAsync("unzip", ["-p", tempPath, worksheetPath]),
      execFileAsync("unzip", ["-p", tempPath, "xl/sharedStrings.xml"]).catch(() => ({ stdout: "" })),
    ]);

    const sharedStrings = sharedStringsResult.stdout
      ? extractSharedStrings(sharedStringsResult.stdout)
      : [];

    return parseWorksheetXml(worksheetXml, sharedStrings);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Failed to parse .xlsx file: ${error.message}` : "Failed to parse .xlsx file.",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function parseTabularUpload(file: File): Promise<string[][]> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    return parseCsv(await file.text());
  }

  if (lowerName.endsWith(".xlsx")) {
    return parseXlsxFile(file);
  }

  if (lowerName.endsWith(".xls")) {
    throw new Error("Legacy .xls is not supported yet. Please save as .xlsx or .csv and upload again.");
  }

  throw new Error("Unsupported file type. Upload .csv or .xlsx.");
}
