import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { fetchReceiptImage } from "@/lib/s3-image-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const key = new URL(request.url).searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "Missing receipt image key." }, { status: 400 });
  }

  try {
    const image = await fetchReceiptImage(key);

    return new Response(image.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": image.contentType ?? "application/octet-stream",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch receipt image.",
      },
      { status: 500 },
    );
  }
}
