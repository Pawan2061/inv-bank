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
}: {
  to: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
}): Promise<void> {
  appLog("whatsapp.template", "send_started", {
    to,
    templateName,
    languageCode,
    bodyParameterCount: bodyParameters.length,
  });

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
        components: [
          {
            type: "body",
            parameters: bodyParameters.map((text) => ({
              type: "text",
              text: text || "-",
            })),
          },
        ],
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
