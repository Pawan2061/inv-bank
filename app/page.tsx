"use client";

import { useEffect, useRef, useState } from "react";

type Invoice = {
  id: number;
  invoiceNumber: string;
  vendorName: string;
  issueDate: string;
  dueDate: string;
  amountCents: number;
  status: string;
};

type DashboardPayload = {
  invoices: Invoice[];
  whatsappMessages: WhatsAppHistoryRow[];
};

type ReceiptResult = {
  fileName?: string;
  masterInvoiceNo?: string;
  imageStore?: ImageStore;
  invoiceData?: {
    id: number;
    invoiceNumber: string;
    vendorName: string;
    issueDate: string;
    dueDate: string;
    amountCents: number;
    status: string;
  } | null;
  mappedRow?: {
    invoiceNo?: string;
    customerName?: string;
    city?: string;
    courierName?: string;
  };
  tokenUsage?: TokenUsage;
};

type WhatsAppHistoryRow = {
  id: number;
  messageId: string;
  fromNumber: string;
  profileName: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaUrl: string | null;
  mediaS3Key: string | null;
  status: string;
  responseText: string | null;
  errorMessage: string | null;
  result: ReceiptResult | null;
  createdAt: string;
};

type ImageStore = {
  bucket: string;
  region: string;
  key: string;
  url: string;
};

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ReceiptMappingResult = {
  fileName: string;
  previewUrl?: string;
  imageStore?: ImageStore;
  matchedFromMaster: boolean;
  masterInvoiceNo: string;
  transactionExists: boolean;
  invoiceData?: {
    id: number;
    invoiceNumber: string;
    vendorName: string;
    issueDate: string;
    dueDate: string;
    amountCents: number;
    status: string;
  } | null;
  tokenUsage?: TokenUsage;
  mappedRow: {
    invoiceNo: string;
    customerName: string;
    city: string;
    courierName: string;
  };
};

type Action = "uploadInvoices" | "uploadReceipts";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function invoiceFromReceiptResult(result?: ReceiptResult | null): string {
  return (
    result?.masterInvoiceNo ||
    result?.invoiceData?.invoiceNumber ||
    result?.mappedRow?.invoiceNo ||
    ""
  );
}

function TokenUsageDetails({ tokenUsage }: { tokenUsage?: TokenUsage | null }) {
  if (!tokenUsage) {
    return <span className="text-xs text-zinc-500">-</span>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-500">In: {tokenUsage.inputTokens}</p>
      <p className="text-xs text-zinc-500">Out: {tokenUsage.outputTokens}</p>
      <p className="text-xs font-medium text-zinc-700">
        Total: {tokenUsage.totalTokens}
      </p>
    </div>
  );
}

function ReceiptMediaPreview({
  fileName,
  imageStore,
  mediaId,
  mediaMimeType,
  previewUrl,
  size = "sm",
  onPreview,
}: {
  fileName?: string | null;
  imageStore?: ImageStore | null;
  mediaId?: string | null;
  mediaMimeType?: string | null;
  previewUrl?: string | null;
  size?: "sm" | "md";
  onPreview: (preview: { url: string; name: string }) => void;
}) {
  const imageUrl = imageStore?.url ?? previewUrl;
  const imageName = fileName || mediaId || "Receipt";
  const imageSize = size === "md" ? "h-16 w-16" : "h-14 w-14";

  if (imageUrl) {
    return (
      <button
        type="button"
        onClick={() => onPreview({ url: imageUrl, name: imageName })}
        className="rounded-md focus:outline-none focus:ring-2 focus:ring-zinc-400"
      >
        <img
          src={imageUrl}
          alt={imageName}
          className={`${imageSize} rounded-md border border-zinc-200 object-cover`}
        />
      </button>
    );
  }

  if (mediaId) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-700">{mediaMimeType || "image"}</p>
        <p className="max-w-48 truncate text-xs text-zinc-500">{mediaId}</p>
      </div>
    );
  }

  return <span className="text-xs text-zinc-500">{fileName || "-"}</span>;
}

function whatsappMediaPreviewUrl(row: WhatsAppHistoryRow): string | null {
  if (row.mediaUrl) {
    return row.mediaUrl;
  }
  if (!row.mediaId) {
    return null;
  }
  return `/api/whatsapp/media?messageId=${encodeURIComponent(row.messageId)}`;
}

async function parseApiResponse(
  response: Response,
): Promise<{ message?: string; error?: string }> {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as { message?: string; error?: string };
  } catch {
    return {
      error: `Non-JSON response (${response.status}): ${raw.slice(0, 180)}`,
    };
  }
}

export default function Home() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">(
    "success",
  );
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [receiptMappings, setReceiptMappings] = useState<ReceiptMappingResult[]>(
    [],
  );
  const [activePreview, setActivePreview] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const invoicesInputRef = useRef<HTMLInputElement | null>(null);
  const receiptsInputRef = useRef<HTMLInputElement | null>(null);

  async function loadDashboard() {
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) {
        throw new Error("Failed to fetch invoice data.");
      }
      const payload = (await response.json()) as DashboardPayload;
      setData(payload);
    } catch (error) {
      setMessageType("error");
      setMessage(
        error instanceof Error ? error.message : "Unknown dashboard error.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function uploadInvoicesTable() {
    const file = invoiceFile;
    if (!file) {
      invoicesInputRef.current?.click();
      return;
    }

    setActionLoading("uploadInvoices");
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload/invoices", {
        method: "POST",
        body: formData,
      });
      const payload = await parseApiResponse(response);

      if (!response.ok) {
        throw new Error(
          payload.error ?? `Upload failed with status ${response.status}.`,
        );
      }

      setMessageType("success");
      setMessage(payload.message ?? "Invoices uploaded.");
      setInvoiceFile(null);
      await loadDashboard();
    } catch (error) {
      setMessageType("error");
      setMessage(
        error instanceof Error ? error.message : "Unknown upload error.",
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function uploadReceiptImages() {
    if (!receiptFiles.length) {
      receiptsInputRef.current?.click();
      return;
    }

    setActionLoading("uploadReceipts");
    setMessage("");

    try {
      const formData = new FormData();
      receiptFiles.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/upload/receipts", {
        method: "POST",
        body: formData,
      });

      const raw = await response.text();
      const payload = raw
        ? (JSON.parse(raw) as {
            message?: string;
            error?: string;
            rows?: ReceiptMappingResult[];
          })
        : {};

      if (!response.ok) {
        throw new Error(
          payload.error ?? `Image upload failed with status ${response.status}.`,
        );
      }

      const previewUrls = receiptFiles.map((file) => URL.createObjectURL(file));
      setReceiptMappings((previous) => {
        previous.forEach((row) => {
          if (row.previewUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(row.previewUrl);
          }
        });
        return (payload.rows ?? []).map((row, index) => ({
          ...row,
          previewUrl: row.imageStore?.url ?? previewUrls[index],
        }));
      });
      setReceiptFiles([]);
      setMessageType("success");
      setMessage(payload.message ?? "Receipts processed.");
    } catch (error) {
      setMessageType("error");
      setMessage(
        error instanceof Error ? error.message : "Unknown receipt upload error.",
      );
    } finally {
      setActionLoading(null);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(
    () => () => {
      receiptMappings.forEach((row) => {
        if (row.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(row.previewUrl);
        }
      });
    },
    [receiptMappings],
  );

  const manualUnmatchedReceipts = receiptMappings.filter((row) => !row.invoiceData);
  const whatsappUnmatchedReceipts =
    data?.whatsappMessages?.filter(
      (row) => row.mediaId && row.result && !row.result.invoiceData,
    ) ?? [];

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10">
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-zinc-900">
          Invoice Verification
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          1) Upload invoice table once. 2) Upload receipt images to verify with AI.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="mb-2 text-sm font-medium text-zinc-800">
              Upload Invoices Table (CSV/Excel)
            </p>
            <input
              ref={invoicesInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                setInvoiceFile(event.target.files?.[0] ?? null);
                setMessage("");
              }}
              className="w-full text-sm text-zinc-700"
            />
            <button
              type="button"
              onClick={uploadInvoicesTable}
              disabled={actionLoading !== null}
              className="mt-3 rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
            >
              {actionLoading === "uploadInvoices"
                ? "Uploading..."
                : "Upload Invoices"}
            </button>
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="mb-2 text-sm font-medium text-zinc-800">
              Upload Receipt Images
            </p>
            <input
              ref={receiptsInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                setReceiptFiles(Array.from(event.target.files ?? []));
                setMessage("");
              }}
              className="w-full text-sm text-zinc-700"
            />
            <button
              type="button"
              onClick={uploadReceiptImages}
              disabled={actionLoading !== null}
              className="mt-3 rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
            >
              {actionLoading === "uploadReceipts"
                ? "Matching..."
                : "Match Receipt"}
            </button>
          </div>
        </div>

        {message ? (
          <p
            className={`mt-4 text-sm ${messageType === "error" ? "text-red-700" : "text-emerald-700"}`}
          >
            {message}
          </p>
        ) : null}
      </section>

      {loading ? (
        <p className="mt-6 text-sm text-zinc-600">Loading invoice data...</p>
      ) : (
        <>
          <section className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <header className="border-b border-zinc-200 px-5 py-3">
              <h3 className="text-base font-semibold text-zinc-900">
                Invoices In DB
              </h3>
            </header>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-zinc-600">
                  <tr>
                    <th className="px-4 py-2">Invoice</th>
                    <th className="px-4 py-2">Customer</th>
                    <th className="px-4 py-2">Issue Date</th>
                    <th className="px-4 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.invoices?.length ? (
                    data.invoices.map((invoice) => (
                      <tr key={invoice.id} className="border-t border-zinc-100">
                        <td className="px-4 py-2">{invoice.invoiceNumber}</td>
                        <td className="px-4 py-2">{invoice.vendorName}</td>
                        <td className="px-4 py-2">{invoice.issueDate}</td>
                        <td className="px-4 py-2">
                          {formatCents(invoice.amountCents)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={4}>
                        No invoices loaded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 overflow-hidden rounded-xl border border-amber-200 bg-white">
            <header className="border-b border-amber-100 bg-amber-50 px-5 py-3">
              <h3 className="text-base font-semibold text-zinc-900">
                Unmatched Receipts
              </h3>
            </header>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-white text-left text-zinc-600">
                  <tr>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Image / Media</th>
                    <th className="px-4 py-2">Detected Invoice</th>
                    <th className="px-4 py-2">Customer</th>
                    <th className="px-4 py-2">City</th>
                    <th className="px-4 py-2">Courier</th>
                    <th className="px-4 py-2">Token Usage</th>
                    <th className="px-4 py-2">Sender / Status</th>
                  </tr>
                </thead>
                <tbody>
                  {manualUnmatchedReceipts.map((row, index) => (
                    <tr
                      key={`manual-${row.fileName}-${index}`}
                      className="border-t border-zinc-100"
                    >
                      <td className="px-4 py-2 text-xs font-medium text-zinc-700">
                        Upload
                      </td>
                      <td className="px-4 py-2">
                        <ReceiptMediaPreview
                          fileName={row.fileName}
                          imageStore={row.imageStore}
                          previewUrl={row.previewUrl}
                          onPreview={setActivePreview}
                        />
                      </td>
                      <td className="px-4 py-2">
                        {row.masterInvoiceNo || row.mappedRow.invoiceNo || "-"}
                      </td>
                      <td className="px-4 py-2">{row.mappedRow.customerName || "-"}</td>
                      <td className="px-4 py-2">{row.mappedRow.city || "-"}</td>
                      <td className="px-4 py-2">{row.mappedRow.courierName || "-"}</td>
                      <td className="px-4 py-2">
                        <TokenUsageDetails tokenUsage={row.tokenUsage} />
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">
                        Current upload session
                      </td>
                    </tr>
                  ))}

                  {whatsappUnmatchedReceipts.map((row) => (
                    <tr key={`whatsapp-${row.id}`} className="border-t border-zinc-100">
                      <td className="px-4 py-2 text-xs font-medium text-zinc-700">
                        WhatsApp
                      </td>
                      <td className="px-4 py-2">
                        <ReceiptMediaPreview
                          fileName={row.result?.fileName}
                          imageStore={row.result?.imageStore}
                          previewUrl={whatsappMediaPreviewUrl(row)}
                          mediaId={row.mediaId}
                          mediaMimeType={row.mediaMimeType}
                          onPreview={setActivePreview}
                        />
                      </td>
                      <td className="px-4 py-2">
                        {invoiceFromReceiptResult(row.result) || "-"}
                      </td>
                      <td className="px-4 py-2">
                        {row.result?.mappedRow?.customerName || "-"}
                      </td>
                      <td className="px-4 py-2">
                        {row.result?.mappedRow?.city || "-"}
                      </td>
                      <td className="px-4 py-2">
                        {row.result?.mappedRow?.courierName || "-"}
                      </td>
                      <td className="px-4 py-2">
                        <TokenUsageDetails tokenUsage={row.result?.tokenUsage} />
                      </td>
                      <td className="px-4 py-2">
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-zinc-700">
                            {row.profileName || row.fromNumber}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {formatDateTime(row.createdAt)} | {row.status}
                          </p>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {!manualUnmatchedReceipts.length && !whatsappUnmatchedReceipts.length ? (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={8}>
                        No unmatched receipts yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <header className="border-b border-zinc-200 px-5 py-3">
              <h3 className="text-base font-semibold text-zinc-900">
                WhatsApp Automation History
              </h3>
            </header>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-zinc-600">
                  <tr>
                    <th className="px-4 py-2">Time</th>
                    <th className="px-4 py-2">Sender</th>
                    <th className="px-4 py-2">Media</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Token Usage</th>
                    <th className="px-4 py-2">Reply</th>
                    <th className="px-4 py-2">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.whatsappMessages?.length ? (
                    data.whatsappMessages.map((row) => (
                      <tr key={row.id} className="border-t border-zinc-100">
                        <td className="whitespace-nowrap px-4 py-2">
                          {formatDateTime(row.createdAt)}
                        </td>
                        <td className="px-4 py-2">
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-zinc-800">
                              {row.profileName || "-"}
                            </p>
                            <p className="text-xs text-zinc-500">
                              {row.fromNumber}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <ReceiptMediaPreview
                            fileName={row.result?.fileName}
                            imageStore={row.result?.imageStore}
                            previewUrl={whatsappMediaPreviewUrl(row)}
                            mediaId={row.mediaId}
                            mediaMimeType={row.mediaMimeType}
                            onPreview={setActivePreview}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
                            {row.status}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <TokenUsageDetails tokenUsage={row.result?.tokenUsage} />
                        </td>
                        <td className="max-w-sm whitespace-pre-wrap px-4 py-2 text-xs text-zinc-700">
                          {row.responseText || "-"}
                        </td>
                        <td className="max-w-sm whitespace-pre-wrap px-4 py-2 text-xs text-red-700">
                          {row.errorMessage || "-"}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={7}>
                        No WhatsApp messages processed yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <header className="border-b border-zinc-200 px-5 py-3">
              <h3 className="text-base font-semibold text-zinc-900">
                Receipt Match Results
              </h3>
            </header>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-zinc-600">
                  <tr>
                    <th className="px-4 py-2">Uploaded Image</th>
                    <th className="px-4 py-2">File</th>
                    <th className="px-4 py-2">OCR Invoice</th>
                    <th className="px-4 py-2">Resolved Invoice</th>
                    <th className="px-4 py-2">Invoice In DB</th>
                    <th className="px-4 py-2">Txn Exists</th>
                    <th className="px-4 py-2">Customer</th>
                    <th className="px-4 py-2">City</th>
                    <th className="px-4 py-2">Courier</th>
                    <th className="px-4 py-2">Invoice Data</th>
                    <th className="px-4 py-2">Token Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {receiptMappings.length ? (
                    receiptMappings.map((row, index) => (
                      <tr
                        key={`${row.fileName}-${index}`}
                        className="border-t border-zinc-100"
                      >
                        <td className="px-4 py-2">
                          <ReceiptMediaPreview
                            fileName={row.fileName}
                            imageStore={row.imageStore}
                            previewUrl={row.previewUrl}
                            size="md"
                            onPreview={setActivePreview}
                          />
                        </td>
                        <td className="px-4 py-2">{row.fileName}</td>
                        <td className="px-4 py-2">{row.mappedRow.invoiceNo || "-"}</td>
                        <td className="px-4 py-2">{row.masterInvoiceNo || "-"}</td>
                        <td className="px-4 py-2">
                          {row.matchedFromMaster ? "Yes" : "No"}
                        </td>
                        <td className="px-4 py-2">
                          {row.transactionExists ? "Yes" : "No"}
                        </td>
                        <td className="px-4 py-2">
                          {row.mappedRow.customerName || "-"}
                        </td>
                        <td className="px-4 py-2">{row.mappedRow.city || "-"}</td>
                        <td className="px-4 py-2">
                          {row.mappedRow.courierName || "-"}
                        </td>
                        <td className="px-4 py-2">
                          {row.invoiceData ? (
                            <div className="space-y-1">
                              <p className="text-xs text-zinc-700">
                                {row.invoiceData.invoiceNumber}
                              </p>
                              <p className="text-xs text-zinc-500">
                                {row.invoiceData.vendorName}
                              </p>
                              <p className="text-xs text-zinc-500">
                                {row.invoiceData.issueDate} |{" "}
                                {formatCents(row.invoiceData.amountCents)}
                              </p>
                              <p className="text-xs text-zinc-500">
                                Due: {row.invoiceData.dueDate}
                              </p>
                            </div>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <TokenUsageDetails tokenUsage={row.tokenUsage} />
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={11}>
                        No receipt matches yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {activePreview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setActivePreview(null)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] rounded-lg bg-white p-2"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setActivePreview(null)}
              className="absolute right-2 top-2 rounded bg-zinc-900 px-2 py-1 text-xs text-white"
            >
              Close
            </button>
            <img
              src={activePreview.url}
              alt={activePreview.name}
              className="max-h-[85vh] max-w-[85vw] rounded-md object-contain"
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}
