import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { whatsappMessages } from "@/db/schema";
import { notifyMatchedCustomerContacts } from "@/lib/customer-notifications";
import { appLog } from "@/lib/logger";
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

type RawWhatsAppMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  image?: WhatsAppImageMessage["image"];
  text?: WhatsAppTextMessage["text"];
};

type WhatsAppMessage = RawWhatsAppMessage;

type SupportedWhatsAppMessage = WhatsAppImageMessage | WhatsAppTextMessage;

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
        statuses?: WhatsAppStatus[];
      };
    }>;
  }>;
};

type WhatsAppStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: {
      details?: string;
    };
  }>;
};

type MediaMetadata = {
  url: string;
  mime_type?: string;
  sha256?: string;
};

type UploadedMedia = {
  id?: string;
};

type SentMessageResponse = {
  contacts?: Array<{
    input?: string;
    wa_id?: string;
  }>;
  messages?: Array<{
    id?: string;
    message_status?: string;
  }>;
};

const DEFAULT_ADMIN_WHATSAPP_NUMBER = "9289037928";

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

function adminWhatsAppNumber(): string {
  const digits = (
    process.env.ADMIN_WHATSAPP_NUMBER ?? DEFAULT_ADMIN_WHATSAPP_NUMBER
  ).replace(/\D/g, "");
  if (digits.length === 10) {
    return `91${digits}`;
  }
  return digits;
}

function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
): boolean {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) {
    appLog("whatsapp.webhook", "signature_check_skipped_no_app_secret", {
      hasSignature: Boolean(signature),
      rawBodyLength: rawBody.length,
    });
    return true;
  }
  if (!signature?.startsWith("sha256=")) {
    appLog(
      "whatsapp.webhook",
      "signature_missing_or_invalid_format",
      {
        hasSignature: Boolean(signature),
        rawBodyLength: rawBody.length,
      },
      "warn",
    );
    return false;
  }

  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signature.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");

  const valid =
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer);

  appLog(
    "whatsapp.webhook",
    "signature_check_completed",
    {
      valid,
      rawBodyLength: rawBody.length,
    },
    valid ? "info" : "warn",
  );

  return valid;
}

function profileNameFor(
  contacts: WhatsAppContact[] | undefined,
  fromNumber: string,
): string | null {
  const contact = contacts?.find((item) => item.wa_id === fromNumber);
  return contact?.profile?.name ?? null;
}

function isImageMessage(
  message: WhatsAppMessage,
): message is WhatsAppImageMessage {
  return message.type === "image" && Boolean(message.image?.id);
}

function isTextMessage(
  message: WhatsAppMessage,
): message is WhatsAppTextMessage {
  return message.type === "text";
}

async function sendTextMessage(to: string, body: string): Promise<void> {
  appLog("whatsapp.webhook", "send_text_started", {
    to,
    bodyLength: body.length,
  });

  const response = await fetch(
    `${graphBaseUrl()}/${phoneNumberId()}/messages`,
    {
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
    },
  );

  if (!response.ok) {
    const details = await response.text();
    appLog(
      "whatsapp.webhook",
      "send_text_failed",
      {
        to,
        status: response.status,
        details: details.slice(0, 500),
      },
      "error",
    );
    throw new HttpError(
      response.status,
      `WhatsApp reply failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as SentMessageResponse;
  appLog("whatsapp.webhook", "send_text_completed", {
    to,
    status: response.status,
    whatsappMessageId: payload.messages?.[0]?.id,
    messageStatus: payload.messages?.[0]?.message_status,
    recipientWaId: payload.contacts?.[0]?.wa_id,
  });
}

async function uploadWhatsAppMedia(file: File): Promise<string> {
  appLog("whatsapp.webhook", "upload_media_started", {
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
  });

  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append("file", file);

  const response = await fetch(`${graphBaseUrl()}/${phoneNumberId()}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const details = await response.text();
    appLog(
      "whatsapp.webhook",
      "upload_media_failed",
      {
        status: response.status,
        details: details.slice(0, 500),
      },
      "error",
    );
    throw new HttpError(
      response.status,
      `WhatsApp media upload failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as UploadedMedia;
  if (!payload.id) {
    throw new HttpError(
      502,
      "WhatsApp media upload did not return a media id.",
    );
  }

  appLog("whatsapp.webhook", "upload_media_completed", {
    mediaId: payload.id,
  });

  return payload.id;
}

async function sendImageMessage(
  to: string,
  file: File,
  caption: string,
): Promise<void> {
  const mediaId = await uploadWhatsAppMedia(file);

  appLog("whatsapp.webhook", "send_image_started", {
    to,
    mediaId,
    captionLength: caption.length,
  });

  const response = await fetch(
    `${graphBaseUrl()}/${phoneNumberId()}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${whatsappToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: {
          id: mediaId,
          caption,
        },
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    appLog(
      "whatsapp.webhook",
      "send_image_failed",
      {
        to,
        status: response.status,
        details: details.slice(0, 500),
      },
      "error",
    );
    throw new HttpError(
      response.status,
      `WhatsApp image send failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as SentMessageResponse;
  appLog("whatsapp.webhook", "send_image_completed", {
    to,
    status: response.status,
    whatsappMessageId: payload.messages?.[0]?.id,
    messageStatus: payload.messages?.[0]?.message_status,
    recipientWaId: payload.contacts?.[0]?.wa_id,
  });
}

async function fetchMediaMetadata(mediaId: string): Promise<MediaMetadata> {
  appLog("whatsapp.webhook", "media_metadata_fetch_started", { mediaId });

  const response = await fetch(`${graphBaseUrl()}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    appLog(
      "whatsapp.webhook",
      "media_metadata_fetch_failed",
      {
        mediaId,
        status: response.status,
        details: details.slice(0, 500),
      },
      "error",
    );
    throw new HttpError(
      response.status,
      `WhatsApp media lookup failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as Partial<MediaMetadata>;
  if (!payload.url) {
    appLog(
      "whatsapp.webhook",
      "media_metadata_missing_url",
      {
        mediaId,
        hasMimeType: Boolean(payload.mime_type),
        hasSha256: Boolean(payload.sha256),
      },
      "error",
    );
    throw new HttpError(502, "WhatsApp media lookup did not return a URL.");
  }

  appLog("whatsapp.webhook", "media_metadata_fetch_completed", {
    mediaId,
    mimeType: payload.mime_type,
    hasSha256: Boolean(payload.sha256),
  });

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
  appLog("whatsapp.webhook", "media_download_started", {
    mediaId,
    fallbackMimeType,
  });

  const metadata = await fetchMediaMetadata(mediaId);
  const mimeType = metadata.mime_type ?? fallbackMimeType ?? "image/jpeg";
  const response = await fetch(metadata.url, {
    headers: {
      Authorization: `Bearer ${whatsappToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    appLog(
      "whatsapp.webhook",
      "media_download_failed",
      {
        mediaId,
        status: response.status,
        details: details.slice(0, 500),
      },
      "error",
    );
    throw new HttpError(
      response.status,
      `WhatsApp media download failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";

  appLog("whatsapp.webhook", "media_download_completed", {
    mediaId,
    mimeType,
    bytes: buffer.byteLength,
  });

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

function buildMatchReply(
  result: Awaited<ReturnType<typeof processReceiptImages>>[number],
): string {
  const invoiceNo =
    result.masterInvoiceNo ||
    result.invoiceData?.invoiceNumber ||
    result.mappedRow.invoiceNo;

  if (result.invoiceData) {
    return [
      "Invoice matched.",
      `Invoice: ${result.invoiceData.invoiceNumber}`,
      `Customer: ${result.invoiceData.vendorName}`,
      `Issue date: ${result.invoiceData.issueDate}`,
      `Amount: ${formatCents(result.invoiceData.amountCents)}`,
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

function buildAdminUnmatchedMessage(
  message: WhatsAppImageMessage,
  profileName: string | null,
  result: Awaited<ReturnType<typeof processReceiptImages>>[number],
): string {
  const invoiceNo =
    result.masterInvoiceNo ||
    result.invoiceData?.invoiceNumber ||
    result.mappedRow.invoiceNo;

  return [
    "Unmatched invoice receipt.",
    `From: ${message.from}`,
    `Profile: ${profileName || "-"}`,
    `Detected invoice: ${invoiceNo || "-"}`,
    `Customer: ${result.mappedRow.customerName || "-"}`,
    `City: ${result.mappedRow.city || "-"}`,
    `Courier: ${result.mappedRow.courierName || "-"}`,
    `WhatsApp message id: ${message.id}`,
  ].join("\n");
}

async function notifyAdminForUnmatchedReceipt(
  message: WhatsAppImageMessage,
  profileName: string | null,
  file: File,
  result: Awaited<ReturnType<typeof processReceiptImages>>[number],
): Promise<void> {
  const adminNumber = adminWhatsAppNumber();
  if (!adminNumber) {
    appLog(
      "whatsapp.webhook",
      "admin_notify_skipped_missing_number",
      {
        messageId: message.id,
      },
      "warn",
    );
    return;
  }

  const adminMessage = buildAdminUnmatchedMessage(message, profileName, result);

  try {
    await sendImageMessage(adminNumber, file, adminMessage);
  } catch (imageError) {
    appLog(
      "whatsapp.webhook",
      "admin_notify_image_failed_falling_back_to_text",
      {
        messageId: message.id,
        adminNumber,
        errorMessage:
          imageError instanceof Error ? imageError.message : "unknown error",
      },
      "error",
    );
    await sendTextMessage(adminNumber, adminMessage);
  }
}

async function alreadyProcessed(messageId: string): Promise<boolean> {
  appLog("whatsapp.webhook", "history_duplicate_check_started", { messageId });

  const existing = await db
    .select({ id: whatsappMessages.id })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.messageId, messageId))
    .limit(1);

  const duplicate = existing.length > 0;
  appLog("whatsapp.webhook", "history_duplicate_check_completed", {
    messageId,
    duplicate,
  });

  return duplicate;
}

async function createHistoryRow(
  message: SupportedWhatsAppMessage,
  profileName: string | null,
): Promise<boolean> {
  appLog("whatsapp.webhook", "history_create_started", {
    messageId: message.id,
    from: message.from,
    type: message.type,
    hasProfileName: Boolean(profileName),
  });

  const inserted = await db
    .insert(whatsappMessages)
    .values({
      messageId: message.id,
      fromNumber: message.from,
      profileName,
      mediaId: message.type === "image" ? message.image.id : null,
      mediaMimeType:
        message.type === "image" ? (message.image.mime_type ?? null) : null,
      mediaSha256:
        message.type === "image" ? (message.image.sha256 ?? null) : null,
      status: "received",
    })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });

  if (!inserted.length) {
    appLog("whatsapp.webhook", "history_create_skipped_duplicate", {
      messageId: message.id,
    }, "warn");
    return false;
  }

  appLog("whatsapp.webhook", "history_create_completed", {
    messageId: message.id,
  });
  return true;
}

async function updateHistoryRow(
  messageId: string,
  values: Partial<typeof whatsappMessages.$inferInsert>,
): Promise<void> {
  appLog("whatsapp.webhook", "history_update_started", {
    messageId,
    status: values.status,
    hasResponseText: Boolean(values.responseText),
    hasErrorMessage: Boolean(values.errorMessage),
    hasResult: Boolean(values.result),
    hasMediaUrl: Boolean(values.mediaUrl),
  });

  await db
    .update(whatsappMessages)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(whatsappMessages.messageId, messageId));

  appLog("whatsapp.webhook", "history_update_completed", {
    messageId,
    status: values.status,
  });
}

async function handleImageMessage(
  message: WhatsAppImageMessage,
  profileName: string | null,
): Promise<void> {
  appLog("whatsapp.webhook", "image_message_started", {
    messageId: message.id,
    from: message.from,
    mediaId: message.image.id,
    mimeType: message.image.mime_type,
    hasProfileName: Boolean(profileName),
  });

  if (!(await createHistoryRow(message, profileName))) {
    appLog(
      "whatsapp.webhook",
      "image_message_skipped_duplicate",
      {
        messageId: message.id,
      },
      "warn",
    );
    return;
  }

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

    if (!result.invoiceData) {
      await notifyAdminForUnmatchedReceipt(message, profileName, file, result);
      await updateHistoryRow(message.id, {
        status: "forwarded_to_admin",
        responseText,
        result,
        mediaUrl: result.imageStore.url,
        mediaS3Key: result.imageStore.key,
      });
      appLog("whatsapp.webhook", "image_message_forwarded_to_admin", {
        messageId: message.id,
        adminNumber: adminWhatsAppNumber(),
      });
      return;
    }

    appLog("whatsapp.webhook", "image_message_match_completed", {
      messageId: message.id,
      invoiceNumber: result.invoiceData?.invoiceNumber ?? null,
      masterInvoiceNo: result.masterInvoiceNo,
      transactionExists: result.transactionExists,
      matchedFromMaster: result.matchedFromMaster,
    });

    await updateHistoryRow(message.id, {
      status: "sending_reply",
      responseText,
      result,
      mediaUrl: result.imageStore.url,
      mediaS3Key: result.imageStore.key,
    });
    await notifyMatchedCustomerContacts({
      result,
      sourceMessageId: message.id,
    });
    await updateHistoryRow(message.id, { status: "replied" });
    appLog("whatsapp.webhook", "image_message_completed", {
      messageId: message.id,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to process WhatsApp image.";
    appLog(
      "whatsapp.webhook",
      "image_message_failed",
      {
        messageId: message.id,
        errorMessage,
      },
      "error",
    );
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
      appLog(
        "whatsapp.webhook",
        "image_message_failure_reply_failed",
        {
          messageId: message.id,
          errorMessage:
            replyError instanceof Error ? replyError.message : "unknown error",
        },
        "error",
      );
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
  appLog("whatsapp.webhook", "text_message_started", {
    messageId: message.id,
    from: message.from,
    textLength: message.text?.body?.length ?? 0,
    hasProfileName: Boolean(profileName),
  });

  if (await alreadyProcessed(message.id)) {
    appLog(
      "whatsapp.webhook",
      "text_message_skipped_duplicate",
      {
        messageId: message.id,
      },
      "warn",
    );
    return;
  }

  const responseText =
    "Please send a photo of the invoice receipt for matching.";
  if (!(await createHistoryRow(message, profileName))) {
    appLog(
      "whatsapp.webhook",
      "text_message_skipped_duplicate",
      {
        messageId: message.id,
      },
      "warn",
    );
    return;
  }
  await updateHistoryRow(message.id, {
    status: "sending_reply",
    responseText,
  });
  await sendTextMessage(message.from, responseText);
  await updateHistoryRow(message.id, { status: "replied" });
  appLog("whatsapp.webhook", "text_message_completed", {
    messageId: message.id,
  });
}

function extractWebhookMessages(payload: WhatsAppWebhookPayload) {
  const extracted: Array<{
    message: SupportedWhatsAppMessage;
    profileName: string | null;
  }> = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value?.messages ?? []) {
        if (!isImageMessage(message) && !isTextMessage(message)) {
          appLog(
            "whatsapp.webhook",
            "message_skipped_unsupported_type",
            {
              messageId: message.id,
              type: message.type,
            },
            "warn",
          );
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

function extractWebhookStatuses(
  payload: WhatsAppWebhookPayload,
): WhatsAppStatus[] {
  const statuses: WhatsAppStatus[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      statuses.push(...(change.value?.statuses ?? []));
    }
  }

  return statuses;
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
    appLog("whatsapp.webhook", "verification_succeeded", {
      mode,
      hasChallenge: Boolean(challenge),
    });
    return new Response(challenge, { status: 200 });
  }

  appLog(
    "whatsapp.webhook",
    "verification_failed",
    {
      mode,
      hasToken: Boolean(token),
      hasExpectedToken: Boolean(process.env.WA_HOOKS_VERIFY_TOKEN),
      hasChallenge: Boolean(challenge),
    },
    "warn",
  );

  return NextResponse.json(
    { error: "Webhook verification failed." },
    { status: 403 },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  appLog("whatsapp.webhook", "post_received", {
    rawBodyLength: rawBody.length,
    hasSignature: Boolean(signature),
    contentType: request.headers.get("content-type"),
  });

  if (!verifyWebhookSignature(rawBody, signature)) {
    appLog(
      "whatsapp.webhook",
      "post_rejected_invalid_signature",
      {
        rawBodyLength: rawBody.length,
      },
      "warn",
    );
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 401 },
    );
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch (error) {
    appLog(
      "whatsapp.webhook",
      "post_invalid_json",
      {
        errorMessage: error instanceof Error ? error.message : "unknown error",
      },
      "error",
    );
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = extractWebhookMessages(payload);
  const statuses = extractWebhookStatuses(payload);

  appLog("whatsapp.webhook", "post_messages_extracted", {
    messageCount: messages.length,
    statusCount: statuses.length,
    entryCount: payload.entry?.length ?? 0,
  });

  for (const status of statuses) {
    appLog(
      "whatsapp.webhook",
      "delivery_status_received",
      {
        whatsappMessageId: status.id,
        status: status.status,
        recipientId: status.recipient_id,
        timestamp: status.timestamp,
        errors: status.errors?.map((error) => ({
          code: error.code,
          title: error.title,
          message: error.message,
          details: error.error_data?.details,
        })),
      },
      status.status === "failed" ? "error" : "info",
    );
  }

  for (const { message, profileName } of messages) {
    if (message.type === "image") {
      await handleImageMessage(message, profileName);
    } else {
      await handleTextMessage(message, profileName);
    }
  }

  appLog("whatsapp.webhook", "post_completed", {
    processed: messages.length,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({ received: true, processed: messages.length });
}
