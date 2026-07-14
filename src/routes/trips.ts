import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Vehicle, VehicleAccessRole, VehicleTrip } from "@prisma/client";
import { Prisma } from "@prisma/client";
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
import {
  getEstimatedOdometerKm,
  isPlausibleTripAverageSpeed,
} from "../trips/trip-metrics.js";

const MAX_ROUTE_POLYLINE_LENGTH = 100_000;
const MAX_ROUTE_SAMPLE_COUNT = 100_000;

const validationError = () => ({
  error: "invalid_request",
  message: "Request data is invalid.",
});

const vehicleIdParamsSchema = z.object({
  vehicleId: z.string().min(1),
});

const tripIdParamsSchema = z.object({
  tripId: z.string().min(1),
});

const dateStringSchema = z
  .string()
  .min(1)
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()));

const tripLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const createTripBodySchema = z
  .object({
    clientTripId: z.string().trim().min(1).max(120),
    startedAt: dateStringSchema,
    endedAt: dateStringSchema,
    durationSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60),
    distanceMeters: z.number().int().min(100).max(5_000_000),
    averageSpeedKmh: z.number().int().min(0).max(240).optional(),
    maxSpeedKmh: z.number().int().min(0).max(260).optional(),
    startLocation: tripLocationSchema,
    endLocation: tripLocationSchema,
    routePolyline: z.string().max(MAX_ROUTE_POLYLINE_LENGTH).optional(),
    routeSampleCount: z.number().int().min(0).max(MAX_ROUTE_SAMPLE_COUNT).optional(),
    detectionSource: z.enum(["gps", "motion_activity", "mixed"]),
  })
  .refine((body) => body.endedAt.getTime() > body.startedAt.getTime())
  .refine((body) =>
    isPlausibleTripAverageSpeed(body.distanceMeters, body.durationSeconds),
  );

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

class TripAlreadyConfirmedError extends Error {}

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

const getVehicleWithAccess = (
  vehicleId: string,
  userId: string,
  roles?: VehicleAccessRole[],
) =>
  prisma.vehicle.findFirst({
    where: {
      id: vehicleId,
      accesses: {
        some: {
          userId,
          ...(roles ? { role: { in: roles } } : {}),
        },
      },
    },
  });

const tripDriverSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} as const;

type PublicTripInput = VehicleTrip & {
  driver: {
    avatarUrl: string | null;
    email: string | null;
    id: string;
    name: string | null;
  };
};

const toPublicVehicle = (vehicle: Vehicle) => ({
  id: vehicle.id,
  plate: vehicle.plate,
  displayName: vehicle.displayName,
  renavam: vehicle.renavam,
  brandModel: vehicle.brandModel,
  manufactureYear: vehicle.manufactureYear,
  modelYear: vehicle.modelYear,
  ownerName: vehicle.ownerName,
  ownerDocumentMasked: vehicle.ownerDocumentMasked,
  currentOdometerKm: vehicle.currentOdometerKm,
  currentOdometerIsEstimated: vehicle.currentOdometerIsEstimated,
  verificationStatus: vehicle.verificationStatus,
  verificationSource: vehicle.verificationSource,
  heroImageOriginalUrl: vehicle.heroImageOriginalUrl,
  heroImageUrl: vehicle.heroImageUrl,
  updatedAt: vehicle.updatedAt.toISOString(),
});

const toPublicTrip = (trip: PublicTripInput) => ({
  id: trip.id,
  vehicleId: trip.vehicleId,
  driverUserId: trip.driverUserId,
  driver: {
    id: trip.driver.id,
    name: trip.driver.name,
    email: trip.driver.email,
    avatarUrl: trip.driver.avatarUrl,
  },
  clientTripId: trip.clientTripId,
  startedAt: trip.startedAt.toISOString(),
  endedAt: trip.endedAt.toISOString(),
  durationSeconds: trip.durationSeconds,
  distanceMeters: trip.distanceMeters,
  averageSpeedKmh: trip.averageSpeedKmh,
  maxSpeedKmh: trip.maxSpeedKmh,
  startLocation: {
    latitude: trip.startLatitude,
    longitude: trip.startLongitude,
  },
  endLocation: {
    latitude: trip.endLatitude,
    longitude: trip.endLongitude,
  },
  routePolyline: trip.routePolyline,
  routeSampleCount: trip.routeSampleCount,
  detectionSource: trip.detectionSource,
  createdAt: trip.createdAt.toISOString(),
  updatedAt: trip.updatedAt.toISOString(),
});

export const registerTripsRoutes = async (app: FastifyInstance) => {
  app.get("/vehicles/:vehicleId/trips", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      const trips = await prisma.vehicleTrip.findMany({
        where: { vehicleId: vehicle.id },
        include: { driver: { select: tripDriverSelect } },
        orderBy: { startedAt: "desc" },
        take: 100,
      });

      return reply.send({
        trips: trips.map(toPublicTrip),
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

      request.log.warn({ error }, "Vehicle trip list failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle trip list failed.",
      });
    }
  });

  app.get("/trips/:tripId", async (request, reply) => {
    const parsedParams = tripIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const trip = await prisma.vehicleTrip.findFirst({
        where: {
          id: parsedParams.data.tripId,
          vehicle: {
            accesses: {
              some: { userId },
            },
          },
        },
        include: { driver: { select: tripDriverSelect } },
      });

      if (!trip) {
        return reply.code(404).send({
          error: "trip_not_found",
          message: "Trip was not found for this user.",
        });
      }

      return reply.send({ trip: toPublicTrip(trip) });
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

      request.log.warn({ error }, "Vehicle trip detail failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle trip detail failed.",
      });
    }
  });

  app.post("/vehicles/:vehicleId/trips", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
    const parsedBody = createTripBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      const { startLocation, endLocation, ...body } = parsedBody.data;
      const result = await prisma.$transaction(async (tx) => {
        const existingTrip = await tx.vehicleTrip.findUnique({
          where: {
            driverUserId_clientTripId: {
              driverUserId: userId,
              clientTripId: body.clientTripId,
            },
          },
          include: { driver: { select: tripDriverSelect } },
        });

        if (existingTrip) {
          if (existingTrip.vehicleId !== vehicle.id) {
            throw new TripAlreadyConfirmedError();
          }

          return {
            created: false,
            trip: existingTrip,
            vehicle,
          };
        }

        const trip = await tx.vehicleTrip.create({
          data: {
            vehicleId: vehicle.id,
            driverUserId: userId,
            clientTripId: body.clientTripId,
            startedAt: body.startedAt,
            endedAt: body.endedAt,
            durationSeconds: body.durationSeconds,
            distanceMeters: body.distanceMeters,
            averageSpeedKmh: body.averageSpeedKmh,
            maxSpeedKmh: body.maxSpeedKmh,
            startLatitude: startLocation.latitude,
            startLongitude: startLocation.longitude,
            endLatitude: endLocation.latitude,
            endLongitude: endLocation.longitude,
            routePolyline: body.routePolyline,
            routeSampleCount: body.routeSampleCount ?? 0,
            detectionSource: body.detectionSource,
          },
          include: { driver: { select: tripDriverSelect } },
        });
        const estimatedOdometerKm = getEstimatedOdometerKm(
          vehicle.currentOdometerKm,
          body.distanceMeters,
        );
        const updatedVehicle =
          estimatedOdometerKm === null
            ? vehicle
            : await tx.vehicle.update({
                where: { id: vehicle.id },
                data: {
                  currentOdometerKm: estimatedOdometerKm,
                  currentOdometerIsEstimated: true,
                },
              });

        return {
          created: true,
          trip,
          vehicle: updatedVehicle,
        };
      });

      return reply.code(result.created ? 201 : 200).send({
        trip: toPublicTrip(result.trip),
        vehicle: toPublicVehicle(result.vehicle),
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

      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({
          error: "trip_already_confirmed",
          message: "Trip was already confirmed.",
        });
      }

      if (error instanceof TripAlreadyConfirmedError) {
        return reply.code(409).send({
          error: "trip_already_confirmed",
          message: "Trip was already confirmed.",
        });
      }

      request.log.warn({ error }, "Vehicle trip creation failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle trip creation failed.",
      });
    }
  });
};
