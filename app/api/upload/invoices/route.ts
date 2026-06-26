import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { invoices, reconciliationMatches } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { assertDate, getHeaderMap, parseAmountToCents } from "@/lib/csv";
import { parseTabularUpload } from "@/lib/spreadsheet";

function normalizeDateCell(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("Missing date value.");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric)) {
    const epoch = new Date("1899-12-30T00:00:00Z").getTime();
    const date = new Date(epoch + Math.round(numeric) * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }

  const slash = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const yearRaw = Number(slash[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  throw new Error(`Invalid date "${raw}".`);
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }

    const rows = await parseTabularUpload(file);
    if (!rows.length) {
      return NextResponse.json({ error: "Uploaded file is empty." }, { status: 400 });
    }

    const [headers, ...dataRows] = rows;
    const headerMap = getHeaderMap(headers);
    const hasStandardHeaders =
      headerMap.invoice_number !== undefined &&
      headerMap.vendor_name !== undefined &&
      headerMap.issue_date !== undefined &&
      headerMap.due_date !== undefined &&
      headerMap.amount !== undefined;

    const hasDataXlsxHeaders =
      headerMap["invoice no"] !== undefined &&
      headerMap["invoice date"] !== undefined &&
      headerMap["customer name"] !== undefined;

    if (!hasStandardHeaders && !hasDataXlsxHeaders) {
      return NextResponse.json(
        {
          error:
            "Missing required headers. Use either invoice_number/vendor_name/... format or data.xlsx format (Invoice No, Invoice Date, Customer Name).",
        },
        { status: 400 },
      );
    }

    const parsed = dataRows.map((row, rowIndex) => {
      if (hasStandardHeaders) {
        const invoiceNumber = row[headerMap.invoice_number]?.trim();
        const vendorName = row[headerMap.vendor_name]?.trim();
        const issueDate = row[headerMap.issue_date]?.trim();
        const dueDate = row[headerMap.due_date]?.trim();
        const amount = row[headerMap.amount]?.trim();
        const currency = row[headerMap.currency]?.trim() || "USD";

        if (!invoiceNumber || !vendorName || !issueDate || !dueDate || !amount) {
          throw new Error(`Row ${rowIndex + 2} has missing required fields.`);
        }

        assertDate(issueDate, "issue_date");
        assertDate(dueDate, "due_date");

        return {
          invoiceNumber,
          vendorName,
          issueDate,
          dueDate,
          amountCents: parseAmountToCents(amount),
          currency,
        };
      }

      const invoiceNumber = row[headerMap["invoice no"]]?.trim();
      const customerName = row[headerMap["customer name"]]?.trim();
      const shippingName =
        headerMap["shipping name"] !== undefined ? row[headerMap["shipping name"]]?.trim() : "";
      const invoiceDateRaw = row[headerMap["invoice date"]]?.trim();

      if (!invoiceNumber || !customerName || !invoiceDateRaw) {
        throw new Error(`Row ${rowIndex + 2} has missing required fields.`);
      }

      const issueDate = normalizeDateCell(invoiceDateRaw);
      assertDate(issueDate, "issue_date");

      const amountRaw =
        headerMap.amount !== undefined
          ? row[headerMap.amount]?.trim()
          : headerMap["amount"] !== undefined
            ? row[headerMap["amount"]]?.trim()
            : "";

      return {
        invoiceNumber,
        vendorName: shippingName || customerName,
        issueDate,
        dueDate: issueDate,
        amountCents: amountRaw ? parseAmountToCents(amountRaw) : 0,
        currency: headerMap.currency !== undefined ? row[headerMap.currency]?.trim() || "USD" : "USD",
      };
    });

    if (!parsed.length) {
      return NextResponse.json({ error: "File has no data rows." }, { status: 400 });
    }

    await db.transaction(async (tx) => {
      await tx.delete(reconciliationMatches);
      await tx.delete(invoices);
      await tx.insert(invoices).values(parsed);
    });

    return NextResponse.json({
      message: `Imported ${parsed.length} invoice row(s).`,
      importedCount: parsed.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import invoices file." },
      { status: 400 },
    );
  }
}
