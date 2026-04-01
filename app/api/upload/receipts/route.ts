import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bankTransactions, invoices } from "@/db/schema";
import {
  DATA_XLSX_HEADERS,
  isoDateToExcelSerial,
  mapReceiptToDataRow,
  mergeWithMasterRow,
  normalizeInvoiceNo,
  type DataMasterRow,
  type ReceiptExtraction,
} from "@/lib/receipt-mapping";

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const slice = raw.slice(first, last + 1);
      try {
        return JSON.parse(slice) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function toExtraction(value: Record<string, unknown>): ReceiptExtraction {
  const templateRaw = asString(value.template);
  const template =
    templateRaw === "sre_cargo" || templateRaw === "psr_travels"
      ? templateRaw
      : "unknown";

  return {
    template,
    companyName: asString(value.company_name),
    invoiceNo: asString(value.invoice_no),
    bookingDate: asString(value.booking_date),
    receiptNo: asString(value.receipt_no),
    receivedFrom: asString(value.received_from),
    consignorName: asString(value.consignor_name),
    consigneeName: asString(value.consignee_name),
    toDeliver: asString(value.to_deliver),
    city: asString(value.city),
    qty: asString(value.qty),
    description: asString(value.description),
    parcelDetails: asString(value.parcel_details),
    customerCode: asString(value.customer_code),
    customerName: asString(value.customer_name),
    shippingName: asString(value.shipping_name),
    courierName: asString(value.courier_name),
    headerRemark: asString(value.header_remark),
    remarks: asString(value.remarks),
    rawAmount: asString(value.amount),
    invoiceCandidates: Array.isArray(value.invoice_candidates)
      ? value.invoice_candidates.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    rawText: asString(value.raw_text),
  };
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > 1) {
    return false;
  }

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < lenA && j < lenB) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) {
      return false;
    }
    if (lenA > lenB) {
      i += 1;
    } else if (lenB > lenA) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  if (i < lenA || j < lenB) {
    edits += 1;
  }

  return edits <= 1;
}

function collectNumericCandidates(extraction: ReceiptExtraction): string[] {
  const values = new Set<string>();

  const pushValue = (raw?: string) => {
    if (!raw) {
      return;
    }
    const digitsOnly = raw.replace(/\D/g, "");
    if (digitsOnly.length >= 6) {
      values.add(digitsOnly);
    }
  };

  pushValue(extraction.invoiceNo);
  (extraction.invoiceCandidates ?? []).forEach(pushValue);

  const rawText = extraction.rawText ?? "";
  const fromText = rawText.match(/\d{6,14}/g) ?? [];
  fromText.forEach((value) => values.add(value));

  return [...values];
}

function similarityScore(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  let same = 0;
  for (let index = 0; index < minLen; index += 1) {
    if (a[index] === b[index]) {
      same += 1;
    }
  }
  return same / maxLen;
}

function resolveMasterInvoice(
  entries: Array<[string, DataMasterRow]>,
  extractedInvoiceNo: string,
  invoiceCandidates: string[] | undefined,
  numericCandidates: string[],
): { invoiceNo: string; row: DataMasterRow } | null {
  const normalizedInput = normalizeInvoiceNo(extractedInvoiceNo);
  const normalizedCandidates = (invoiceCandidates ?? [])
    .map((value) => normalizeInvoiceNo(value))
    .filter(Boolean);
  const allCandidates = [
    normalizedInput,
    ...normalizedCandidates,
    ...numericCandidates,
  ].filter(Boolean);

  for (const candidate of allCandidates) {
    const hit = entries.find(
      ([invoiceNo]) => normalizeInvoiceNo(invoiceNo) === candidate,
    );
    if (hit) {
      return { invoiceNo: hit[0], row: hit[1] };
    }
  }

  for (const candidate of allCandidates) {
    const hit = entries.find(([invoiceNo]) => {
      const master = normalizeInvoiceNo(invoiceNo);
      if (!master || !candidate) {
        return false;
      }
      if (master.includes(candidate) || candidate.includes(master)) {
        return candidate.length >= 6 && master.length >= 6;
      }
      return editDistanceAtMostOne(candidate, master);
    });
    if (hit) {
      return { invoiceNo: hit[0], row: hit[1] };
    }
  }

  let best: { invoiceNo: string; row: DataMasterRow; score: number } | null =
    null;
  for (const [invoiceNo, row] of entries) {
    const normalizedMaster = normalizeInvoiceNo(invoiceNo);
    for (const candidate of allCandidates) {
      const score = similarityScore(candidate, normalizedMaster);
      if (score < 0.88) {
        continue;
      }
      if (!best || score > best.score) {
        best = { invoiceNo, row, score };
      }
    }
  }

  return best ? { invoiceNo: best.invoiceNo, row: best.row } : null;
}

function invoiceRowToMasterRow(
  invoiceRow: typeof invoices.$inferSelect,
): DataMasterRow {
  return {
    invoiceNo: invoiceRow.invoiceNumber,
    invoiceDate: isoDateToExcelSerial(invoiceRow.issueDate),
    parcelDtls: "",
    customerCode: "",
    customerName: invoiceRow.vendorName,
    shippingName: invoiceRow.vendorName,
    city: "",
    courierName: "",
    headerRemark: "",
    remarks: "",
  };
}

async function extractFromImage(file: File): Promise<ReceiptExtraction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HttpError(
      500,
      "OPENAI_API_KEY is missing. Add it in .env.local and restart dev server.",
    );
  }

  const mimeType = file.type || "image/jpeg";
  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mimeType};base64,${base64}`;

  const prompt = [
    "Extract fields from this cargo/transport receipt image and return STRICT JSON only.",
    "Image may be blurry, noisy, or skewed. Infer carefully and include alternatives.",
    "Use these keys exactly:",
    "template (sre_cargo | psr_travels | unknown), company_name, invoice_no, invoice_candidates, booking_date, receipt_no, received_from, consignor_name, consignee_name, to_deliver, city, qty, description, parcel_details, customer_code, customer_name, shipping_name, courier_name, header_remark, remarks, amount, raw_text",
    "Rules:",
    "1) booking_date format must be YYYY-MM-DD if possible, else keep original text.",
    "2) invoice_candidates should be an array of up to 3 likely invoice numbers when uncertain.",
    "3) Fill unknown scalar values with empty string and unknown arrays with [].",
    "4) raw_text must contain OCR text seen on image (best effort).",
    "5) Do not include markdown or extra text.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: imageUrl,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new HttpError(
      response.status,
      `OCR extraction failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  let outputText = payload.output_text ?? "";
  if (!outputText && Array.isArray(payload.output)) {
    outputText = payload.output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("\n");
  }

  const parsed = tryParseJsonObject(outputText);
  if (!parsed) {
    throw new HttpError(
      502,
      "OCR response parsing failed. Try a clearer image or a tighter crop around invoice details.",
    );
  }

  return toExtraction(parsed);
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File);

    if (!files.length) {
      return NextResponse.json(
        { error: "Upload at least one image file in `files`." },
        { status: 400 },
      );
    }

    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        throw new HttpError(
          400,
          `Unsupported file "${file.name}". Please upload image files only.`,
        );
      }
    }

    const [transactions, invoiceRows] = await Promise.all([
      db.select().from(bankTransactions),
      db.select().from(invoices),
    ]);

    if (!invoiceRows.length) {
      throw new HttpError(400, "No invoices found. Upload invoices table first.");
    }

    const masterEntries = invoiceRows.map((invoiceRow) => [
      invoiceRow.invoiceNumber,
      invoiceRowToMasterRow(invoiceRow),
    ]) as Array<[string, DataMasterRow]>;

    const mapped = await Promise.all(
      files.map(async (file) => {
        const extraction = await extractFromImage(file);
        const mappedFromImage = mapReceiptToDataRow(extraction);
        const numericCandidates = collectNumericCandidates(extraction);
        const masterLookup = resolveMasterInvoice(
          masterEntries,
          mappedFromImage.invoiceNo,
          extraction.invoiceCandidates,
          numericCandidates,
        );
        const masterRow = masterLookup?.row;
        const dataRow = mergeWithMasterRow(mappedFromImage, masterRow);
        const resolvedInvoiceNo = normalizeInvoiceNo(dataRow.invoiceNo);
        const transactionHits = transactions.filter((tx) => {
          const reference = normalizeInvoiceNo(tx.invoiceReference ?? "");
          const description = normalizeInvoiceNo(tx.description ?? "");
          return (
            Boolean(resolvedInvoiceNo) &&
            (reference === resolvedInvoiceNo ||
              description.includes(resolvedInvoiceNo))
          );
        });

        return {
          fileName: file.name,
          extraction,
          matchedFromMaster: Boolean(masterRow),
          masterInvoiceNo: masterLookup?.invoiceNo ?? "",
          transactionExists: transactionHits.length > 0,
          matchedTransactions: transactionHits.slice(0, 5).map((tx) => ({
            id: tx.id,
            transactionDate: tx.transactionDate,
            invoiceReference: tx.invoiceReference,
            amountCents: tx.amountCents,
            status: tx.status,
            description: tx.description,
          })),
          mappedRow: dataRow,
        };
      }),
    );

    return NextResponse.json({
      message: `Processed ${mapped.length} receipt image(s).`,
      headers: DATA_XLSX_HEADERS,
      rows: mapped,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process receipt images.",
      },
      { status: 400 },
    );
  }
}
