import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { whatsappMessages } from "@/db/schema";
import { HttpError, processReceiptImages } from "@/lib/receipt-processor";

export const runtime = "nodejs";

type WhatsAppContact = {
  profile?: {
    name?: string;
  };
  wa_id?: string;
};

type WhatsAppImageMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: "image";
  image: {
    id: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
};

type WhatsAppTextMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: "text";
  text?: {
    body?: string;
  };
};

type WhatsAppMessage = WhatsAppImageMessage | WhatsAppTextMessage;

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
};

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
    throw new HttpError(500, "WA_TOKEN is missing.");
  }
  return token;
}

function phoneNumberId(): string {
  const id = process.env.WA_PHONE_NO_ID;
  if (!id) {
    throw new HttpError(500, "WA_PHONE_NO_ID is missing.");
  }
  return id;
}

function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const appSecret = process.env.WA_APP_SECRET ?? process.env.SECRET_TOKEN;
  if (!appSecret) {
    return true;
  }
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signature.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function profileNameFor(
  contacts: WhatsAppContact[] | undefined,
  fromNumber: string,
): string | null {
  const contact = contacts?.find((item) => item.wa_id === fromNumber);
  return contact?.profile?.name ?? null;
}

async function sendTextMessage(to: string, body: string): Promise<void> {
  const response = await fetch(`${graphBaseUrl()}/${phoneNumberId()}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: false,
        body,
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new HttpError(
      response.status,
      `WhatsApp reply failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }
}

async function fetchMediaMetadata(mediaId: string): Promise<MediaMetadata> {
  const response = await fetch(`${graphBaseUrl()}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new HttpError(
      response.status,
      `WhatsApp media lookup failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as Partial<MediaMetadata>;
  if (!payload.url) {
    throw new HttpError(502, "WhatsApp media lookup did not return a URL.");
  }

  return {
    url: payload.url,
    mime_type: payload.mime_type,
    sha256: payload.sha256,
  };
}

async function downloadMediaAsFile(
  mediaId: string,
  fallbackMimeType?: string,
): Promise<{ file: File; metadata: MediaMetadata }> {
  const metadata = await fetchMediaMetadata(mediaId);
  const mimeType = metadata.mime_type ?? fallbackMimeType ?? "image/jpeg";
  const response = await fetch(metadata.url, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new HttpError(
      response.status,
      `WhatsApp media download failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";

  return {
    file: new File([buffer], `whatsapp-${mediaId}.${extension}`, {
      type: mimeType,
    }),
    metadata,
  };
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function buildMatchReply(result: Awaited<ReturnType<typeof processReceiptImages>>[number]): string {
  const invoiceNo =
    result.masterInvoiceNo || result.invoiceData?.invoiceNumber || result.mappedRow.invoiceNo;

  if (result.invoiceData) {
    return [
      "Invoice matched.",
      `Invoice: ${result.invoiceData.invoiceNumber}`,
      `Customer: ${result.invoiceData.vendorName}`,
      `Issue date: ${result.invoiceData.issueDate}`,
      `Amount: ${formatCents(result.invoiceData.amountCents)}`,
      `Transaction found: ${result.transactionExists ? "Yes" : "No"}`,
    ].join("\n");
  }

  if (invoiceNo) {
    return [
      "Invoice number detected, but no invoice row matched in the DB.",
      `Detected invoice: ${invoiceNo}`,
      `Customer: ${result.mappedRow.customerName || "-"}`,
      `City: ${result.mappedRow.city || "-"}`,
      "Upload or refresh the invoice table, then try again.",
    ].join("\n");
  }

  return [
    "I could not confidently detect an invoice number from this image.",
    "Please send a clearer photo with the invoice number visible.",
  ].join("\n");
}

async function alreadyProcessed(messageId: string): Promise<boolean> {
  const existing = await db
    .select({ id: whatsappMessages.id })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.messageId, messageId))
    .limit(1);

  return existing.length > 0;
}

async function createHistoryRow(
  message: WhatsAppMessage,
  profileName: string | null,
): Promise<void> {
  await db.insert(whatsappMessages).values({
    messageId: message.id,
    fromNumber: message.from,
    profileName,
    mediaId: message.type === "image" ? message.image.id : null,
    mediaMimeType: message.type === "image" ? message.image.mime_type ?? null : null,
    mediaSha256: message.type === "image" ? message.image.sha256 ?? null : null,
    status: "received",
  });
}

async function updateHistoryRow(
  messageId: string,
  values: Partial<typeof whatsappMessages.$inferInsert>,
): Promise<void> {
  await db
    .update(whatsappMessages)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(whatsappMessages.messageId, messageId));
}

async function handleImageMessage(
  message: WhatsAppImageMessage,
  profileName: string | null,
): Promise<void> {
  if (await alreadyProcessed(message.id)) {
    return;
  }

  await createHistoryRow(message, profileName);

  try {
    await updateHistoryRow(message.id, { status: "downloading_media" });
    const { file, metadata } = await downloadMediaAsFile(
      message.image.id,
      message.image.mime_type,
    );

    await updateHistoryRow(message.id, {
      status: "processing",
      mediaMimeType: metadata.mime_type ?? message.image.mime_type ?? null,
      mediaSha256: metadata.sha256 ?? message.image.sha256 ?? null,
    });

    const [result] = await processReceiptImages([file]);
    const responseText = buildMatchReply(result);

    await updateHistoryRow(message.id, {
      status: "sending_reply",
      responseText,
      result,
    });
    await sendTextMessage(message.from, responseText);
    await updateHistoryRow(message.id, { status: "replied" });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to process WhatsApp image.";
    const responseText =
      error instanceof HttpError && error.status === 400
        ? errorMessage
        : "I could not process this invoice image. Please try again with a clearer photo.";

    await updateHistoryRow(message.id, {
      status: "failed",
      errorMessage,
      responseText,
    });

    try {
      await sendTextMessage(message.from, responseText);
    } catch (replyError) {
      await updateHistoryRow(message.id, {
        errorMessage: `${errorMessage}; reply failed: ${
          replyError instanceof Error ? replyError.message : "unknown error"
        }`,
      });
    }
  }
}

async function handleTextMessage(
  message: WhatsAppTextMessage,
  profileName: string | null,
): Promise<void> {
  if (await alreadyProcessed(message.id)) {
    return;
  }

  const responseText = "Please send a photo of the invoice receipt for matching.";
  await createHistoryRow(message, profileName);
  await updateHistoryRow(message.id, {
    status: "sending_reply",
    responseText,
  });
  await sendTextMessage(message.from, responseText);
  await updateHistoryRow(message.id, { status: "replied" });
}

function extractWebhookMessages(payload: WhatsAppWebhookPayload) {
  const extracted: Array<{
    message: WhatsAppMessage;
    profileName: string | null;
  }> = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value?.messages ?? []) {
        if (message.type !== "image" && message.type !== "text") {
          continue;
        }
        extracted.push({
          message,
          profileName: profileNameFor(value?.contacts, message.from),
        });
      }
    }
  }

  return extracted;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token &&
    token === process.env.WA_HOOKS_VERIFY_TOKEN &&
    challenge
  ) {
    return new Response(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Webhook verification failed." }, { status: 403 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  const messages = extractWebhookMessages(payload);

  for (const { message, profileName } of messages) {
    if (message.type === "image") {
      await handleImageMessage(message, profileName);
    } else {
      await handleTextMessage(message, profileName);
    }
  }

  return NextResponse.json({ received: true, processed: messages.length });
}
