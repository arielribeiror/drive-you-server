import type {
  AppNotificationTone,
  AppNotificationType,
  Prisma,
  PushDeliveryStatus,
} from "@prisma/client";

type PublicPushStatus = "delivered" | "failed" | "pending" | "sent" | null;

export type PublicAppNotification = {
  id: string;
  type: AppNotificationType;
  tone: AppNotificationTone;
  payload: Prisma.JsonValue;
  pushStatus: PublicPushStatus;
  createdAt: string;
  readAt: string | null;
};

export type PublicNotificationInput = {
  id: string;
  type: AppNotificationType;
  tone: AppNotificationTone;
  payload: Prisma.JsonValue;
  deliveries?: Array<{ status: PushDeliveryStatus }>;
  pushedAt?: Date | null;
  createdAt: Date;
  readAt: Date | null;
};

const getPushStatus = (
  notification: Pick<PublicNotificationInput, "deliveries" | "pushedAt">,
): PublicPushStatus => {
  const deliveries = notification.deliveries ?? [];

  if (deliveries.some((delivery) => delivery.status === "failed")) {
    return "failed";
  }

  if (deliveries.some((delivery) => delivery.status === "delivered")) {
    return "delivered";
  }

  if (deliveries.some((delivery) => delivery.status === "sent")) {
    return "sent";
  }

  if (deliveries.some((delivery) => delivery.status === "pending")) {
    return "pending";
  }

  return notification.pushedAt ? "sent" : null;
};

export const toPublicNotification = (
  notification: PublicNotificationInput,
): PublicAppNotification => ({
  id: notification.id,
  type: notification.type,
  tone: notification.tone,
  payload: notification.payload,
  pushStatus: getPushStatus(notification),
  createdAt: notification.createdAt.toISOString(),
  readAt: notification.readAt?.toISOString() ?? null,
});
