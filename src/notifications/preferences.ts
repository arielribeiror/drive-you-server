import type { AppNotificationType, NotificationPreferenceType } from "@prisma/client";

import { prisma } from "../db.js";

export const notificationPreferenceTypes = [
  "maintenance_due",
  "preventive_maintenance",
  "oil_change_logged",
  "driving_tip",
  "trip_confirmation",
] as const satisfies readonly NotificationPreferenceType[];

export type PublicNotificationPreference = {
  type: NotificationPreferenceType;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  updatedAt: string | null;
};

export const defaultNotificationPreference = (
  type: NotificationPreferenceType,
): PublicNotificationPreference => ({
  type,
  inAppEnabled: true,
  pushEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  updatedAt: null,
});

export const toPublicNotificationPreference = (
  preference: {
    inAppEnabled: boolean;
    pushEnabled: boolean;
    quietHoursEnd: string | null;
    quietHoursStart: string | null;
    type: NotificationPreferenceType;
    updatedAt: Date;
  },
): PublicNotificationPreference => ({
  type: preference.type,
  inAppEnabled: preference.inAppEnabled,
  pushEnabled: preference.pushEnabled,
  quietHoursStart: preference.quietHoursStart,
  quietHoursEnd: preference.quietHoursEnd,
  updatedAt: preference.updatedAt.toISOString(),
});

export const listNotificationPreferences = async (userId: string) => {
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId },
  });
  const preferenceByType = new Map(
    preferences.map((preference) => [preference.type, preference]),
  );

  return notificationPreferenceTypes.map((type) => {
    const preference = preferenceByType.get(type);
    return preference
      ? toPublicNotificationPreference(preference)
      : defaultNotificationPreference(type);
  });
};

export const getNotificationPreference = async (
  userId: string,
  type: AppNotificationType | NotificationPreferenceType,
) => {
  const preference = await prisma.notificationPreference.findUnique({
    where: {
      userId_type: {
        userId,
        type: type as NotificationPreferenceType,
      },
    },
  });

  return preference ?? defaultNotificationPreference(type as NotificationPreferenceType);
};

const toMinutes = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

export const isNowInQuietHours = (
  preference: Pick<
    PublicNotificationPreference,
    "quietHoursEnd" | "quietHoursStart"
  >,
  now = new Date(),
) => {
  if (!preference.quietHoursStart || !preference.quietHoursEnd) {
    return false;
  }

  const start = toMinutes(preference.quietHoursStart);
  const end = toMinutes(preference.quietHoursEnd);
  const current = now.getHours() * 60 + now.getMinutes();

  if (start === end) {
    return false;
  }

  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
};
