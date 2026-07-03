import { db } from "@/db/client";
import { bankTransactions, invoices } from "@/db/schema";
import { appLog } from "@/lib/logger";
import { getActiveAiProvider } from "@/lib/ai-settings";
import {
  isoDateToExcelSerial,
  mapReceiptToDataRow,
  mergeWithMasterRow,
  normalizeInvoiceNo,
  type DataMasterRow,
  type ReceiptExtraction,
} from "@/lib/receipt-mapping";
import { storeReceiptImage, type StoredImage } from "@/lib/s3-image-store";

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
).replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";
const parsedAiRequestTimeout = Number(process.env.AI_REQUEST_TIMEOUT_MS);
const AI_REQUEST_TIMEOUT_MS =
  Number.isFinite(parsedAiRequestTimeout) && parsedAiRequestTimeout > 0
    ? parsedAiRequestTimeout
    : 600_000;

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ReceiptProcessingResult = {
  fileName: string;
  extraction: ReceiptExtraction;
  matchedFromMaster: boolean;
  masterInvoiceNo: string;
  transactionExists: boolean;
  matchedTransactions: Array<{
    id: number;
    transactionDate: string;
    invoiceReference: string | null;
    amountCents: number;
    status: string;
    description: string;
  }>;
  invoiceData: {
    id: number;
    invoiceNumber: string;
    vendorName: string;
    issueDate: string;
    dueDate: string;
    amountCents: number;
    status: string;
  } | null;
  tokenUsage: TokenUsage;
  imageStore: StoredImage;
  mappedRow: ReturnType<typeof mapReceiptToDataRow>;
};

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

function receiptExtractionPrompt(): string {
  return [
    "Extract fields from this cargo/transport receipt image and return STRICT JSON only.",
    "Image may be blurry, noisy, or skewed. Infer carefully and include alternatives.",
    "Use these keys exactly:",
    "template (sre_cargo | psr_travels | unknown), company_name, invoice_no, invoice_candidates, booking_date, receipt_no, received_from, consignor_name, consignee_name, to_deliver, city, qty, description, parcel_details, customer_code, customer_name, shipping_name, courier_name, header_remark, remarks, amount, raw_text",
    "Rules:",
    "1) booking_date format must be YYYY-MM-DD if possible, else keep original text.",
    "2) Check printed text, stamps, circled areas, and handwritten notes for invoice references.",
    "3) If only the last 4-6 digits of an invoice number are handwritten or circled, put that suffix in invoice_no when it is the clearest reference and include it in invoice_candidates.",
    "4) invoice_candidates should be an array of up to 5 likely invoice numbers or numeric suffixes when uncertain. Include plausible alternatives from both printed and handwritten text.",
    "5) Fill unknown scalar values with empty string and unknown arrays with [].",
    "6) raw_text must contain OCR text seen on image, including handwritten/circled digits when visible (best effort).",
    "7) Do not include markdown or extra text.",
  ].join("\n");
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
    if (digitsOnly.length >= 4) {
      values.add(digitsOnly);
    }
  };

  pushValue(extraction.invoiceNo);
  (extraction.invoiceCandidates ?? []).forEach(pushValue);

  const rawText = extraction.rawText ?? "";
  const fromText = rawText.match(/\d{4,14}/g) ?? [];
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

function normalizeText(value?: string): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textOverlapScore(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.9;
  }

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) {
    return 0;
  }

  let overlap = 0;
  aTokens.forEach((token) => {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  });

  return overlap / Math.max(aTokens.size, bTokens.size);
}

function resolveMasterInvoice(
  entries: Array<[string, DataMasterRow]>,
  extractedInvoiceNo: string,
  invoiceCandidates: string[] | undefined,
  numericCandidates: string[],
  context: {
    customerName: string;
    city: string;
    courierName: string;
    bookingDateSerial: string | number;
  },
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

  if (best) {
    return { invoiceNo: best.invoiceNo, row: best.row };
  }

  const normalizedCustomer = normalizeText(context.customerName);
  const normalizedCity = normalizeText(context.city);
  const normalizedCourier = normalizeText(context.courierName);

  let contextualBest: {
    invoiceNo: string;
    row: DataMasterRow;
    score: number;
  } | null = null;

  for (const [invoiceNo, row] of entries) {
    const normalizedMaster = normalizeInvoiceNo(invoiceNo);
    let score = 0;

    for (const candidate of allCandidates) {
      if (!candidate) {
        continue;
      }
      if (candidate.length >= 4 && normalizedMaster.endsWith(candidate)) {
        score += 3;
      } else if (
        candidate.length >= 6 &&
        (normalizedMaster.includes(candidate) ||
          candidate.includes(normalizedMaster))
      ) {
        score += 2;
      }
    }

    if (normalizedCustomer) {
      const masterCustomer = normalizeText(row.customerName);
      const masterShipping = normalizeText(row.shippingName);
      const customerScore = Math.max(
        textOverlapScore(normalizedCustomer, masterCustomer),
        textOverlapScore(normalizedCustomer, masterShipping),
      );
      if (customerScore >= 0.9) {
        score += 4;
      } else if (customerScore >= 0.5) {
        score += 2;
      }
    }

    if (normalizedCity) {
      const masterCity = normalizeText(row.city);
      if (
        masterCity &&
        (masterCity === normalizedCity || masterCity.includes(normalizedCity))
      ) {
        score += 2;
      }
    }

    if (normalizedCourier) {
      const masterCourier = normalizeText(row.courierName);
      const courierScore = textOverlapScore(normalizedCourier, masterCourier);
      if (courierScore >= 0.8) {
        score += 2;
      } else if (courierScore >= 0.5) {
        score += 1;
      }
    }

    if (context.bookingDateSerial && row.invoiceDate) {
      const bookingSerial =
        typeof context.bookingDateSerial === "number"
          ? context.bookingDateSerial
          : Number(context.bookingDateSerial);
      const masterSerial =
        typeof row.invoiceDate === "number"
          ? row.invoiceDate
          : Number(row.invoiceDate);
      if (!Number.isNaN(bookingSerial) && !Number.isNaN(masterSerial)) {
        const dayDiff = Math.abs(bookingSerial - masterSerial);
        if (dayDiff <= 3) {
          score += 2;
        } else if (dayDiff <= 7) {
          score += 1;
        }
      }
    }

    if (!contextualBest || score > contextualBest.score) {
      contextualBest = { invoiceNo, row, score };
    }
  }

  return contextualBest && contextualBest.score >= 5
    ? { invoiceNo: contextualBest.invoiceNo, row: contextualBest.row }
    : null;
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

async function extractFromImage(file: File): Promise<{
  extraction: ReceiptExtraction;
  tokenUsage: TokenUsage;
}> {
  const provider = await getActiveAiProvider();
  if (provider === "ollama") {
    return extractFromImageWithOllama(file);
  }
  if (provider === "openai") {
    return extractFromImageWithOpenAI(file);
  }

  throw new HttpError(
    500,
    `Unsupported AI provider "${provider}". Use "ollama" or "openai".`,
  );
}

async function extractFromImageWithOpenAI(file: File): Promise<{
  extraction: ReceiptExtraction;
  tokenUsage: TokenUsage;
}> {
  appLog("receipt.processor", "ocr_started", {
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
    provider: "openai",
    model: OPENAI_MODEL,
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    appLog("receipt.processor", "ocr_missing_openai_key", undefined, "error");
    throw new HttpError(
      500,
      "OPENAI_API_KEY is missing. Add it in .env.local and restart dev server.",
    );
  }

  const mimeType = file.type || "image/jpeg";
  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mimeType};base64,${base64}`;

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: receiptExtractionPrompt() },
              {
                type: "input_image",
                image_url: imageUrl,
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    appLog("receipt.processor", "ocr_request_failed", {
      fileName: file.name,
      provider: "openai",
      errorMessage,
    }, "error");
    throw new HttpError(502, `OCR provider request failed: ${errorMessage}`);
  }

  if (!response.ok) {
    const details = await response.text();
    appLog("receipt.processor", "ocr_failed", {
      fileName: file.name,
      status: response.status,
      details: details.slice(0, 500),
    }, "error");
    throw new HttpError(
      response.status,
      `OCR extraction failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as {
    output_text?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
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
    appLog("receipt.processor", "ocr_parse_failed", {
      fileName: file.name,
      outputPreview: outputText.slice(0, 500),
    }, "error");
    throw new HttpError(
      502,
      "OCR response parsing failed. Try a clearer image or a tighter crop around invoice details.",
    );
  }

  const result = {
    extraction: toExtraction(parsed),
    tokenUsage: {
      inputTokens: Number(payload.usage?.input_tokens ?? 0),
      outputTokens: Number(payload.usage?.output_tokens ?? 0),
      totalTokens: Number(payload.usage?.total_tokens ?? 0),
    },
  };

  appLog("receipt.processor", "ocr_completed", {
    fileName: file.name,
    provider: "openai",
    invoiceNo: result.extraction.invoiceNo ?? null,
    candidateCount: result.extraction.invoiceCandidates?.length ?? 0,
    totalTokens: result.tokenUsage.totalTokens,
  });

  return result;
}

async function extractFromImageWithOllama(file: File): Promise<{
  extraction: ReceiptExtraction;
  tokenUsage: TokenUsage;
}> {
  appLog("receipt.processor", "ocr_started", {
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
    provider: "ollama",
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: receiptExtractionPrompt(),
        images: [base64],
        stream: false,
        format: "json",
        options: {
          temperature: 0,
        },
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    appLog("receipt.processor", "ocr_request_failed", {
      fileName: file.name,
      provider: "ollama",
      baseUrl: OLLAMA_BASE_URL,
      errorMessage,
    }, "error");
    throw new HttpError(
      502,
      `Ollama OCR request failed at ${OLLAMA_BASE_URL}. Check that Ollama is running and ${OLLAMA_MODEL} is installed. Details: ${errorMessage}`,
    );
  }

  if (!response.ok) {
    const details = await response.text();
    appLog("receipt.processor", "ocr_failed", {
      fileName: file.name,
      provider: "ollama",
      status: response.status,
      details: details.slice(0, 500),
    }, "error");
    throw new HttpError(
      response.status,
      `OCR extraction failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as {
    response?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const outputText = payload.response ?? "";
  const parsed = tryParseJsonObject(outputText);
  if (!parsed) {
    appLog("receipt.processor", "ocr_parse_failed", {
      fileName: file.name,
      provider: "ollama",
      outputPreview: outputText.slice(0, 500),
    }, "error");
    throw new HttpError(
      502,
      "OCR response parsing failed. Try a clearer image or a tighter crop around invoice details.",
    );
  }

  const inputTokens = Number(payload.prompt_eval_count ?? 0);
  const outputTokens = Number(payload.eval_count ?? 0);
  const result = {
    extraction: toExtraction(parsed),
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };

  appLog("receipt.processor", "ocr_completed", {
    fileName: file.name,
    provider: "ollama",
    invoiceNo: result.extraction.invoiceNo ?? null,
    candidateCount: result.extraction.invoiceCandidates?.length ?? 0,
    totalTokens: result.tokenUsage.totalTokens,
  });

  return result;
}

export async function processReceiptImages(
  files: File[],
): Promise<ReceiptProcessingResult[]> {
  appLog("receipt.processor", "processing_started", {
    fileCount: files.length,
    files: files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
    })),
  });

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      appLog("receipt.processor", "unsupported_file_type", {
        fileName: file.name,
        mimeType: file.type,
      }, "warn");
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

  appLog("receipt.processor", "db_rows_loaded", {
    transactionCount: transactions.length,
    invoiceCount: invoiceRows.length,
  });

  if (!invoiceRows.length) {
    appLog("receipt.processor", "no_invoices_found", undefined, "warn");
    throw new HttpError(400, "No invoices found. Upload invoices table first.");
  }

  const masterEntries = invoiceRows.map((invoiceRow) => [
    invoiceRow.invoiceNumber,
    invoiceRowToMasterRow(invoiceRow),
  ]) as Array<[string, DataMasterRow]>;
  const invoiceByNormalized = new Map<string, typeof invoices.$inferSelect>();
  invoiceRows.forEach((invoiceRow) => {
    const normalized = normalizeInvoiceNo(invoiceRow.invoiceNumber);
    if (normalized && !invoiceByNormalized.has(normalized)) {
      invoiceByNormalized.set(normalized, invoiceRow);
    }
  });

  const results = await Promise.all(
    files.map(async (file) => {
      appLog("receipt.processor", "file_processing_started", {
        fileName: file.name,
      });

      const [imageStore, ocrResult] = await Promise.all([
        storeReceiptImage(file),
        extractFromImage(file),
      ]);
      const { extraction, tokenUsage } = ocrResult;
      const mappedFromImage = mapReceiptToDataRow(extraction);
      const numericCandidates = collectNumericCandidates(extraction);
      const masterLookup = resolveMasterInvoice(
        masterEntries,
        mappedFromImage.invoiceNo,
        extraction.invoiceCandidates,
        numericCandidates,
        {
          customerName: mappedFromImage.customerName,
          city: mappedFromImage.city,
          courierName: mappedFromImage.courierName,
          bookingDateSerial: mappedFromImage.invoiceDate,
        },
      );
      const masterRow = masterLookup?.row;
      const dataRow = mergeWithMasterRow(mappedFromImage, masterRow);
      const resolvedInvoiceNo = normalizeInvoiceNo(
        masterLookup?.invoiceNo || dataRow.invoiceNo,
      );
      const matchedInvoice = resolvedInvoiceNo
        ? invoiceByNormalized.get(resolvedInvoiceNo)
        : undefined;
      const transactionHits = transactions.filter((tx) => {
        const reference = normalizeInvoiceNo(tx.invoiceReference ?? "");
        const description = normalizeInvoiceNo(tx.description ?? "");
        return (
          Boolean(resolvedInvoiceNo) &&
          (reference === resolvedInvoiceNo ||
            description.includes(resolvedInvoiceNo))
        );
      });

      const result = {
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
        invoiceData: matchedInvoice
          ? {
              id: matchedInvoice.id,
              invoiceNumber: matchedInvoice.invoiceNumber,
              vendorName: matchedInvoice.vendorName,
              issueDate: matchedInvoice.issueDate,
              dueDate: matchedInvoice.dueDate,
              amountCents: matchedInvoice.amountCents,
              status: matchedInvoice.status,
            }
          : null,
        tokenUsage,
        imageStore,
        mappedRow: dataRow,
      };

      appLog("receipt.processor", "file_processing_completed", {
        fileName: file.name,
        extractedInvoiceNo: mappedFromImage.invoiceNo,
        resolvedInvoiceNo,
        masterInvoiceNo: result.masterInvoiceNo,
        matchedInvoiceNumber: result.invoiceData?.invoiceNumber ?? null,
        transactionHitCount: transactionHits.length,
        imageStoreKey: imageStore.key,
      });

      return result;
    }),
  );

  appLog("receipt.processor", "processing_completed", {
    fileCount: files.length,
    resultCount: results.length,
  });

  return results;
}
