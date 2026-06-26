import { and, desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { customerMaster, customerPhoneNumbers, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";

type PhoneBody = {
  phoneNumber?: string;
  label?: string;
  isPrimary?: boolean;
  isWhatsappEnabled?: boolean;
};

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "").trim();
}

async function ensureCustomerId(user: { id: number; username: string; customerId: number | null }) {
  if (user.customerId) {
    return user.customerId;
  }

  const [customer] = await db
    .insert(customerMaster)
    .values({
      customerCode: `USER-${user.id}`,
      customerName: user.username,
      source: "signup",
    })
    .onConflictDoUpdate({
      target: customerMaster.customerCode,
      set: {
        customerName: user.username,
        updatedAt: new Date(),
      },
    })
    .returning({ id: customerMaster.id });

  await db
    .update(users)
    .set({ customerId: customer.id, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return customer.id;
}

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const customerId = await ensureCustomerId(auth);
  const phones = await db
    .select({
      id: customerPhoneNumbers.id,
      customerId: customerPhoneNumbers.customerId,
      phoneNumber: customerPhoneNumbers.phoneNumber,
      label: customerPhoneNumbers.label,
      isPrimary: customerPhoneNumbers.isPrimary,
      isWhatsappEnabled: customerPhoneNumbers.isWhatsappEnabled,
      createdAt: customerPhoneNumbers.createdAt,
      updatedAt: customerPhoneNumbers.updatedAt,
      customerName: customerMaster.customerName,
      source: customerMaster.source,
    })
    .from(customerPhoneNumbers)
    .innerJoin(customerMaster, eq(customerPhoneNumbers.customerId, customerMaster.id))
    .where(
      or(
        eq(customerPhoneNumbers.customerId, customerId),
        eq(customerMaster.source, "seed"),
      ),
    )
    .orderBy(
      desc(customerPhoneNumbers.isPrimary),
      desc(customerPhoneNumbers.createdAt),
    );

  return NextResponse.json({
    phones: phones.map((phone) => ({
      ...phone,
      isOwned: phone.customerId === customerId,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const body = (await request.json()) as PhoneBody;
    const phoneNumber = normalizePhone(body.phoneNumber ?? "");
    const label = body.label?.trim() || null;
    const customerId = await ensureCustomerId(auth);

    if (!phoneNumber || phoneNumber.length < 8) {
      return NextResponse.json(
        { error: "Enter a valid phone number." },
        { status: 400 },
      );
    }

    const shouldBePrimary = body.isPrimary ?? false;
    const whatsappEnabled = body.isWhatsappEnabled ?? true;

    const [created] = await db.transaction(async (tx) => {
      if (shouldBePrimary) {
        await tx
          .update(customerPhoneNumbers)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(eq(customerPhoneNumbers.customerId, customerId));
      }

      return tx
        .insert(customerPhoneNumbers)
        .values({
          customerId,
          phoneNumber,
          label,
          isPrimary: shouldBePrimary,
          isWhatsappEnabled: whatsappEnabled,
        })
        .returning();
    });

    return NextResponse.json({ phone: created }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("customer_phone_numbers_phone_number_uq")
        ? "That phone number is already saved."
        : "Failed to save phone number.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json()) as PhoneBody & { id?: number };
  const id = Number(body.id);
  const customerId = await ensureCustomerId(auth);

  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Missing phone id." }, { status: 400 });
  }

  const [updated] = await db.transaction(async (tx) => {
    if (body.isPrimary) {
      await tx
        .update(customerPhoneNumbers)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(eq(customerPhoneNumbers.customerId, customerId));
    }

    return tx
      .update(customerPhoneNumbers)
      .set({
        label: body.label === undefined ? undefined : body.label.trim() || null,
        isPrimary: body.isPrimary,
        isWhatsappEnabled: body.isWhatsappEnabled,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPhoneNumbers.id, id),
          eq(customerPhoneNumbers.customerId, customerId),
        ),
      )
      .returning();
  });

  if (!updated) {
    return NextResponse.json({ error: "Phone number not found." }, { status: 404 });
  }

  return NextResponse.json({ phone: updated });
}

export async function DELETE(request: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) {
    return auth;
  }

  const id = Number(new URL(request.url).searchParams.get("id"));
  const customerId = await ensureCustomerId(auth);

  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Missing phone id." }, { status: 400 });
  }

  const [deleted] = await db
    .delete(customerPhoneNumbers)
    .where(
      and(
        eq(customerPhoneNumbers.id, id),
        eq(customerPhoneNumbers.customerId, customerId),
      ),
    )
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: "Phone number not found." }, { status: 404 });
  }

  return NextResponse.json({ message: "Phone number removed." });
}
