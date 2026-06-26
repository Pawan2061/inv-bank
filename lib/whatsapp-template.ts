import { appLog } from "@/lib/logger";

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

type UploadedMediaResponse = {
  id?: string;
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

function phoneNumberId(): string {
  const id = process.env.WA_PHONE_NO_ID;
  if (!id) {
    throw new Error("WA_PHONE_NO_ID is missing.");
  }
  return id;
}

export function matchTemplateConfig():
  | { name: string; languageCode: string }
  | null {
  const name = process.env.WA_MATCH_TEMPLATE_NAME?.trim();
  if (!name) {
    return null;
  }

  return {
    name,
    languageCode: process.env.WA_MATCH_TEMPLATE_LANGUAGE?.trim() || "en_US",
  };
}

export async function sendWhatsAppTemplateMessage({
  to,
  templateName,
  languageCode,
  bodyParameters,
  headerImageMediaId,
}: {
  to: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
  headerImageMediaId?: string;
}): Promise<void> {
  appLog("whatsapp.template", "send_started", {
    to,
    templateName,
    languageCode,
    bodyParameterCount: bodyParameters.length,
    hasHeaderImage: Boolean(headerImageMediaId),
  });

  const components = [
    ...(headerImageMediaId
      ? [
          {
            type: "header",
            parameters: [
              {
                type: "image",
                image: {
                  id: headerImageMediaId,
                },
              },
            ],
          },
        ]
      : []),
    {
      type: "body",
      parameters: bodyParameters.map((text) => ({
        type: "text",
        text: text || "-",
      })),
    },
  ];

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
      type: "template",
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
        components,
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    appLog("whatsapp.template", "send_failed", {
      to,
      templateName,
      status: response.status,
      details: details.slice(0, 500),
    }, "error");
    throw new Error(
      `WhatsApp template send failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as SentMessageResponse;
  appLog("whatsapp.template", "send_completed", {
    to,
    templateName,
    status: response.status,
    whatsappMessageId: payload.messages?.[0]?.id,
    messageStatus: payload.messages?.[0]?.message_status,
    recipientWaId: payload.contacts?.[0]?.wa_id,
  });
}

export async function uploadWhatsAppMedia(file: File): Promise<string> {
  appLog("whatsapp.template", "upload_media_started", {
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
    appLog("whatsapp.template", "upload_media_failed", {
      status: response.status,
      details: details.slice(0, 500),
    }, "error");
    throw new Error(
      `WhatsApp media upload failed (${response.status}): ${details.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as UploadedMediaResponse;
  if (!payload.id) {
    throw new Error("WhatsApp media upload did not return a media id.");
  }

  appLog("whatsapp.template", "upload_media_completed", {
    mediaId: payload.id,
  });

  return payload.id;
}
