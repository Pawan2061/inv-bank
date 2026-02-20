import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bankTransactions } from "@/db/schema";
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
    const requiredHeaders = ["transaction_date", "description", "amount"];

    for (const header of requiredHeaders) {
      if (headerMap[header] === undefined) {
        return NextResponse.json({ error: `Missing header: ${header}` }, { status: 400 });
      }
    }

    const parsed = dataRows.map((row, rowIndex) => {
      const transactionDate = row[headerMap.transaction_date]?.trim();
      const description = row[headerMap.description]?.trim();
      const amount = row[headerMap.amount]?.trim();
      const invoiceReference =
        headerMap.invoice_number !== undefined ? row[headerMap.invoice_number]?.trim() || undefined : undefined;
      const currency = row[headerMap.currency]?.trim() || "USD";

      if (!transactionDate || !description || !amount) {
        throw new Error(`Row ${rowIndex + 2} has missing required fields.`);
      }

      assertDate(transactionDate, "transaction_date");

      return {
        transactionDate,
        description,
        invoiceReference,
        amountCents: parseAmountToCents(amount),
        currency,
      };
    });

    if (!parsed.length) {
      return NextResponse.json({ error: "CSV has no data rows." }, { status: 400 });
    }

    await db.insert(bankTransactions).values(parsed);

    return NextResponse.json({
      message: `Imported ${parsed.length} transaction row(s).`,
      importedCount: parsed.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import transaction CSV." },
      { status: 400 },
    );
  }
}
