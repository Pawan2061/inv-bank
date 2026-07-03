import { NextResponse } from "next/server";
import {
  getActiveAiProvider,
  getAiRuntimeConfig,
  normalizeAiProvider,
  setActiveAiProvider,
} from "@/lib/ai-settings";
import { requireUser } from "@/lib/auth";

type SettingsBody = {
  provider?: string;
};

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const provider = await getActiveAiProvider();

  return NextResponse.json({
    provider,
    ...getAiRuntimeConfig(),
  });
}

export async function PATCH(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json()) as SettingsBody;
  const provider = normalizeAiProvider(body.provider);

  if (!provider) {
    return NextResponse.json(
      { error: 'Provider must be either "ollama" or "openai".' },
      { status: 400 },
    );
  }

  const activeProvider = await setActiveAiProvider(provider);

  return NextResponse.json({
    message: `AI provider set to ${activeProvider}.`,
    provider: activeProvider,
    ...getAiRuntimeConfig(),
  });
}
