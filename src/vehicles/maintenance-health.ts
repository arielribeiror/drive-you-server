import type {
  VehicleMaintenanceBaseline,
  VehicleMaintenanceItem,
  VehicleTrip,
} from "@prisma/client";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

type MaintenanceHealthStatus = "attention" | "due" | "good";

export type MaintenanceHealthInput = {
  currentOdometerKm: number | null;
  maintenanceBaselines: VehicleMaintenanceBaseline[];
  trips: Pick<
    VehicleTrip,
    "averageSpeedKmh" | "distanceMeters" | "durationSeconds" | "startedAt"
  >[];
};

export type MaintenanceHealthItem = {
  item: VehicleMaintenanceItem;
  baselineId: string;
  percentRemaining: number;
  remainingDays: number | null;
  remainingKm: number | null;
  severityMultiplier: number;
  status: MaintenanceHealthStatus;
  factors: {
    cityTripCount: number;
    coldStartCount: number;
    highwayTripCount: number;
    severeUsageProfile: boolean;
  };
};

const getIntervalDays = (baseline: VehicleMaintenanceBaseline) => {
  if (baseline.intervalDays !== null) {
    return baseline.intervalDays;
  }

  if (baseline.intervalMonths !== null) {
    return baseline.intervalMonths * 30;
  }

  return null;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getStatus = (percentRemaining: number): MaintenanceHealthStatus => {
  if (percentRemaining <= 0) {
    return "due";
  }

  if (percentRemaining <= 25) {
    return "attention";
  }

  return "good";
};

const getTripFactors = (
  baseline: VehicleMaintenanceBaseline,
  trips: MaintenanceHealthInput["trips"],
) => {
  const baselineTime = baseline.performedAt.getTime();
  const relevantTrips = trips.filter(
    (trip) => trip.startedAt.getTime() >= baselineTime,
  );
  const coldStartCount = relevantTrips.filter(
    (trip) => trip.distanceMeters <= 5_000 || trip.durationSeconds <= 900,
  ).length;
  const cityTripCount = relevantTrips.filter(
    (trip) =>
      (trip.averageSpeedKmh ?? 0) > 0 &&
      (trip.averageSpeedKmh ?? 0) <= 28 &&
      trip.durationSeconds >= 600,
  ).length;
  const highwayTripCount = relevantTrips.filter(
    (trip) => (trip.averageSpeedKmh ?? 0) >= 70,
  ).length;
  const severeUsageProfile = baseline.usageProfile === "severe";
  const multiplier = clamp(
    1 +
      coldStartCount * 0.015 +
      cityTripCount * 0.012 -
      highwayTripCount * 0.004 +
      (severeUsageProfile ? 0.15 : 0),
    0.9,
    1.45,
  );

  return {
    cityTripCount,
    coldStartCount,
    highwayTripCount,
    multiplier,
    severeUsageProfile,
  };
};

export const calculateMaintenanceHealth = ({
  currentOdometerKm,
  maintenanceBaselines,
  trips,
}: MaintenanceHealthInput) =>
  maintenanceBaselines.map<MaintenanceHealthItem>((baseline) => {
    const intervalDays = getIntervalDays(baseline);
    const factors = getTripFactors(baseline, trips);
    const elapsedKm =
      currentOdometerKm !== null && baseline.intervalKm > 0
        ? Math.max(0, currentOdometerKm - baseline.odometerKm)
        : null;
    const kmUsage =
      elapsedKm !== null && baseline.intervalKm > 0
        ? elapsedKm / baseline.intervalKm
        : null;
    const elapsedDays =
      intervalDays !== null
        ? Math.max(0, (Date.now() - baseline.performedAt.getTime()) / DAY_IN_MS)
        : null;
    const timeUsage =
      elapsedDays !== null && intervalDays !== null && intervalDays > 0
        ? elapsedDays / intervalDays
        : null;
    const usageCandidates = [kmUsage, timeUsage].filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
    const baseUsage =
      usageCandidates.length > 0 ? Math.max(...usageCandidates) : 0;
    const adjustedUsage = baseUsage * factors.multiplier;
    const percentRemaining = Math.round(clamp(100 - adjustedUsage * 100, 0, 100));
    const remainingKm =
      currentOdometerKm !== null && baseline.intervalKm > 0
        ? Math.round(
            baseline.odometerKm +
              baseline.intervalKm / factors.multiplier -
              currentOdometerKm,
          )
        : null;
    const remainingDays =
      intervalDays !== null
        ? Math.ceil(
            (baseline.performedAt.getTime() +
              (intervalDays / factors.multiplier) * DAY_IN_MS -
              Date.now()) /
              DAY_IN_MS,
          )
        : null;

    return {
      baselineId: baseline.id,
      factors: {
        cityTripCount: factors.cityTripCount,
        coldStartCount: factors.coldStartCount,
        highwayTripCount: factors.highwayTripCount,
        severeUsageProfile: factors.severeUsageProfile,
      },
      item: baseline.item,
      percentRemaining,
      remainingDays,
      remainingKm,
      severityMultiplier: Number(factors.multiplier.toFixed(2)),
      status: getStatus(percentRemaining),
    };
  });
