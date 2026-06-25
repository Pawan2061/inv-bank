import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { whatsappMessages } from "@/db/schema";
import { storeReceiptImage } from "@/lib/s3-image-store";

export const runtime = "nodejs";

type MediaMetadata = {
  url: string;
  mime_type?: string;
  sha256?: string;
};

function graphBaseUrl(): string {
  return `https://graph.facebook.com/${process.env.WA_VERSION ?? "v21.0"}`;
}

function whatsappToken(): string {
  const token = process.env.WA_TOKEN;
  if (!token) {
    throw new Error("WA_TOKEN is missing.");
  }
  return token;
}

async function fetchMediaMetadata(mediaId: string): Promise<MediaMetadata> {
  const response = await fetch(`${graphBaseUrl()}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `WhatsApp media lookup failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as Partial<MediaMetadata>;
  if (!payload.url) {
    throw new Error("WhatsApp media lookup did not return a URL.");
  }

  return {
    url: payload.url,
    mime_type: payload.mime_type,
    sha256: payload.sha256,
  };
}

async function downloadMedia(mediaId: string, fallbackMimeType?: string) {
  const metadata = await fetchMediaMetadata(mediaId);
  const mimeType = metadata.mime_type ?? fallbackMimeType ?? "image/jpeg";
  const response = await fetch(metadata.url, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `WhatsApp media download failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType,
    metadata,
  };
}

export async function GET(request: Request) {
  const messageId = new URL(request.url).searchParams.get("messageId");
  if (!messageId) {
    return NextResponse.json({ error: "Missing messageId." }, { status: 400 });
  }

  try {
    const [row] = await db
      .select()
      .from(whatsappMessages)
      .where(eq(whatsappMessages.messageId, messageId))
      .limit(1);

    if (!row?.mediaId) {
      return NextResponse.json({ error: "WhatsApp media not found." }, { status: 404 });
    }

    if (row.mediaUrl) {
      return NextResponse.redirect(new URL(row.mediaUrl, request.url));
    }

    const { buffer, mimeType, metadata } = await downloadMedia(
      row.mediaId,
      row.mediaMimeType ?? undefined,
    );
    const extension = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";
    const file = new File([buffer], `whatsapp-${row.mediaId}.${extension}`, {
      type: mimeType,
    });
    try {
      const imageStore = await storeReceiptImage(file);
      const result =
        row.result && typeof row.result === "object" && !Array.isArray(row.result)
          ? { ...row.result, imageStore }
          : row.result;

      await db
        .update(whatsappMessages)
        .set({
          mediaUrl: imageStore.url,
          mediaS3Key: imageStore.key,
          mediaMimeType: metadata.mime_type ?? row.mediaMimeType,
          mediaSha256: metadata.sha256 ?? row.mediaSha256,
          result,
          updatedAt: new Date(),
        })
        .where(eq(whatsappMessages.messageId, messageId));
    } catch (storeError) {
      console.error("Failed to store WhatsApp media in S3.", storeError);
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": mimeType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch WhatsApp media.",
      },
      { status: 500 },
    );
  }
}
