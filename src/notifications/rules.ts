const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const OIL_CHANGE_THRESHOLD_KM = 3_000;
export const OIL_CHANGE_THRESHOLD_DAYS = 45;

type NotificationType =
  | "maintenance_due"
  | "preventive_maintenance"
  | "oil_change_logged"
  | "driving_tip";

type NotificationTone = "info" | "success" | "warning";

export type NotificationMaintenanceBaseline = {
  id: string;
  item: string;
  performedAt: Date | string;
  odometerKm: number;
  usageProfile: string | null;
  intervalKm: number;
  intervalMonths: number | null;
  intervalDays: number | null;
  updatedAt: Date | string;
};

export type NotificationVehicle = {
  id: string;
  brandModel: string | null;
  currentOdometerKm: number | null;
  displayName: string | null;
  plate: string;
  accesses: Array<{ userId: string }>;
  maintenanceBaselines: NotificationMaintenanceBaseline[];
};

export type AppNotificationInput = {
  userId: string;
  vehicleId: string;
  type: NotificationType;
  tone: NotificationTone;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

const toDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);

const toMonthKey = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const toDedupeDateKey = (value: Date | string) =>
  toDate(value).toISOString().slice(0, 10);

const getVehicleTitle = (vehicle: NotificationVehicle) =>
  vehicle.displayName?.trim() || vehicle.brandModel || vehicle.plate;

const getAccessUserIds = (vehicle: NotificationVehicle) => [
  ...new Set(vehicle.accesses.map((access) => access.userId)),
];

const getIntervalDays = (baseline: NotificationMaintenanceBaseline) => {
  if (baseline.intervalDays !== null) {
    return baseline.intervalDays;
  }

  if (baseline.intervalMonths !== null) {
    return baseline.intervalMonths * 30;
  }

  return null;
};

export const getOilChangeReminderState = (
  baseline: NotificationMaintenanceBaseline,
  currentOdometerKm: number | null,
  now = new Date(),
) => {
  const intervalDays = getIntervalDays(baseline);
  const remainingKm =
    currentOdometerKm !== null && baseline.intervalKm > 0
      ? baseline.odometerKm + baseline.intervalKm - currentOdometerKm
      : null;
  const remainingDays =
    intervalDays !== null
      ? Math.ceil(
          (toDate(baseline.performedAt).getTime() +
            intervalDays * DAY_IN_MS -
            now.getTime()) /
            DAY_IN_MS,
        )
      : null;

  const isNearByKm =
    remainingKm !== null && remainingKm <= OIL_CHANGE_THRESHOLD_KM;
  const isNearByDays =
    remainingDays !== null && remainingDays <= OIL_CHANGE_THRESHOLD_DAYS;

  if (!isNearByKm && !isNearByDays) {
    return null;
  }

  return {
    remainingDays,
    remainingKm,
  };
};

export const buildNotificationInputsForVehicles = (
  vehicles: NotificationVehicle[],
  now = new Date(),
) =>
  vehicles.flatMap((vehicle) => {
    const monthKey = toMonthKey(now);
    const vehicleTitle = getVehicleTitle(vehicle);
    const accessUserIds = getAccessUserIds(vehicle);
    const engineOilBaseline = vehicle.maintenanceBaselines.find(
      (baseline) => baseline.item === "engine_oil",
    );
    const inputs: AppNotificationInput[] = [];

    for (const userId of accessUserIds) {
      inputs.push({
        userId,
        vehicleId: vehicle.id,
        type: "preventive_maintenance",
        tone: "info",
        dedupeKey: `preventive_maintenance:${vehicle.id}:${monthKey}`,
        payload: {
          vehicleId: vehicle.id,
          vehicleTitle,
        },
      });
    }

    if (engineOilBaseline) {
      const oilState = getOilChangeReminderState(
        engineOilBaseline,
        vehicle.currentOdometerKm,
        now,
      );

      if (oilState) {
        for (const userId of accessUserIds) {
          inputs.push({
            userId,
            vehicleId: vehicle.id,
            type: "maintenance_due",
            tone: "warning",
            dedupeKey: `maintenance_due:${vehicle.id}:${engineOilBaseline.id}:${toDedupeDateKey(
              engineOilBaseline.updatedAt,
            )}`,
            payload: {
              baselineId: engineOilBaseline.id,
              item: engineOilBaseline.item,
              remainingDays: oilState.remainingDays,
              remainingKm: oilState.remainingKm,
              vehicleId: vehicle.id,
              vehicleTitle,
            },
          });
        }
      }

      if (engineOilBaseline.usageProfile === "severe") {
        for (const userId of accessUserIds) {
          inputs.push({
            userId,
            vehicleId: vehicle.id,
            type: "driving_tip",
            tone: "info",
            dedupeKey: `driving_tip:${vehicle.id}:${monthKey}`,
            payload: {
              usageProfile: engineOilBaseline.usageProfile,
              vehicleId: vehicle.id,
              vehicleTitle,
            },
          });
        }
      }
    }

    return inputs;
  });

export const buildOilChangeLoggedNotificationInputs = (
  vehicle: NotificationVehicle,
  baseline: NotificationMaintenanceBaseline,
) => {
  if (baseline.item !== "engine_oil") {
    return [];
  }

  const vehicleTitle = getVehicleTitle(vehicle);

  return getAccessUserIds(vehicle).map<AppNotificationInput>((userId) => ({
    userId,
    vehicleId: vehicle.id,
    type: "oil_change_logged",
    tone: "success",
    dedupeKey: `oil_change_logged:${vehicle.id}:${baseline.id}:${toDedupeDateKey(
      baseline.updatedAt,
    )}`,
    payload: {
      baselineId: baseline.id,
      item: baseline.item,
      performedAt: toDate(baseline.performedAt).toISOString(),
      vehicleId: vehicle.id,
      vehicleTitle,
    },
  }));
};
