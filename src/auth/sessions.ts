import type { FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import type { PrismaClient, User } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { config } from "../config.js";
import { addDays, createRandomToken, hashToken } from "./crypto.js";
import { toPublicUser } from "./public-user.js";

const jwtSecret = new TextEncoder().encode(config.jwtSecret);

export class AuthError extends Error {
  statusCode = 401;
}

const signAccessToken = async (userId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(jwtSecret);

const getRequestMetadata = (request?: FastifyRequest) => ({
  userAgent: request?.headers["user-agent"],
  ipAddress: request?.ip,
});

const createRefreshToken = async (
  tx: PrismaClient | Prisma.TransactionClient,
  userId: string,
  request?: FastifyRequest,
) => {
  const refreshToken = createRandomToken(48);
  const metadata = getRequestMetadata(request);

  const storedRefreshToken = await tx.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: addDays(new Date(), config.refreshTokenTtlDays),
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress,
    },
  });

  return {
    refreshToken,
    storedRefreshToken,
  };
};

export const issueSession = async (
  tx: PrismaClient | Prisma.TransactionClient,
  user: User,
  request?: FastifyRequest,
) => {
  const accessToken = await signAccessToken(user.id);
  const { refreshToken } = await createRefreshToken(tx, user.id, request);

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken,
    expiresIn: config.accessTokenTtlSeconds,
  };
};

export const verifyAccessToken = async (accessToken: string) => {
  const { payload } = await jwtVerify(accessToken, jwtSecret);

  if (!payload.sub) {
    throw new AuthError("Access token does not include a subject.");
  }

  return payload.sub;
};

export const getBearerToken = (request: FastifyRequest) => {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthError("Missing bearer token.");
  }

  return authorization.slice("Bearer ".length);
};

export const rotateRefreshToken = async (
  prisma: PrismaClient,
  refreshToken: string,
  request?: FastifyRequest,
) =>
  prisma.$transaction(async (tx) => {
    const tokenHash = hashToken(refreshToken);
    const storedToken = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !storedToken ||
      storedToken.revokedAt ||
      storedToken.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError("Invalid refresh token.");
    }

    const { refreshToken: nextRefreshToken, storedRefreshToken } =
      await createRefreshToken(tx, storedToken.userId, request);

    await tx.refreshToken.update({
      where: { id: storedToken.id },
      data: {
        revokedAt: new Date(),
        replacedByTokenId: storedRefreshToken.id,
      },
    });

    const accessToken = await signAccessToken(storedToken.userId);

    return {
      user: toPublicUser(storedToken.user),
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: config.accessTokenTtlSeconds,
    };
  });

export const revokeRefreshToken = async (
  prisma: PrismaClient,
  refreshToken: string,
) => {
  await prisma.refreshToken.updateMany({
    where: {
      tokenHash: hashToken(refreshToken),
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
};
