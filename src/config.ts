import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://driveyou:driveyou@localhost:5432/drive_you?schema=public"),
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  MAGIC_LINK_BASE_URL: z.string().min(1).default("driveyou://auth/magic-link"),
  VEHICLE_SHARE_INVITE_TTL_DAYS: z.coerce.number().int().positive().default(14),
  CORS_ORIGIN: z.string().default("*"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .min(1)
    .default("Drive You <auth@driveyou.app>"),
  GOOGLE_CLIENT_IDS: z.string().optional(),
  GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_IDS: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  REMOVE_BG_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ODOMETER_READING_MODEL: z.string().min(1).default("gpt-5.5"),
  VEHICLE_IMAGES_UPLOAD_DIR: z.string().default("uploads/vehicle-images"),
  NOTIFICATION_WORKER_ENABLED: z.string().default("true"),
  NOTIFICATION_WORKER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  EXPO_PUSH_ACCESS_TOKEN: z.string().optional(),
});

const env = envSchema.parse(process.env);

const splitCsv = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];

const unique = (values: string[]) => [...new Set(values)];

const parseBoolean = (value: string) =>
  !["0", "false", "no", "off"].includes(value.trim().toLowerCase());

const jwtSecret =
  env.JWT_SECRET ??
  (env.NODE_ENV === "production"
    ? undefined
    : "drive-you-development-jwt-secret-change-before-production");

if (!jwtSecret) {
  throw new Error("JWT_SECRET is required in production.");
}

const googleClientIds = unique([
  ...splitCsv(env.GOOGLE_CLIENT_IDS),
  ...splitCsv(env.GOOGLE_WEB_CLIENT_ID),
  ...splitCsv(env.GOOGLE_IOS_CLIENT_ID),
  ...splitCsv(env.GOOGLE_ANDROID_CLIENT_ID),
]);

const appleClientIds = unique([
  ...splitCsv(env.APPLE_CLIENT_IDS),
  ...splitCsv(env.APPLE_BUNDLE_ID),
]);

if (env.NODE_ENV === "production" && googleClientIds.length === 0) {
  throw new Error("At least one Google client id is required in production.");
}

if (env.NODE_ENV === "production" && appleClientIds.length === 0) {
  throw new Error("At least one Apple client id is required in production.");
}

if (env.NODE_ENV === "production" && !env.RESEND_API_KEY) {
  throw new Error("RESEND_API_KEY is required in production.");
}

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  databaseUrl: env.DATABASE_URL,
  jwtSecret,
  accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  magicLinkTtlMinutes: env.MAGIC_LINK_TTL_MINUTES,
  magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL,
  vehicleShareInviteTtlDays: env.VEHICLE_SHARE_INVITE_TTL_DAYS,
  corsOrigin: env.CORS_ORIGIN,
  resendApiKey: env.RESEND_API_KEY,
  resendFromEmail: env.RESEND_FROM_EMAIL,
  googleClientIds,
  appleClientIds,
  removeBgApiKey: env.REMOVE_BG_API_KEY,
  openaiApiKey: env.OPENAI_API_KEY,
  odometerReadingModel: env.ODOMETER_READING_MODEL,
  vehicleImagesUploadDir: env.VEHICLE_IMAGES_UPLOAD_DIR,
  notificationWorkerEnabled:
    env.NODE_ENV !== "test" && parseBoolean(env.NOTIFICATION_WORKER_ENABLED),
  notificationWorkerIntervalMs: env.NOTIFICATION_WORKER_INTERVAL_MS,
  expoPushAccessToken: env.EXPO_PUSH_ACCESS_TOKEN,
};
