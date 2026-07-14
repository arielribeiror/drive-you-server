import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";

import { config } from "./config.js";
import { prisma } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { startNotificationWorker } from "./notifications/worker.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerTripsRoutes } from "./routes/trips.js";
import { registerVehiclesRoutes } from "./routes/vehicles.js";

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
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
    },
    throwFileSizeLimit: true,
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
  await registerVehiclesRoutes(app);
  await registerTripsRoutes(app);
  await registerNotificationRoutes(app);

  const stopNotificationWorker = startNotificationWorker(app.log);
  app.addHook("onClose", async () => {
    stopNotificationWorker();
  });

  return app;
};
