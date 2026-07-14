import type {
  AppNotification,
  PushDelivery,
  PushDevice,
  PushDeliveryStatus,
} from "@prisma/client";

import { config } from "../config.js";
import { prisma } from "../db.js";
import { formatPushContent } from "./content.js";
import { getNotificationPreference, isNowInQuietHours } from "./preferences.js";

const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;
const MAX_EXPO_PUSH_BATCH = 100;
const MAX_EXPO_RECEIPT_BATCH = 1000;

type ExpoPushTicket =
  | {
      status: "ok";
      id: string;
    }
  | {
      status: "error";
      message?: string;
      details?: {
        error?: string;
      };
    };

type ExpoPushReceipt =
  | {
      status: "ok";
    }
  | {
      status: "error";
      message?: string;
      details?: {
        error?: string;
      };
    };

type ExpoPushSendResponse = {
  data?: ExpoPushTicket[];
  errors?: Array<{ message?: string }>;
};

type ExpoPushReceiptsResponse = {
  data?: Record<string, ExpoPushReceipt>;
  errors?: Array<{ message?: string }>;
};

type PushMessage = {
  to: string;
  title: string;
  body: string;
  channelId: "app-notifications";
  sound: "default";
  data: {
    type: "app-notification";
    notificationId: string;
  };
};

const chunk = <Value>(values: Value[], size: number) => {
  const chunks: Value[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const getExpoHeaders = () => ({
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate",
  "Content-Type": "application/json",
  ...(config.expoPushAccessToken
    ? { Authorization: `Bearer ${config.expoPushAccessToken}` }
    : {}),
});

export const isDeviceNotRegisteredError = (error?: string | null) =>
  error === "DeviceNotRegistered";

const getPushError = (
  value: { details?: { error?: string }; message?: string },
) => value.details?.error ?? value.message ?? "push_failed";

export const resolveReceiptStatus = (
  receipt: ExpoPushReceipt,
): {
  status: PushDeliveryStatus;
  error: string | null;
} =>
  receipt.status === "ok"
    ? { status: "delivered", error: null }
    : { status: "failed", error: getPushError(receipt) };

const disableDeviceIfUnregistered = async (
  deviceId: string | null | undefined,
  error?: string | null,
) => {
  if (!deviceId || !isDeviceNotRegisteredError(error)) {
    return;
  }

  await prisma.pushDevice.updateMany({
    where: { id: deviceId },
    data: {
      disabledAt: new Date(),
      isActive: false,
    },
  });
};

const sendExpoMessages = async (messages: PushMessage[]) => {
  const response = await fetch(EXPO_PUSH_SEND_URL, {
    method: "POST",
    headers: getExpoHeaders(),
    body: JSON.stringify(messages),
  });
  const body = (await response.json().catch(() => ({}))) as ExpoPushSendResponse;

  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.[0]?.message ?? "expo_push_send_failed");
  }

  return body.data ?? [];
};

const getExpoReceipts = async (ids: string[]) => {
  const response = await fetch(EXPO_PUSH_RECEIPTS_URL, {
    method: "POST",
    headers: getExpoHeaders(),
    body: JSON.stringify({ ids }),
  });
  const body = (await response.json().catch(() => ({}))) as ExpoPushReceiptsResponse;

  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.[0]?.message ?? "expo_push_receipts_failed");
  }

  return body.data ?? {};
};

const getOrCreateDelivery = async (
  notification: AppNotification,
  device: PushDevice,
) => {
  const existing = await prisma.pushDelivery.findUnique({
    where: {
      notificationId_deviceId: {
        deviceId: device.id,
        notificationId: notification.id,
      },
    },
  });

  if (existing) {
    return existing.status === "delivered" || existing.status === "sent"
      ? null
      : existing;
  }

  return prisma.pushDelivery.create({
    data: {
      deviceId: device.id,
      expoPushToken: device.expoPushToken,
      notificationId: notification.id,
      status: "pending",
    },
  });
};

const toPushMessage = ({
  device,
  notification,
}: {
  device: PushDevice;
  notification: AppNotification;
}): PushMessage => {
  const content = formatPushContent({
    locale: device.locale,
    payload: notification.payload,
    type: notification.type,
  });

  return {
    to: device.expoPushToken,
    title: content.title,
    body: content.body,
    channelId: "app-notifications",
    sound: "default",
    data: {
      notificationId: notification.id,
      type: "app-notification",
    },
  };
};

export const sendNotificationPushes = async (notificationId: string) => {
  const notification = await prisma.appNotification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    return [];
  }

  const preference = await getNotificationPreference(
    notification.userId,
    notification.type,
  );

  if (!preference.pushEnabled) {
    return [];
  }

  if (isNowInQuietHours(preference)) {
    return [];
  }

  const devices = await prisma.pushDevice.findMany({
    where: {
      isActive: true,
      userId: notification.userId,
    },
  });
  const pendingDeliveries: Array<{
    delivery: PushDelivery;
    device: PushDevice;
    message: PushMessage;
  }> = [];

  for (const device of devices) {
    const delivery = await getOrCreateDelivery(notification, device);

    if (!delivery) {
      continue;
    }

    pendingDeliveries.push({
      delivery,
      device,
      message: toPushMessage({ device, notification }),
    });
  }

  for (const batch of chunk(pendingDeliveries, MAX_EXPO_PUSH_BATCH)) {
    const tickets = await sendExpoMessages(batch.map((item) => item.message));

    await Promise.all(
      batch.map(async (item, index) => {
        const ticket = tickets[index];

        if (!ticket) {
          await prisma.pushDelivery.update({
            where: { id: item.delivery.id },
            data: {
              error: "missing_push_ticket",
              status: "failed",
            },
          });
          return;
        }

        if (ticket.status === "ok") {
          await prisma.pushDelivery.update({
            where: { id: item.delivery.id },
            data: {
              error: null,
              status: "sent",
              ticketId: ticket.id,
            },
          });
          return;
        }

        const error = getPushError(ticket);
        await prisma.pushDelivery.update({
          where: { id: item.delivery.id },
          data: {
            error,
            status: "failed",
          },
        });
        await disableDeviceIfUnregistered(item.device.id, error);
      }),
    );
  }

  if (pendingDeliveries.length > 0) {
    await prisma.appNotification.update({
      where: { id: notification.id },
      data: { pushedAt: new Date() },
    });
  }

  return pendingDeliveries.map((item) => item.delivery);
};

export const sendUnpushedNotifications = async () => {
  const notifications = await prisma.appNotification.findMany({
    where: { pushedAt: null },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const notification of notifications) {
    await sendNotificationPushes(notification.id).catch(() => undefined);
  }

  return notifications.length;
};

export const checkPendingPushReceipts = async (now = new Date()) => {
  const cutoff = new Date(now.getTime() - RECEIPT_CHECK_DELAY_MS);
  const deliveries = await prisma.pushDelivery.findMany({
    where: {
      receiptCheckedAt: null,
      status: "sent",
      ticketId: { not: null },
      updatedAt: { lte: cutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_EXPO_RECEIPT_BATCH,
  });
  const ticketIds = deliveries
    .map((delivery) => delivery.ticketId)
    .filter((ticketId): ticketId is string => !!ticketId);

  if (ticketIds.length === 0) {
    return 0;
  }

  const receipts = await getExpoReceipts(ticketIds);

  await Promise.all(
    deliveries.map(async (delivery) => {
      if (!delivery.ticketId) {
        return;
      }

      const receipt = receipts[delivery.ticketId];

      if (!receipt) {
        return;
      }

      const resolved = resolveReceiptStatus(receipt);
      await prisma.pushDelivery.update({
        where: { id: delivery.id },
        data: {
          error: resolved.error,
          receiptCheckedAt: now,
          status: resolved.status,
        },
      });
      await disableDeviceIfUnregistered(delivery.deviceId, resolved.error);
    }),
  );

  return deliveries.length;
};
