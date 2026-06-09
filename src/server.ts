import cors from "@fastify/cors";
import Fastify from "fastify";

import { config } from "./config.js";
import { prisma } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";

const corsOrigin =
  config.corsOrigin === "*"
    ? true
    : config.corsOrigin.split(",").map((origin) => origin.trim());

export const buildServer = async () => {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
    },
  });

  await app.register(cors, {
    origin: corsOrigin,
  });

  app.get("/health", async () => ({
    ok: true,
    service: "drive-you-api",
  }));

  app.get("/health/db", async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;

      return {
        ok: true,
        database: "available",
        service: "drive-you-api",
      };
    } catch (error) {
      request.log.warn({ error }, "Database health check failed.");
      return reply.code(503).send({
        ok: false,
        database: "unavailable",
        service: "drive-you-api",
      });
    }
  });

  await registerAuthRoutes(app);
  await registerMeRoutes(app);

  return app;
};
