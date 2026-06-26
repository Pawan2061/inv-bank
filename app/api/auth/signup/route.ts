import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { customerMaster, users } from "@/db/schema";
import { hashPassword, setSessionCookie } from "@/lib/auth";

type SignupBody = {
  username?: string;
  email?: string;
  password?: string;
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SignupBody;
    const username = clean(body.username);
    const email = clean(body.email).toLowerCase();
    const password = body.password ?? "";

    if (!username || !email || !password) {
      return NextResponse.json(
        { error: "Username, email, and password are required." },
        { status: 400 },
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length) {
      return NextResponse.json({ error: "Email is already registered." }, { status: 409 });
    }

    const [createdUser] = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          username,
          email,
          passwordHash: hashPassword(password),
        })
        .returning({
          id: users.id,
          username: users.username,
          email: users.email,
        });

      const [customer] = await tx
        .insert(customerMaster)
        .values({
          customerCode: `USER-${user.id}`,
          customerName: username,
          source: "signup",
        })
        .returning({ id: customerMaster.id });

      await tx
        .update(users)
        .set({ customerId: customer.id, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      return [{ ...user, customerId: customer.id }];
    });

    const response = NextResponse.json({ user: createdUser }, { status: 201 });
    setSessionCookie(response, createdUser.id);
    return response;
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("users_username_uq")
        ? "Username is already registered."
        : "Failed to create account.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
