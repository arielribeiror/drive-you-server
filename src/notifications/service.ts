import { Prisma } from "@prisma/client";

import { prisma } from "../db.js";
import {
  buildNotificationInputsForVehicles,
  buildOilChangeLoggedNotificationInputs,
  type AppNotificationInput,
  type NotificationMaintenanceBaseline,
  type NotificationVehicle,
} from "./rules.js";
import { sendNotificationPushes } from "./push.js";

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const getNotificationByDedupeKey = (userId: string, dedupeKey: string) =>
  prisma.appNotification.findUnique({
    where: {
      userId_dedupeKey: {
        dedupeKey,
        userId,
      },
    },
  });

export const createNotificationFromInput = async (
  input: AppNotificationInput,
) => {
  try {
    const notification = await prisma.appNotification.create({
      data: {
        dedupeKey: input.dedupeKey,
        payload: input.payload as Prisma.InputJsonObject,
        tone: input.tone,
        type: input.type,
        userId: input.userId,
        vehicleId: input.vehicleId,
      },
    });

    return {
      created: true,
      notification,
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const notification = await getNotificationByDedupeKey(
      input.userId,
      input.dedupeKey,
    );

    if (!notification) {
      throw error;
    }

    return {
      created: false,
      notification,
    };
  }
};

export const createNotificationsFromInputs = async (
  inputs: AppNotificationInput[],
) => {
  const createdNotifications = [];

  for (const input of inputs) {
    const result = await createNotificationFromInput(input);

    if (result.created) {
      createdNotifications.push(result.notification);
    }
  }

  for (const notification of createdNotifications) {
    await sendNotificationPushes(notification.id).catch(() => undefined);
  }

  return createdNotifications;
};

export const generateNotificationsForAllVehicles = async (now = new Date()) => {
  const vehicles = await prisma.vehicle.findMany({
    include: {
      accesses: {
        select: {
          userId: true,
        },
      },
      maintenanceBaselines: true,
    },
  });
  const inputs = buildNotificationInputsForVehicles(
    vehicles as NotificationVehicle[],
    now,
  );

  return createNotificationsFromInputs(inputs);
};

export const createOilChangeLoggedNotifications = async ({
  baseline,
  vehicleId,
}: {
  baseline: NotificationMaintenanceBaseline;
  vehicleId: string;
}) => {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      accesses: {
        select: {
          userId: true,
        },
      },
      maintenanceBaselines: true,
    },
  });

  if (!vehicle) {
    return [];
  }

  return createNotificationsFromInputs(
    buildOilChangeLoggedNotificationInputs(
      vehicle as NotificationVehicle,
      baseline,
    ),
  );
};
