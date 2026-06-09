import { AuthProvider } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { config } from "../../config.js";
import type { VerifiedIdentity } from "../accounts.js";
import { isApplePrivateRelayEmail } from "../crypto.js";

const appleJwks = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

const parseAppleBoolean = (value: unknown) =>
  value === true || value === "true" || value === 1 || value === "1";

export const verifyAppleIdentityToken = async (
  identityToken: string,
): Promise<VerifiedIdentity> => {
  if (config.nodeEnv === "production" && config.appleClientIds.length === 0) {
    throw new Error("Apple client ids are not configured.");
  }

  const { payload } = await jwtVerify(identityToken, appleJwks, {
    issuer: "https://appleid.apple.com",
    ...(config.appleClientIds.length > 0
      ? { audience: config.appleClientIds }
      : {}),
  });

  if (!payload.sub) {
    throw new Error("Apple identity token did not include a subject.");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const isPrivateEmail =
    parseAppleBoolean(payload.is_private_email) ||
    isApplePrivateRelayEmail(email);

  return {
    provider: AuthProvider.apple,
    providerSubject: payload.sub,
    email,
    emailVerified: parseAppleBoolean(payload.email_verified),
    isPrivateEmail,
  };
};
