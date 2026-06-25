import { randomUUID } from "crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { appLog } from "@/lib/logger";

const DEFAULT_BUCKET_ARN = "arn:aws:s3:::ddecor-blinds";
const DEFAULT_REGION = "ap-south-1";

export type StoredImage = {
  bucket: string;
  region: string;
  key: string;
  url: string;
  s3Url: string;
};

function bucketName(): string {
  const explicit =
    process.env.S3_BUCKET_NAME ??
    process.env.AWS_S3_BUCKET_NAME ??
    process.env.AWS_S3_BUCKET;
  if (explicit) {
    return explicit;
  }

  const arn = process.env.S3_BUCKET_ARN ?? DEFAULT_BUCKET_ARN;
  const bucket = arn.split(":::")[1];
  if (!bucket) {
    throw new Error("S3 bucket is missing. Set S3_BUCKET_NAME or S3_BUCKET_ARN.");
  }
  return bucket;
}

function awsRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
}

function s3Client(): S3Client {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  return new S3Client({
    region: awsRegion(),
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, sessionToken }
        : undefined,
  });
}

function objectExtension(file: File): string {
  const fromName = file.name.split(".").pop();
  if (fromName && fromName !== file.name) {
    return fromName.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  }
  return file.type.split("/")[1]?.split(";")[0] ?? "jpg";
}

function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export async function storeReceiptImage(file: File): Promise<StoredImage> {
  const bucket = bucketName();
  const region = awsRegion();
  const extension = objectExtension(file);
  const key = `receipts/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;
  const contentType = file.type || "application/octet-stream";
  const body = Buffer.from(await file.arrayBuffer());

  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  appLog("s3.image_store", "receipt_image_uploaded", {
    bucket,
    region,
    key,
    contentType,
    bytes: body.byteLength,
  });

  return {
    bucket,
    region,
    key,
    url: `/api/receipt-images?key=${encodeURIComponent(key)}`,
    s3Url: `https://${bucket}.s3.${region}.amazonaws.com/${encodeS3Key(key)}`,
  };
}

export async function fetchReceiptImage(key: string): Promise<{
  body: ReadableStream | null;
  contentType: string | undefined;
}> {
  if (!key.startsWith("receipts/")) {
    throw new Error("Invalid receipt image key.");
  }

  const response = await s3Client().send(
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
    }),
  );

  return {
    body: response.Body?.transformToWebStream() ?? null,
    contentType: response.ContentType,
  };
}
