"use client";

import { useEffect, useMemo, useState } from "react";

type Invoice = {
  id: number;
  invoiceNumber: string;
  vendorName: string;
  issueDate: string;
  dueDate: string;
  amountCents: number;
  status: string;
};

type BankTransaction = {
  id: number;
  transactionDate: string;
  description: string;
  invoiceReference: string | null;
  amountCents: number;
  status: string;
};

type Match = {
  id: number;
  invoiceId: number;
  bankTransactionId: number;
  matchScore: number;
  reason: string;
  createdAt: string;
};

type DashboardPayload = {
  invoices: Invoice[];
  transactions: BankTransaction[];
  recentMatches: Match[];
  summary: {
    invoices: { total: number; matched: number };
    transactions: { total: number; matched: number };
  };
};

type Action = "seed" | "reconcile" | "uploadInvoices" | "uploadTransactions";

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
  const [message, setMessage] = useState<string>("");
  const [messageType, setMessageType] = useState<"success" | "error">(
    "success",
  );
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [transactionFile, setTransactionFile] = useState<File | null>(null);

  async function loadDashboard() {
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) {
        throw new Error("Failed to fetch dashboard data.");
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

  async function runAction(action: "seed" | "reconcile") {
    setActionLoading(action);
    setMessage("");
    try {
      const response = await fetch(`/api/${action}`, { method: "POST" });
      const payload = await parseApiResponse(response);
      if (!response.ok) {
        throw new Error(
          payload.error ??
            `${action} action failed with status ${response.status}.`,
        );
      }
      setMessageType("success");
      setMessage(payload.message ?? `${action} completed.`);
      await loadDashboard();
    } catch (error) {
      setMessageType("error");
      setMessage(
        error instanceof Error ? error.message : "Unknown action error.",
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function uploadCsv(kind: "invoices" | "transactions") {
    const file = kind === "invoices" ? invoiceFile : transactionFile;
    if (!file) {
      setMessageType("error");
      setMessage(`Please select a ${kind} CSV file first.`);
      return;
    }

    const loadingAction =
      kind === "invoices" ? "uploadInvoices" : "uploadTransactions";
    setActionLoading(loadingAction);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/upload/${kind}`, {
        method: "POST",
        body: formData,
      });
      const payload = await parseApiResponse(response);

      if (!response.ok) {
        throw new Error(
          payload.error ?? `CSV upload failed with status ${response.status}.`,
        );
      }

      setMessageType("success");
      setMessage(payload.message ?? "CSV uploaded.");
      if (kind === "invoices") {
        setInvoiceFile(null);
      } else {
        setTransactionFile(null);
      }
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

  useEffect(() => {
    loadDashboard();
  }, []);

  const unmatchedInvoices = useMemo(
    () => data?.invoices.filter((row) => row.status === "unmatched") ?? [],
    [data],
  );
  const unmatchedTransactions = useMemo(
    () => data?.transactions.filter((row) => row.status === "unmatched") ?? [],
    [data],
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10">
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-zinc-900">
          Invoice ↔ Bank Reconciliation POC
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          Upload CSVs, run matching, and persist reconciliation status updates .
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="mb-2 text-sm font-medium text-zinc-800">
              Import Invoices CSV
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) =>
                setInvoiceFile(event.target.files?.[0] ?? null)
              }
              className="w-full text-sm text-zinc-700"
            />
            <button
              type="button"
              onClick={() => uploadCsv("invoices")}
              disabled={actionLoading !== null || !invoiceFile}
              className="mt-3 rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
            >
              {actionLoading === "uploadInvoices"
                ? "Uploading..."
                : "Upload Invoices"}
            </button>
          </div>

          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="mb-2 text-sm font-medium text-zinc-800">
              Import Bank Transactions CSV
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) =>
                setTransactionFile(event.target.files?.[0] ?? null)
              }
              className="w-full text-sm text-zinc-700"
            />
            <button
              type="button"
              onClick={() => uploadCsv("transactions")}
              disabled={actionLoading !== null || !transactionFile}
              className="mt-3 rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
            >
              {actionLoading === "uploadTransactions"
                ? "Uploading..."
                : "Upload Transactions"}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => runAction("seed")}
            disabled={actionLoading !== null}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {actionLoading === "seed" ? "Seeding..." : "Seed Sample Data"}
          </button>
          <button
            type="button"
            onClick={() => runAction("reconcile")}
            disabled={actionLoading !== null}
            className="rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
          >
            {actionLoading === "reconcile"
              ? "Reconciling..."
              : "Run Reconciliation"}
          </button>
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
        <p className="mt-6 text-sm text-zinc-600">Loading dashboard data...</p>
      ) : (
        <>
          <section className="mt-6 grid gap-4 md:grid-cols-2">
            <article className="rounded-xl border border-zinc-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-zinc-900">
                Invoice Status
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                Matched {data?.summary.invoices.matched ?? 0} of{" "}
                {data?.summary.invoices.total ?? 0}
              </p>
              <p className="mt-1 text-sm text-zinc-600">
                Unmatched: {unmatchedInvoices.length}
              </p>
            </article>
            <article className="rounded-xl border border-zinc-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-zinc-900">
                Bank Transaction Status
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                Matched {data?.summary.transactions.matched ?? 0} of{" "}
                {data?.summary.transactions.total ?? 0}
              </p>
              <p className="mt-1 text-sm text-zinc-600">
                Unmatched: {unmatchedTransactions.length}
              </p>
            </article>
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <header className="border-b border-zinc-200 px-5 py-3">
                <h3 className="text-base font-semibold text-zinc-900">
                  Invoices
                </h3>
              </header>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-zinc-600">
                    <tr>
                      <th className="px-4 py-2">Invoice</th>
                      <th className="px-4 py-2">Vendor</th>
                      <th className="px-4 py-2">Amount</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.invoices.map((invoice) => (
                      <tr key={invoice.id} className="border-t border-zinc-100">
                        <td className="px-4 py-2">{invoice.invoiceNumber}</td>
                        <td className="px-4 py-2">{invoice.vendorName}</td>
                        <td className="px-4 py-2">
                          {formatCents(invoice.amountCents)}
                        </td>
                        <td className="px-4 py-2 capitalize">
                          {invoice.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <header className="border-b border-zinc-200 px-5 py-3">
                <h3 className="text-base font-semibold text-zinc-900">
                  Bank Transactions
                </h3>
              </header>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-zinc-600">
                    <tr>
                      <th className="px-4 py-2">Date</th>
                      <th className="px-4 py-2">Description</th>
                      <th className="px-4 py-2">Invoice Ref</th>
                      <th className="px-4 py-2">Amount</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.transactions.map((transaction) => (
                      <tr
                        key={transaction.id}
                        className="border-t border-zinc-100"
                      >
                        <td className="px-4 py-2">
                          {transaction.transactionDate}
                        </td>
                        <td className="px-4 py-2">{transaction.description}</td>
                        <td className="px-4 py-2">
                          {transaction.invoiceReference ?? "-"}
                        </td>
                        <td className="px-4 py-2">
                          {formatCents(transaction.amountCents)}
                        </td>
                        <td className="px-4 py-2 capitalize">
                          {transaction.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </section>

          <section className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <header className="border-b border-zinc-200 px-5 py-3">
              <h3 className="text-base font-semibold text-zinc-900">
                Recent Match Decisions
              </h3>
            </header>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-zinc-600">
                  <tr>
                    <th className="px-4 py-2">Invoice ID</th>
                    <th className="px-4 py-2">Transaction ID</th>
                    <th className="px-4 py-2">Score</th>
                    <th className="px-4 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.recentMatches.length ? (
                    data.recentMatches.map((match) => (
                      <tr key={match.id} className="border-t border-zinc-100">
                        <td className="px-4 py-2">{match.invoiceId}</td>
                        <td className="px-4 py-2">{match.bankTransactionId}</td>
                        <td className="px-4 py-2">{match.matchScore}</td>
                        <td className="px-4 py-2">{match.reason}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-zinc-500" colSpan={4}>
                        No matches persisted yet.
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
