import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(".env", "utf8")
    .split(/\n/)
    .filter((line) => line && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return index < 0
        ? [line, ""]
        : [line.slice(0, index), line.slice(index + 1)];
    }),
);

const imagePath = process.argv[2] ?? "/tmp/whatsapp-template-sample.png";
const templateName = process.argv[3] ?? "invoice_matched_with_photo";
const version = env.WA_VERSION || "v21.0";
const token = env.WA_TOKEN;
const appId = env.WA_APP_ID;
const wabaId = env.WA_BE_ACC_ID;
const language = env.WA_MATCH_TEMPLATE_LANGUAGE || "en_US";

if (!token || !appId || !wabaId) {
  throw new Error("Missing WA_TOKEN, WA_APP_ID, or WA_BE_ACC_ID in .env.");
}

async function readJson(response) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }

  return payload;
}

const file = fs.readFileSync(imagePath);
const uploadSessionUrl =
  `https://graph.facebook.com/${version}/${appId}/uploads` +
  `?file_name=whatsapp-template-sample.png` +
  `&file_length=${file.length}` +
  `&file_type=image/png`;

const session = await readJson(
  await fetch(uploadSessionUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }),
);

const uploaded = await readJson(
  await fetch(`https://graph.facebook.com/${version}/${session.id}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      file_offset: "0",
      "Content-Type": "application/octet-stream",
    },
    body: file,
  }),
);

const headerHandle = uploaded.h || uploaded.handle || uploaded.id;
if (!headerHandle) {
  throw new Error(`Upload completed but no header handle was returned: ${JSON.stringify(uploaded)}`);
}

const body = {
  name: templateName,
  language,
  category: "UTILITY",
  components: [
    {
      type: "HEADER",
      format: "IMAGE",
      example: {
        header_handle: [headerHandle],
      },
    },
    {
      type: "BODY",
      text:
        "Hi {{1}}, your invoice {{2}} dated {{3}} for {{4}} has been matched.\n\n" +
        "Please see the receipt photo above.",
      example: {
        body_text: [["ABC Furniture", "1252683918", "2026-06-26", "$120.00"]],
      },
    },
  ],
};

const created = await readJson(
  await fetch(`https://graph.facebook.com/${version}/${wabaId}/message_templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }),
);

console.log(
  JSON.stringify(
    {
      templateName,
      language,
      status: created.status ?? "submitted",
      id: created.id ?? null,
      category: created.category ?? "UTILITY",
    },
    null,
    2,
  ),
);
