import { AuthProvider } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import { decodeJwt } from "jose";

import { config } from "../../config.js";
import type { VerifiedIdentity } from "../accounts.js";

const googleClient = new OAuth2Client();
const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

type GoogleTokenDiagnostics = {
  tokenReadable: boolean;
  tokenAudience: string[];
  tokenAuthorizedPresenter?: string;
  tokenIssuer?: string;
  acceptedAudiences: string[];
};

const redactGoogleClientId = (value: string) => {
  const trimmed = value.trim();

  if (!trimmed) {
    return "<empty>";
  }

  if (trimmed.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    const prefix = trimmed.slice(0, -GOOGLE_CLIENT_ID_SUFFIX.length);
    return `${prefix.slice(0, 12)}...${prefix.slice(-6)}${GOOGLE_CLIENT_ID_SUFFIX}`;
  }

  if (trimmed.length <= 16) {
    return "<redacted>";
  }

  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};

const normalizeAudience = (audience: unknown) => {
  if (typeof audience === "string") {
    return [audience];
  }

  if (Array.isArray(audience)) {
    return audience.filter((item): item is string => typeof item === "string");
  }

  return [];
};

export const getGoogleIdTokenDiagnostics = (
  idToken: string,
): GoogleTokenDiagnostics => {
  const acceptedAudiences = config.googleClientIds.map(redactGoogleClientId);

  try {
    const payload = decodeJwt(idToken);
    const authorizedPresenter =
      typeof payload.azp === "string" ? payload.azp : undefined;

    return {
      tokenReadable: true,
      tokenAudience: normalizeAudience(payload.aud).map(redactGoogleClientId),
      ...(authorizedPresenter
        ? { tokenAuthorizedPresenter: redactGoogleClientId(authorizedPresenter) }
        : {}),
      ...(typeof payload.iss === "string" ? { tokenIssuer: payload.iss } : {}),
      acceptedAudiences,
    };
  } catch {
    return {
      tokenReadable: false,
      tokenAudience: [],
      acceptedAudiences,
    };
  }
};

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
