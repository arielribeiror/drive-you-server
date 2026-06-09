import { createHash, randomBytes, randomInt } from "node:crypto";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isApplePrivateRelayEmail = (email?: string | null) =>
  normalizeEmail(email ?? "").endsWith("@privaterelay.appleid.com");

export const createRandomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");

export const createMagicCode = () =>
  randomInt(0, 1_000_000).toString().padStart(6, "0");

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const buildMagicLink = (baseUrl: string, token: string) => {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
};

export const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60 * 1000);

export const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
