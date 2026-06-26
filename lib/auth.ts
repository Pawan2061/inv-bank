import {
  createHmac,
  randomBytes,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";

const SESSION_COOKIE = "invoice_bank_session";
const HASH_ITERATIONS = 310000;
const HASH_KEY_LENGTH = 32;
const HASH_DIGEST = "sha256";

export type AuthUser = {
  id: number;
  username: string;
  email: string;
  customerId: number | null;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(
    password,
    salt,
    HASH_ITERATIONS,
    HASH_KEY_LENGTH,
    HASH_DIGEST,
  ).toString("hex");

  return `pbkdf2:${HASH_DIGEST}:${HASH_ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [scheme, digest, iterationsRaw, salt, hash] = storedHash.split(":");
  if (scheme !== "pbkdf2" || digest !== HASH_DIGEST || !salt || !hash) {
    return false;
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  const candidate = pbkdf2Sync(
    password,
    salt,
    iterations,
    Buffer.from(hash, "hex").length,
    digest,
  );
  const expected = Buffer.from(hash, "hex");

  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function sessionSecret(): string {
  return (
    process.env.AUTH_SECRET ||
    process.env.DATABASE_URL ||
    "invoice-bank-dev-session-secret"
  );
}

function signSession(userId: number): string {
  const value = String(userId);
  const signature = createHmac("sha256", sessionSecret())
    .update(value)
    .digest("hex");

  return `${value}.${signature}`;
}

function verifySession(sessionValue: string | undefined): number | null {
  if (!sessionValue) {
    return null;
  }

  const [value, signature] = sessionValue.split(".");
  if (!value || !signature) {
    return null;
  }

  const expected = createHmac("sha256", sessionSecret())
    .update(value)
    .digest("hex");
  const received = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (
    received.length !== expectedBuffer.length ||
    !timingSafeEqual(received, expectedBuffer)
  ) {
    return null;
  }

  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const userId = verifySession(cookieStore.get(SESSION_COOKIE)?.value);

  if (!userId) {
    return null;
  }

  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      customerId: users.customerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

export async function requireUser(): Promise<AuthUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  return user;
}

export function setSessionCookie(response: NextResponse, userId: number): void {
  response.cookies.set(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
