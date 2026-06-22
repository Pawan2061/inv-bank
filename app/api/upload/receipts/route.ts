import { NextResponse } from "next/server";
import { DATA_XLSX_HEADERS } from "@/lib/receipt-mapping";
import { HttpError, processReceiptImages } from "@/lib/receipt-processor";

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

    const mapped = await processReceiptImages(files);

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
