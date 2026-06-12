import type { VehicleMaintenanceItem, VehicleUsageProfile } from "@prisma/client";

export type MaintenanceSchedule = {
  intervalKm: number;
  intervalMonths: number | null;
  intervalDays: number | null;
};

const itemSchedules: Record<
  VehicleMaintenanceItem,
  Partial<Record<VehicleUsageProfile, MaintenanceSchedule>> & {
    default: MaintenanceSchedule;
  }
> = {
  engine_oil: {
    severe: {
      intervalKm: 5_000,
      intervalMonths: 6,
      intervalDays: null,
    },
    light: {
      intervalKm: 10_000,
      intervalMonths: 12,
      intervalDays: null,
    },
    default: {
      intervalKm: 5_000,
      intervalMonths: 6,
      intervalDays: null,
    },
  },
  tires: {
    default: {
      intervalKm: 40_000,
      intervalMonths: null,
      intervalDays: null,
    },
  },
  suspension: {
    default: {
      intervalKm: 50_000,
      intervalMonths: null,
      intervalDays: null,
    },
  },
  brake_fluid: {
    default: {
      intervalKm: 20_000,
      intervalMonths: 24,
      intervalDays: null,
    },
  },
  brake_disc: {
    default: {
      intervalKm: 40_000,
      intervalMonths: null,
      intervalDays: null,
    },
  },
  brake_pads: {
    default: {
      intervalKm: 20_000,
      intervalMonths: null,
      intervalDays: null,
    },
  },
  tire_pressure: {
    default: {
      intervalKm: 0,
      intervalMonths: null,
      intervalDays: 14,
    },
  },
};

export const getMaintenanceSchedule = (
  item: VehicleMaintenanceItem,
  usageProfile?: VehicleUsageProfile | null,
) => {
  const schedules = itemSchedules[item];

  return usageProfile ? schedules[usageProfile] ?? schedules.default : schedules.default;
};
