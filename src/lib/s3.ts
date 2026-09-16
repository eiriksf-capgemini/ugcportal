import { S3Client } from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let client: S3Client | undefined;

// Same client works against local MinIO (dev) and DreamObjects (prod) —
// only the env vars differ, see env.example.
export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: requireEnv("S3_ENDPOINT"),
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
}

export function getBucketName(): string {
  return requireEnv("S3_BUCKET_NAME");
}
