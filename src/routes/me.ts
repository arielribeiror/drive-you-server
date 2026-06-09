import type { FastifyInstance } from "fastify";

import { prisma } from "../db.js";
import {
  databaseUnavailablePayload,
  isDatabaseConnectionError,
} from "../errors.js";
import { getBearerToken, verifyAccessToken } from "../auth/sessions.js";
import { toPublicUser } from "../auth/public-user.js";

export const registerMeRoutes = async (app: FastifyInstance) => {
  app.get("/me", async (request, reply) => {
    try {
      const accessToken = getBearerToken(request);
      const userId = await verifyAccessToken(accessToken);
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "User no longer exists.",
        });
      }

      return reply.send({ user: toPublicUser(user) });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn({ error }, "Database unavailable during user lookup.");
        return reply.code(503).send(databaseUnavailablePayload);
      }

      request.log.warn({ error }, "Authenticated user lookup failed.");
      return reply.code(401).send({
        error: "invalid_access_token",
        message: "Access token is invalid or expired.",
      });
    }
  });
};
