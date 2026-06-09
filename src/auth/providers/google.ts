import { AuthProvider } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";

import { config } from "../../config.js";
import type { VerifiedIdentity } from "../accounts.js";

const googleClient = new OAuth2Client();

export const verifyGoogleIdToken = async (
  idToken: string,
): Promise<VerifiedIdentity> => {
  if (config.googleClientIds.length === 0) {
    throw new Error("Google client ids are not configured.");
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: config.googleClientIds,
  });
  const payload = ticket.getPayload();

  if (!payload?.sub) {
    throw new Error("Google id token did not include a subject.");
  }

  return {
    provider: AuthProvider.google,
    providerSubject: payload.sub,
    email: payload.email ?? null,
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
    avatarUrl: payload.picture ?? null,
  };
};
