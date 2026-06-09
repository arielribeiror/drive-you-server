import { AuthProvider } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  databaseUnavailablePayload,
  isDatabaseConnectionError,
} from "../errors.js";
import { findOrCreateUserForIdentity } from "../auth/accounts.js";
import {
  addMinutes,
  buildMagicLink,
  createRandomToken,
  hashToken,
  normalizeEmail,
} from "../auth/crypto.js";
import {
  AuthError,
  issueSession,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../auth/sessions.js";
import { verifyAppleIdentityToken } from "../auth/providers/apple.js";
import { verifyGoogleIdToken } from "../auth/providers/google.js";
import { sendMagicLinkEmail } from "../email/magic-link.js";

const googleBodySchema = z.object({
  idToken: z.string().min(1),
});

const appleBodySchema = z.object({
  identityToken: z.string().min(1),
});

const magicRequestBodySchema = z.object({
  email: z.string().email(),
});

const magicVerifyBodySchema = z.object({
  token: z.string().min(16),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(16),
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(16),
});

const validationError = () => ({
  error: "invalid_request",
  message: "Request body is invalid.",
});

export const registerAuthRoutes = async (app: FastifyInstance) => {
  app.post("/auth/google", async (request, reply) => {
    const parsed = googleBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const identity = await verifyGoogleIdToken(parsed.data.idToken);
      const session = await prisma.$transaction(async (tx) => {
        const user = await findOrCreateUserForIdentity(tx, identity);
        return issueSession(tx, user, request);
      });

      return reply.send(session);
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during Google authentication.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Google authentication failed.");
      return reply.code(401).send({
        error: "invalid_google_token",
        message: "Google authentication failed.",
      });
    }
  });

  app.post("/auth/apple", async (request, reply) => {
    const parsed = appleBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const identity = await verifyAppleIdentityToken(parsed.data.identityToken);
      const session = await prisma.$transaction(async (tx) => {
        const user = await findOrCreateUserForIdentity(tx, identity);
        return issueSession(tx, user, request);
      });

      return reply.send(session);
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during Apple authentication.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Apple authentication failed.");
      return reply.code(401).send({
        error: "invalid_apple_token",
        message: "Apple authentication failed.",
      });
    }
  });

  app.post("/auth/magic/request", async (request, reply) => {
    const parsed = magicRequestBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const email = parsed.data.email.trim();
      const emailNormalized = normalizeEmail(email);
      const existingUser = await prisma.user.findUnique({
        where: { emailNormalized },
      });

      const rawToken = createRandomToken(32);
      const magicLink = buildMagicLink(config.magicLinkBaseUrl, rawToken);

      await prisma.magicLinkToken.create({
        data: {
          userId: existingUser?.id,
          email,
          emailNormalized,
          tokenHash: hashToken(rawToken),
          expiresAt: addMinutes(new Date(), config.magicLinkTtlMinutes),
        },
      });

      const emailResult = await sendMagicLinkEmail(email, magicLink);

      return reply.code(202).send({
        ok: true,
        ...(config.nodeEnv !== "production" && !emailResult.sent
          ? { devLink: magicLink }
          : {}),
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during magic link request.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Magic link request failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Magic link request failed.",
      });
    }
  });

  app.post("/auth/magic/verify", async (request, reply) => {
    const parsed = magicVerifyBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const session = await prisma.$transaction(async (tx) => {
        const tokenHash = hashToken(parsed.data.token);
        const magicToken = await tx.magicLinkToken.findUnique({
          where: { tokenHash },
        });

        if (
          !magicToken ||
          magicToken.consumedAt ||
          magicToken.expiresAt.getTime() <= Date.now()
        ) {
          throw new AuthError("Invalid magic link token.");
        }

        const consumedToken = await tx.magicLinkToken.updateMany({
          where: {
            id: magicToken.id,
            consumedAt: null,
          },
          data: { consumedAt: new Date() },
        });

        if (consumedToken.count !== 1) {
          throw new AuthError("Magic link token was already consumed.");
        }

        const user = await findOrCreateUserForIdentity(tx, {
          provider: AuthProvider.magic_link,
          providerSubject: magicToken.emailNormalized,
          email: magicToken.email,
          emailVerified: true,
          isPrivateEmail: false,
        });

        return issueSession(tx, user, request);
      });

      return reply.send(session);
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during magic link verification.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Magic link verification failed.");
      return reply.code(401).send({
        error: "invalid_magic_link",
        message: "Magic link is invalid or expired.",
      });
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const session = await rotateRefreshToken(
        prisma,
        parsed.data.refreshToken,
        request,
      );

      return reply.send(session);
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during refresh token rotation.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Refresh token rotation failed.");
      return reply.code(401).send({
        error: "invalid_refresh_token",
        message: "Refresh token is invalid or expired.",
      });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const parsed = logoutBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(validationError());
    }

    try {
      await revokeRefreshToken(prisma, parsed.data.refreshToken);

      return reply.code(204).send();
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during logout.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Logout failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Logout failed.",
      });
    }
  });
};
