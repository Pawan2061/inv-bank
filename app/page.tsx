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
};

type ReceiptMappingResult = {
  fileName: string;
  matchedFromMaster: boolean;
  masterInvoiceNo: string;
  transactionExists: boolean;
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

      setReceiptMappings(payload.rows ?? []);
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
                    <th className="px-4 py-2">File</th>
                    <th className="px-4 py-2">OCR Invoice</th>
                    <th className="px-4 py-2">Resolved Invoice</th>
                    <th className="px-4 py-2">Invoice In DB</th>
                    <th className="px-4 py-2">Txn Exists</th>
                    <th className="px-4 py-2">Customer</th>
                    <th className="px-4 py-2">City</th>
                    <th className="px-4 py-2">Courier</th>
                  </tr>
                </thead>
                <tbody>
                  {receiptMappings.length ? (
                    receiptMappings.map((row) => (
                      <tr key={row.fileName} className="border-t border-zinc-100">
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
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={8}>
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
    </main>
  );
}
