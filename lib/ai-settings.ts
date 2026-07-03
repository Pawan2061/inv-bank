import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { appSettings } from "@/db/schema";
import { appLog } from "@/lib/logger";

export const AI_PROVIDERS = ["ollama", "openai"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

const AI_PROVIDER_SETTING_KEY = "ai_provider";
let settingsTableReady = false;

export function normalizeAiProvider(value: string | undefined | null): AiProvider | null {
  const normalized = value?.trim().toLowerCase();
  return AI_PROVIDERS.find((provider) => provider === normalized) ?? null;
}

export function defaultAiProvider(): AiProvider {
  return normalizeAiProvider(process.env.AI_PROVIDER) ?? "ollama";
}

async function ensureSettingsTable(): Promise<void> {
  if (settingsTableReady) {
    return;
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  settingsTableReady = true;
}

export async function getActiveAiProvider(): Promise<AiProvider> {
  try {
    await ensureSettingsTable();
    const [setting] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, AI_PROVIDER_SETTING_KEY))
      .limit(1);

    return normalizeAiProvider(setting?.value) ?? defaultAiProvider();
  } catch (error) {
    appLog(
      "ai.settings",
      "provider_lookup_failed",
      {
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
      "warn",
    );
    return defaultAiProvider();
  }
}

export async function setActiveAiProvider(provider: AiProvider): Promise<AiProvider> {
  await ensureSettingsTable();
  await db
    .insert(appSettings)
    .values({
      key: AI_PROVIDER_SETTING_KEY,
      value: provider,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: provider,
        updatedAt: new Date(),
      },
    });

  return provider;
}

export function getAiRuntimeConfig() {
  return {
    defaultProvider: defaultAiProvider(),
    openai: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    },
    ollama: {
      baseUrl: (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(
        /\/+$/,
        "",
      ),
      model: process.env.OLLAMA_MODEL ?? "gemma4:e4b",
    },
  };
}
