import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { customerMaster, customerPhoneNumbers } from "@/db/schema";
import { appLog } from "@/lib/logger";
import {
  matchTemplateConfig,
  sendWhatsAppTemplateMessage,
} from "@/lib/whatsapp-template";

type MatchedReceiptResult = {
  masterInvoiceNo?: string;
  invoiceData?: {
    invoiceNumber: string;
    vendorName: string;
    issueDate: string;
    amountCents: number;
  } | null;
  mappedRow?: {
    invoiceNo?: string;
    customerCode?: string;
    customerName?: string;
    shippingName?: string;
  };
};

type CustomerNotificationTarget = {
  customerId: number;
  customerCode: string;
  customerName: string;
  phoneNumber: string;
};

function normalizeForMatch(value?: string | null): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function invoiceNumberFor(result: MatchedReceiptResult): string {
  return (
    result.invoiceData?.invoiceNumber ||
    result.masterInvoiceNo ||
    result.mappedRow?.invoiceNo ||
    "-"
  );
}

async function findCustomerNotificationTargets(
  result: MatchedReceiptResult,
): Promise<CustomerNotificationTarget[]> {
  const codeCandidate = normalizeForMatch(result.mappedRow?.customerCode);
  const nameCandidates = new Set(
    [
      result.invoiceData?.vendorName,
      result.mappedRow?.customerName,
      result.mappedRow?.shippingName,
    ]
      .map(normalizeForMatch)
      .filter(Boolean),
  );

  if (!codeCandidate && !nameCandidates.size) {
    return [];
  }

  const rows = await db
    .select({
      customerId: customerMaster.id,
      customerCode: customerMaster.customerCode,
      customerName: customerMaster.customerName,
      phoneNumber: customerPhoneNumbers.phoneNumber,
    })
    .from(customerMaster)
    .innerJoin(
      customerPhoneNumbers,
      eq(customerPhoneNumbers.customerId, customerMaster.id),
    )
    .where(
      and(
        eq(customerMaster.isActive, true),
        eq(customerPhoneNumbers.isWhatsappEnabled, true),
      ),
    );

  return rows.filter((row) => {
    if (codeCandidate && normalizeForMatch(row.customerCode) === codeCandidate) {
      return true;
    }
    return nameCandidates.has(normalizeForMatch(row.customerName));
  });
}

export async function notifyMatchedCustomerContacts({
  result,
  sourceMessageId,
}: {
  result: MatchedReceiptResult;
  sourceMessageId: string;
}): Promise<void> {
  if (!result.invoiceData) {
    return;
  }

  const templateConfig = matchTemplateConfig();
  if (!templateConfig) {
    appLog("customer.notifications", "matched_notify_skipped_missing_template", {
      sourceMessageId,
      invoiceNumber: result.invoiceData.invoiceNumber,
    }, "warn");
    return;
  }

  const targets = await findCustomerNotificationTargets(result);
  if (!targets.length) {
    appLog("customer.notifications", "matched_notify_skipped_no_customer_numbers", {
      sourceMessageId,
      invoiceNumber: result.invoiceData.invoiceNumber,
      invoiceCustomer: result.invoiceData.vendorName,
      mappedCustomer: result.mappedRow?.customerName ?? null,
      mappedCustomerCode: result.mappedRow?.customerCode ?? null,
    }, "warn");
    return;
  }

  await Promise.allSettled(
    targets.map(async (target) => {
      await sendWhatsAppTemplateMessage({
        to: target.phoneNumber,
        templateName: templateConfig.name,
        languageCode: templateConfig.languageCode,
        bodyParameters: [
          target.customerName,
          invoiceNumberFor(result),
          result.invoiceData?.issueDate ?? "-",
          formatCents(result.invoiceData?.amountCents ?? 0),
        ],
      });
    }),
  ).then((outcomes) => {
    outcomes.forEach((outcome, index) => {
      const target = targets[index];
      if (outcome.status === "rejected") {
        appLog("customer.notifications", "matched_notify_failed", {
          sourceMessageId,
          invoiceNumber: result.invoiceData?.invoiceNumber,
          customerCode: target.customerCode,
          phoneNumber: target.phoneNumber,
          errorMessage:
            outcome.reason instanceof Error ? outcome.reason.message : "unknown error",
        }, "error");
        return;
      }

      appLog("customer.notifications", "matched_notify_completed", {
        sourceMessageId,
        invoiceNumber: result.invoiceData?.invoiceNumber,
        customerCode: target.customerCode,
        phoneNumber: target.phoneNumber,
      });
    });
  });
}
