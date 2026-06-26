import { or, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { setSessionCookie, verifyPassword } from "@/lib/auth";

type LoginBody = {
  email?: string;
  password?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as LoginBody;
  const emailOrUsername = body.email?.trim() ?? "";
  const password = body.password ?? "";

  if (!emailOrUsername || !password) {
    return NextResponse.json(
      { error: "Email/username and password are required." },
      { status: 400 },
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(
      or(
        eq(users.email, emailOrUsername.toLowerCase()),
        eq(users.username, emailOrUsername),
      ),
    )
    .limit(1);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid login details." }, { status: 401 });
  }

  const response = NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      customerId: user.customerId,
    },
  });
  setSessionCookie(response, user.id);
  return response;
}
