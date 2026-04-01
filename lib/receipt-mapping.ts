type ReceiptTemplate = "sre_cargo" | "psr_travels" | "unknown";

export type ReceiptExtraction = {
  template: ReceiptTemplate;
  companyName?: string;
  invoiceNo?: string;
  bookingDate?: string;
  receiptNo?: string;
  receivedFrom?: string;
  consignorName?: string;
  consigneeName?: string;
  toDeliver?: string;
  city?: string;
  qty?: string;
  description?: string;
  parcelDetails?: string;
  customerCode?: string;
  customerName?: string;
  shippingName?: string;
  courierName?: string;
  headerRemark?: string;
  remarks?: string;
  rawAmount?: string;
  invoiceCandidates?: string[];
  rawText?: string;
};

export type MappedDataRow = {
  invoiceNo: string;
  invoiceDate: string | number;
  parcelDtls: string;
  customerCode: string;
  customerName: string;
  shippingName: string;
  city: string;
  courierName: string;
  headerRemark: string;
  remarks: string;
};

export type DataMasterRow = MappedDataRow;

export function normalizeInvoiceNo(value?: string): string {
  if (!value) {
    return "";
  }
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function normalizeDateToIso(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const input = raw.trim();
  if (!input) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }

  const dash = input.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dash) {
    const day = Number(dash[1]);
    const month = Number(dash[2]);
    const yearRaw = Number(dash[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return undefined;
}

export function isoDateToExcelSerial(isoDate?: string): number | "" {
  if (!isoDate) {
    return "";
  }

  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const excelEpoch = new Date("1899-12-30T00:00:00Z");
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((date.getTime() - excelEpoch.getTime()) / dayMs);
}

export function mapReceiptToDataRow(extraction: ReceiptExtraction): MappedDataRow {
  const bookingDateIso = normalizeDateToIso(extraction.bookingDate);
  const defaultCourier = extraction.courierName || extraction.companyName || "";

  const customerName =
    extraction.customerName ||
    extraction.consigneeName ||
    extraction.receivedFrom ||
    extraction.toDeliver ||
    "";

  const shippingName = extraction.shippingName || extraction.consigneeName || extraction.toDeliver || customerName;

  const parcelDtls = extraction.parcelDetails || [extraction.qty, extraction.description].filter(Boolean).join(" ");

  return {
    invoiceNo: extraction.invoiceNo || "",
    invoiceDate: isoDateToExcelSerial(bookingDateIso),
    parcelDtls,
    customerCode: extraction.customerCode || "",
    customerName,
    shippingName,
    city: extraction.city || "",
    courierName: defaultCourier,
    headerRemark: extraction.headerRemark || "",
    remarks: extraction.remarks || "",
  };
}

export function mergeWithMasterRow(mapped: MappedDataRow, master?: DataMasterRow): MappedDataRow {
  if (!master) {
    return mapped;
  }

  return {
    invoiceNo: mapped.invoiceNo || master.invoiceNo,
    invoiceDate: mapped.invoiceDate || master.invoiceDate,
    parcelDtls: mapped.parcelDtls || master.parcelDtls,
    customerCode: mapped.customerCode || master.customerCode,
    customerName: mapped.customerName || master.customerName,
    shippingName: mapped.shippingName || master.shippingName,
    city: mapped.city || master.city,
    courierName: mapped.courierName || master.courierName,
    headerRemark: mapped.headerRemark || master.headerRemark,
    remarks: mapped.remarks || master.remarks,
  };
}

export const DATA_XLSX_HEADERS = [
  "Invoice No",
  "Invoice Date",
  "Parcel Dtls",
  "Customer Code",
  "Customer Name",
  "Shipping Name",
  "City",
  "Courier Name",
  "Header Remark",
  "Remarks",
] as const;
