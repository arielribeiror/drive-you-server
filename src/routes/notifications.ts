import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AuthError,
  getBearerToken,
  verifyAccessToken,
} from "../auth/sessions.js";
import { prisma } from "../db.js";
import {
  databaseUnavailablePayload,
  isDatabaseConnectionError,
} from "../errors.js";
import { toPublicNotification } from "../notifications/public.js";

const validationError = () => ({
  error: "invalid_request",
  message: "Request data is invalid.",
});

const notificationIdParamsSchema = z.object({
  notificationId: z.string().min(1),
});

const pushDeviceBodySchema = z.object({
  expoPushToken: z
    .string()
    .regex(/^(ExpoPushToken|ExponentPushToken)\[[^\]]+\]$/),
  locale: z.string().min(2).max(35).optional(),
  platform: z.enum(["android", "ios", "web"]),
});

const unregisterPushDeviceBodySchema = z.object({
  expoPushToken: z
    .string()
    .regex(/^(ExpoPushToken|ExponentPushToken)\[[^\]]+\]$/),
});

const getAuthenticatedUserId = async (request: FastifyRequest) => {
  const accessToken = getBearerToken(request);
  const userId = await verifyAccessToken(accessToken);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw new AuthError("User no longer exists.");
  }

  return userId;
};

export const registerNotificationRoutes = async (app: FastifyInstance) => {
  app.get("/notifications", async (request, reply) => {
    try {
      const userId = await getAuthenticatedUserId(request);
      const [notifications, unreadCount] = await Promise.all([
        prisma.appNotification.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.appNotification.count({
          where: {
            readAt: null,
            userId,
          },
        }),
      ]);

      return reply.send({
        notifications: notifications.map(toPublicNotification),
        unreadCount,
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Notification list failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Notification list failed.",
      });
    }
  });

  app.patch("/notifications/:notificationId/read", async (request, reply) => {
    const parsedParams = notificationIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const notification = await prisma.appNotification.findFirst({
        where: {
          id: parsedParams.data.notificationId,
          userId,
        },
      });

      if (!notification) {
        return reply.code(404).send({
          error: "notification_not_found",
          message: "Notification was not found for this user.",
        });
      }

      const updatedNotification = notification.readAt
        ? notification
        : await prisma.appNotification.update({
            where: { id: notification.id },
            data: { readAt: new Date() },
          });
      const unreadCount = await prisma.appNotification.count({
        where: {
          readAt: null,
          userId,
        },
      });

      return reply.send({
        notification: toPublicNotification(updatedNotification),
        unreadCount,
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Notification mark-read failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Notification mark-read failed.",
      });
    }
  });

  app.post("/push-devices", async (request, reply) => {
    const parsedBody = pushDeviceBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const device = await prisma.pushDevice.upsert({
        where: {
          expoPushToken: parsedBody.data.expoPushToken,
        },
        create: {
          expoPushToken: parsedBody.data.expoPushToken,
          isActive: true,
          lastRegisteredAt: new Date(),
          locale: parsedBody.data.locale,
          platform: parsedBody.data.platform,
          userId,
        },
        update: {
          disabledAt: null,
          isActive: true,
          lastRegisteredAt: new Date(),
          locale: parsedBody.data.locale,
          platform: parsedBody.data.platform,
          userId,
        },
      });

      return reply.code(201).send({
        device: {
          id: device.id,
          platform: device.platform,
          locale: device.locale,
          isActive: device.isActive,
        },
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Push device registration failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Push device registration failed.",
      });
    }
  });

  app.post("/push-devices/unregister", async (request, reply) => {
    const parsedBody = unregisterPushDeviceBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);

      await prisma.pushDevice.updateMany({
        where: {
          expoPushToken: parsedBody.data.expoPushToken,
          userId,
        },
        data: {
          disabledAt: new Date(),
          isActive: false,
        },
      });

      return reply.code(204).send();
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Push device unregister failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Push device unregister failed.",
      });
    }
  });
};
