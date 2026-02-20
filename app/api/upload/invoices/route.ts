import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { invoices } from "@/db/schema";
import { assertDate, getHeaderMap, parseAmountToCents, parseCsv } from "@/lib/csv";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing CSV file." }, { status: 400 });
    }

    const csvText = await file.text();
    const rows = parseCsv(csvText);
    if (!rows.length) {
      return NextResponse.json({ error: "CSV is empty." }, { status: 400 });
    }

    const [headers, ...dataRows] = rows;
    const headerMap = getHeaderMap(headers);
    const requiredHeaders = ["invoice_number", "vendor_name", "issue_date", "due_date", "amount"];

    for (const header of requiredHeaders) {
      if (headerMap[header] === undefined) {
        return NextResponse.json({ error: `Missing header: ${header}` }, { status: 400 });
      }
    }

    const parsed = dataRows.map((row, rowIndex) => {
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
    });

    if (!parsed.length) {
      return NextResponse.json({ error: "CSV has no data rows." }, { status: 400 });
    }

    await db.insert(invoices).values(parsed);

    return NextResponse.json({
      message: `Imported ${parsed.length} invoice row(s).`,
      importedCount: parsed.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import invoice CSV." },
      { status: 400 },
    );
  }
}
