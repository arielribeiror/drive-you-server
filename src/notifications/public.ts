import type {
  AppNotificationTone,
  AppNotificationType,
  Prisma,
} from "@prisma/client";

export type PublicAppNotification = {
  id: string;
  type: AppNotificationType;
  tone: AppNotificationTone;
  payload: Prisma.JsonValue;
  createdAt: string;
  readAt: string | null;
};

export type PublicNotificationInput = {
  id: string;
  type: AppNotificationType;
  tone: AppNotificationTone;
  payload: Prisma.JsonValue;
  createdAt: Date;
  readAt: Date | null;
};

export const toPublicNotification = (
  notification: PublicNotificationInput,
): PublicAppNotification => ({
  id: notification.id,
  type: notification.type,
  tone: notification.tone,
  payload: notification.payload,
  createdAt: notification.createdAt.toISOString(),
  readAt: notification.readAt?.toISOString() ?? null,
});
