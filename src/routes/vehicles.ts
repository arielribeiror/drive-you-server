import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import type {
  Vehicle,
  VehicleAccessRole,
  VehicleMaintenanceBaseline,
  VehicleMaintenanceEvent,
} from "@prisma/client";
import { z } from "zod";

import { addDays, createRandomToken, hashToken } from "../auth/crypto.js";
import {
  AuthError,
  getBearerToken,
  verifyAccessToken,
} from "../auth/sessions.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  databaseUnavailablePayload,
  isDatabaseConnectionError,
} from "../errors.js";
import {
  extractLicensingDocumentFromPdf,
  LicensingDocumentParseError,
} from "../vehicles/licensing-document.js";
import {
  BackgroundRemovalError,
  removeVehicleBackground,
} from "../vehicles/background-removal.js";
import { getMaintenanceSchedule } from "../vehicles/maintenance-baseline.js";
import {
  extractOdometerFromImage,
  OdometerImageError,
} from "../vehicles/odometer-image.js";
import { createOilChangeLoggedNotifications } from "../notifications/service.js";
import { calculateMaintenanceHealth } from "../vehicles/maintenance-health.js";
import {
  buildFipeValuation,
  dedupeFipeHistoryByReferenceMonth,
  FIPE_CHART_HISTORY_LIMIT,
  FipeClient,
  FipeClientError,
  fipeVehicleTypeSchema,
  getConfidentAutomaticCandidate,
  isFipeHistoryCacheFresh,
  parseBrazilianPriceToCents,
  priceHistoryFromDetail,
  resolveFipeCandidates,
  toFipeDisplayName,
  type CachedFipePrice,
  type FipeCandidate,
  type FipeLinkSource,
  type FipeValuation,
  type FipeValuationHistoryPoint,
} from "../vehicles/fipe.js";

const MAX_LICENSING_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_VEHICLE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ODOMETER_IMAGE_BYTES = 10 * 1024 * 1024;
const vehicleImageFileNameSchema = z.object({
  fileName: z.string().regex(/^[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/),
});
const vehicleImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

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
  verificationStatus: vehicle.documentConfirmedAt
    ? ("confirmed_by_user" as const)
    : ("unconfirmed" as const),
  verificationSource: vehicle.verificationSource,
  ownershipStatus: vehicle.documentConfirmedAt
    ? ("confirmed_by_user" as const)
    : ("unconfirmed" as const),
  documentConfirmedAt: vehicle.documentConfirmedAt?.toISOString() ?? null,
  heroImageOriginalUrl: vehicle.heroImageOriginalUrl,
  heroImageUrl: vehicle.heroImageUrl,
  fipeVehicleType: vehicle.fipeVehicleType,
  fipeBrandCode: vehicle.fipeBrandCode,
  fipeModelCode: vehicle.fipeModelCode,
  fipeYearId: vehicle.fipeYearId,
  fipeCode: vehicle.fipeCode,
  fipeDisplayName: vehicle.fipeDisplayName,
  fipeLinkSource: vehicle.fipeLinkSource,
  fipeLinkedAt: vehicle.fipeLinkedAt?.toISOString() ?? null,
  updatedAt: vehicle.updatedAt.toISOString(),
});

const toPublicMaintenanceBaseline = (
  baseline: VehicleMaintenanceBaseline,
) => ({
  id: baseline.id,
  vehicleId: baseline.vehicleId,
  item: baseline.item,
  performedAt: baseline.performedAt.toISOString(),
  odometerKm: baseline.odometerKm,
  usageProfile: baseline.usageProfile,
  intervalKm: baseline.intervalKm,
  intervalMonths: baseline.intervalMonths,
  intervalDays: baseline.intervalDays,
  updatedAt: baseline.updatedAt.toISOString(),
});

const toPublicMaintenanceEvent = (event: VehicleMaintenanceEvent) => ({
  id: event.id,
  vehicleId: event.vehicleId,
  item: event.item,
  source: event.source,
  performedAt: event.performedAt.toISOString(),
  odometerKm: event.odometerKm,
  costCents: event.costCents,
  notes: event.notes,
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

const isPdfPart = (part: { filename: string; mimetype: string }) =>
  part.mimetype === "application/pdf" ||
  part.filename.toLowerCase().endsWith(".pdf");

const isVehicleImagePart = (part: { filename: string; mimetype: string }) =>
  vehicleImageMimeTypes.has(part.mimetype) ||
  /\.(jpe?g|png|webp)$/i.test(part.filename);

const hasPdfMagicBytes = (buffer: Buffer) =>
  buffer.subarray(0, 4).toString("utf8") === "%PDF";

const getFileTooLargePayload = () => ({
  error: "licensing_document_too_large",
  message: "Licensing document PDF must be up to 5 MB.",
});

const getVehicleImageTooLargePayload = () => ({
  error: "vehicle_image_too_large",
  message: "Vehicle image must be up to 10 MB.",
});

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const getOdometerImageTooLargePayload = () => ({
  error: "odometer_image_too_large",
  message: "Odometer image must be up to 10 MB.",
});

const getRequestOrigin = (request: FastifyRequest) => {
  const host = request.headers.host;
  const protocol =
    request.headers["x-forwarded-proto"]?.toString().split(",")[0] ??
    request.protocol ??
    "http";

  return host ? `${protocol}://${host}` : "";
};

const getVehicleImageExtension = (mimeType: string, fileName: string) => {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  const extension = path.extname(fileName).replace(".", "").toLowerCase();
  return extension === "png" || extension === "webp" ? extension : "jpg";
};

const getVehicleImageContentType = (fileName: string) => {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "image/jpeg";
};

const vehicleImagePublicUrl = (request: FastifyRequest, fileName: string) =>
  `${getRequestOrigin(request)}/uploads/vehicle-images/${encodeURIComponent(
    fileName,
  )}`;

const vehicleIdParamsSchema = z.object({
  vehicleId: z.string().min(1),
});
const fipeLinkBodySchema = z.object({
  brandCode: z.string().min(1),
  modelCode: z.string().min(1),
  source: z.enum(["confirmed", "manual"]).optional(),
  vehicleType: fipeVehicleTypeSchema,
  yearId: z.string().min(1),
});
const fipeOptionsQuerySchema = z.object({
  brandCode: z.string().min(1).optional(),
  modelCode: z.string().min(1).optional(),
  vehicleType: fipeVehicleTypeSchema.default("cars"),
});

const licensingDocumentVehicleSchema = z.object({
  plate: z.string().min(1),
  renavam: z.string().min(1),
  brandModel: z.string().nullable(),
  manufactureYear: z.number().int().nullable(),
  modelYear: z.number().int().nullable(),
  ownerName: z.string().nullable(),
  ownerDocumentMasked: z.string().nullable(),
});

const licensingDocumentConfirmationBodySchema = z.object({
  document: z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_LICENSING_DOCUMENT_BYTES),
  }),
  existingVehicleResolution: z.enum(["replace"]).optional(),
  extractedVehicle: licensingDocumentVehicleSchema,
});

const updateVehicleBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    currentOdometerKm: z.number().int().min(0).max(2_000_000).optional(),
  })
  .refine(
    (body) =>
      body.displayName !== undefined || body.currentOdometerKm !== undefined,
  );

const acceptShareInviteBodySchema = z.object({
  token: z.string().min(16),
});

const maintenanceBaselineBodySchema = z.object({
  item: z.enum([
    "engine_oil",
    "tires",
    "suspension",
    "brake_fluid",
    "brake_disc",
    "brake_pads",
    "tire_pressure",
  ]),
  performedAt: z
    .string()
    .min(1)
    .transform((value) => new Date(value))
    .refine((value) => !Number.isNaN(value.getTime()))
    .refine((value) => value.getTime() <= Date.now()),
  odometerKm: z.number().int().min(0).max(2_000_000),
  intervalKm: z.number().int().min(1).max(2_000_000).optional(),
  intervalMonths: z.number().int().min(1).max(600).optional(),
  source: z.enum(["onboarding", "manual", "baseline_update"]).optional(),
  usageProfile: z.enum(["severe", "light"]).optional(),
});

const maintenanceEventBodySchema = z.object({
  item: z.enum([
    "engine_oil",
    "tires",
    "suspension",
    "brake_fluid",
    "brake_disc",
    "brake_pads",
    "tire_pressure",
  ]),
  performedAt: z
    .string()
    .min(1)
    .transform((value) => new Date(value))
    .refine((value) => !Number.isNaN(value.getTime()))
    .refine((value) => value.getTime() <= Date.now()),
  odometerKm: z.number().int().min(0).max(2_000_000),
  intervalKm: z.number().int().min(1).max(2_000_000).optional(),
  intervalMonths: z.number().int().min(1).max(600).optional(),
  costCents: z.number().int().min(0).max(100_000_000).optional(),
  notes: z.string().trim().max(500).optional(),
  usageProfile: z.enum(["severe", "light"]).optional(),
});

const validationError = () => ({
  error: "invalid_request",
  message: "Request data is invalid.",
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

const hasFipeLink = (vehicle: Vehicle) =>
  Boolean(vehicle.fipeVehicleType && vehicle.fipeCode && vehicle.fipeYearId);

const toPublicFipeLink = (vehicle: Vehicle) => {
  if (!hasFipeLink(vehicle)) {
    return null;
  }

  return {
    brandCode: vehicle.fipeBrandCode,
    codeFipe: vehicle.fipeCode,
    displayName: vehicle.fipeDisplayName,
    linkedAt: vehicle.fipeLinkedAt?.toISOString() ?? null,
    modelCode: vehicle.fipeModelCode,
    source: vehicle.fipeLinkSource,
    vehicleType: vehicle.fipeVehicleType,
    yearId: vehicle.fipeYearId,
  };
};

const toPublicFipeCandidate = (candidate: FipeCandidate) => ({
  brandCode: candidate.brandCode,
  brandName: candidate.brandName,
  codeFipe: candidate.codeFipe,
  confidence: candidate.confidence,
  displayName: candidate.displayName,
  modelCode: candidate.modelCode,
  modelName: candidate.modelName,
  modelYear: candidate.modelYear,
  priceCents: candidate.priceCents,
  score: candidate.score,
  vehicleType: candidate.vehicleType,
  yearId: candidate.yearId,
  yearName: candidate.yearName,
});

const toCachedFipePrice = (price: {
  fetchedAt: Date;
  priceCents: number;
  referenceCode: string;
  referenceMonth: string;
}): CachedFipePrice => ({
  fetchedAt: price.fetchedAt,
  priceCents: price.priceCents,
  referenceCode: price.referenceCode,
  referenceMonth: price.referenceMonth,
});

const getFipeErrorPayload = (error: FipeClientError) => {
  if (error.code === "rate_limited") {
    return {
      error: "fipe_rate_limited",
      message: "FIPE API rate limit reached.",
      status: 429,
    };
  }

  if (error.code === "not_found") {
    return {
      error: "invalid_fipe_link",
      message: "FIPE vehicle was not found.",
      status: 422,
    };
  }

  return {
    error: "fipe_unavailable",
    message: "FIPE API is unavailable.",
    status: 502,
  };
};

const getCachedVehicleFipePrices = (
  vehicleId: string,
  fipeCode: string,
  yearId: string,
) =>
  prisma.vehicleFipePrice.findMany({
    orderBy: [{ fetchedAt: "asc" }, { referenceCode: "asc" }],
    where: {
      fipeCode,
      vehicleId,
      yearId,
    },
  });

const cacheVehicleFipePrices = async ({
  fipeCode,
  history,
  vehicleId,
  yearId,
}: {
  readonly fipeCode: string;
  readonly history: FipeValuationHistoryPoint[];
  readonly vehicleId: string;
  readonly yearId: string;
}) => {
  const fetchedAt = new Date();
  const dedupedHistory = dedupeFipeHistoryByReferenceMonth(history);
  const shouldDeleteFallbackReference = dedupedHistory.some(
    (point) => point.referenceCode !== "0",
  );
  const cacheHistory = shouldDeleteFallbackReference
    ? dedupedHistory.filter((point) => point.referenceCode !== "0")
    : dedupedHistory;

  if (cacheHistory.length === 0) {
    return [];
  }

  await prisma.$transaction(
    [
      ...cacheHistory.map((point) =>
        prisma.vehicleFipePrice.upsert({
          where: {
            vehicleId_fipeCode_yearId_referenceCode: {
              fipeCode,
              referenceCode: point.referenceCode,
              vehicleId,
              yearId,
            },
          },
          create: {
            fetchedAt,
            fipeCode,
            priceCents: point.priceCents,
            referenceCode: point.referenceCode,
            referenceMonth: point.referenceMonth,
            vehicleId,
            yearId,
          },
          update: {
            fetchedAt,
            priceCents: point.priceCents,
            referenceMonth: point.referenceMonth,
          },
        }),
      ),
      ...(shouldDeleteFallbackReference
        ? [
            prisma.vehicleFipePrice.deleteMany({
              where: {
                fipeCode,
                referenceCode: "0",
                vehicleId,
                yearId,
              },
            }),
          ]
        : []),
    ],
  );

  return cacheHistory.map((point) => ({
    ...point,
    fetchedAt,
  }));
};

const sortReferencesDescending = <
  Reference extends { readonly code: string },
>(
  references: readonly Reference[],
) =>
  [...references].sort((left, right) => {
    const leftCode = Number(left.code);
    const rightCode = Number(right.code);

    if (Number.isFinite(leftCode) && Number.isFinite(rightCode)) {
      return rightCode - leftCode;
    }

    return right.code.localeCompare(left.code);
  });

const mergeFipeHistory = (
  ...histories: readonly FipeValuationHistoryPoint[][]
) => {
  const pointsByReference = new Map<string, FipeValuationHistoryPoint>();

  for (const point of dedupeFipeHistoryByReferenceMonth(histories.flat())) {
    pointsByReference.set(point.referenceCode, point);
  }

  return [...pointsByReference.values()];
};

const getRecentReferenceFipeHistory = async ({
  fipeClient,
  fipeCode,
  vehicleType,
  yearId,
}: {
  readonly fipeClient: FipeClient;
  readonly fipeCode: string;
  readonly vehicleType: NonNullable<Vehicle["fipeVehicleType"]>;
  readonly yearId: string;
}) => {
  const references = sortReferencesDescending(
    await fipeClient.getReferences(),
  ).slice(0, FIPE_CHART_HISTORY_LIMIT);
  const history: FipeValuationHistoryPoint[] = [];

  for (const reference of references) {
    try {
      const detail = await fipeClient.getVehicleDetailByFipeCode(
        vehicleType,
        fipeCode,
        yearId,
        reference.code,
      );

      history.push({
        priceCents: parseBrazilianPriceToCents(detail.price),
        referenceCode: reference.code,
        referenceMonth: detail.referenceMonth || reference.month,
      });
    } catch (error) {
      if (error instanceof FipeClientError && error.code === "not_found") {
        continue;
      }

      if (
        error instanceof FipeClientError &&
        error.code === "payment_required"
      ) {
        break;
      }

      throw error;
    }
  }

  return history;
};

const getFipeHistoryForLink = async ({
  fallbackHistory,
  fipeClient,
  fipeCode,
  vehicleType,
  yearId,
}: {
  readonly fallbackHistory: FipeValuationHistoryPoint[];
  readonly fipeClient: FipeClient;
  readonly fipeCode: string;
  readonly vehicleType: NonNullable<Vehicle["fipeVehicleType"]>;
  readonly yearId: string;
}) => {
  const fallbackDedupedHistory =
    dedupeFipeHistoryByReferenceMonth(fallbackHistory);

  if (fallbackDedupedHistory.length >= FIPE_CHART_HISTORY_LIMIT) {
    return fallbackDedupedHistory;
  }

  let history = fallbackDedupedHistory;

  try {
    const detail = await fipeClient.getVehicleHistoryByFipeCode(
      vehicleType,
      fipeCode,
      yearId,
    );

    history = mergeFipeHistory(history, priceHistoryFromDetail(detail));
  } catch (error) {
    if (!(error instanceof FipeClientError)) {
      throw error;
    }
  }

  if (
    dedupeFipeHistoryByReferenceMonth(history).length >=
    FIPE_CHART_HISTORY_LIMIT
  ) {
    return history;
  }

  try {
    return mergeFipeHistory(
      history,
      await getRecentReferenceFipeHistory({
        fipeClient,
        fipeCode,
        vehicleType,
        yearId,
      }),
    );
  } catch (error) {
    if (error instanceof FipeClientError) {
      return history;
    }

    throw error;
  }
};

const getLinkedFipeValuation = async (
  fipeClient: FipeClient,
  vehicle: Vehicle,
): Promise<{ stale: boolean; valuation: FipeValuation | null }> => {
  if (!vehicle.fipeVehicleType || !vehicle.fipeCode || !vehicle.fipeYearId) {
    return { stale: false, valuation: null };
  }

  const cachedPrices = (
    await getCachedVehicleFipePrices(
      vehicle.id,
      vehicle.fipeCode,
      vehicle.fipeYearId,
    )
  ).map(toCachedFipePrice);

  if (isFipeHistoryCacheFresh(cachedPrices)) {
    return {
      stale: false,
      valuation: buildFipeValuation(cachedPrices),
    };
  }

  try {
    const history = await getFipeHistoryForLink({
      fallbackHistory: cachedPrices,
      fipeClient,
      fipeCode: vehicle.fipeCode,
      vehicleType: vehicle.fipeVehicleType,
      yearId: vehicle.fipeYearId,
    });
    const freshPrices = await cacheVehicleFipePrices({
      fipeCode: vehicle.fipeCode,
      history,
      vehicleId: vehicle.id,
      yearId: vehicle.fipeYearId,
    });

    return {
      stale: false,
      valuation: buildFipeValuation(freshPrices),
    };
  } catch (error) {
    const staleValuation = buildFipeValuation(cachedPrices);

    if (staleValuation) {
      return {
        stale: true,
        valuation: staleValuation,
      };
    }

    throw error;
  }
};

const applyFipeCandidateLink = (
  vehicleId: string,
  candidate: FipeCandidate,
  source: FipeLinkSource,
) =>
  prisma.vehicle.update({
    where: { id: vehicleId },
    data: {
      fipeBrandCode: candidate.brandCode,
      fipeCode: candidate.codeFipe,
      fipeDisplayName: candidate.displayName,
      fipeLinkedAt: new Date(),
      fipeLinkSource: source,
      fipeModelCode: candidate.modelCode,
      fipeVehicleType: candidate.vehicleType,
      fipeYearId: candidate.yearId,
    },
  });

const getFipeResponseForVehicle = async (
  fipeClient: FipeClient,
  vehicle: Vehicle,
) => {
  if (hasFipeLink(vehicle)) {
    const { stale, valuation } = await getLinkedFipeValuation(
      fipeClient,
      vehicle,
    );

    return {
      candidates: [],
      error: null,
      link: toPublicFipeLink(vehicle),
      stale,
      status: valuation ? "linked" : "unavailable",
      valuation,
      vehicle,
    };
  }

  const candidates = await resolveFipeCandidates(fipeClient, {
    brandModel: vehicle.brandModel,
    manufactureYear: vehicle.manufactureYear,
    modelYear: vehicle.modelYear,
  });
  const automaticCandidate = getConfidentAutomaticCandidate(candidates);

  if (automaticCandidate) {
    const linkedVehicle = await applyFipeCandidateLink(
      vehicle.id,
      automaticCandidate,
      "automatic",
    );
    const history = await getFipeHistoryForLink({
      fallbackHistory: automaticCandidate.history,
      fipeClient,
      fipeCode: automaticCandidate.codeFipe,
      vehicleType: automaticCandidate.vehicleType,
      yearId: automaticCandidate.yearId,
    });
    const freshPrices = await cacheVehicleFipePrices({
      fipeCode: automaticCandidate.codeFipe,
      history,
      vehicleId: linkedVehicle.id,
      yearId: automaticCandidate.yearId,
    });
    const valuation = buildFipeValuation(freshPrices);

    return {
      candidates: [],
      error: null,
      link: toPublicFipeLink(linkedVehicle),
      stale: false,
      status: valuation ? "linked" : "unavailable",
      valuation,
      vehicle: linkedVehicle,
    };
  }

  return {
    candidates: candidates.map(toPublicFipeCandidate),
    error: null,
    link: null,
    stale: false,
    status: candidates.length > 0 ? "needs_confirmation" : "needs_link",
    valuation: null,
    vehicle,
  };
};

export const registerVehiclesRoutes = async (app: FastifyInstance) => {
  const fipeClient = new FipeClient({
    baseUrl: config.fipeApiBaseUrl,
    timeoutMs: config.fipeTimeoutMs,
    token: config.fipeSubscriptionToken,
  });

  app.get("/uploads/vehicle-images/:fileName", async (request, reply) => {
    const parsedParams = vehicleImageFileNameSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(404).send({
        error: "vehicle_image_not_found",
        message: "Vehicle image was not found.",
      });
    }

    try {
      const filePath = path.join(
        process.cwd(),
        config.vehicleImagesUploadDir,
        parsedParams.data.fileName,
      );
      const file = await readFile(filePath);

      return reply
        .type(getVehicleImageContentType(parsedParams.data.fileName))
        .send(file);
    } catch {
      return reply.code(404).send({
        error: "vehicle_image_not_found",
        message: "Vehicle image was not found.",
      });
    }
  });

  app.get("/vehicles", async (request, reply) => {
    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicles = await prisma.vehicle.findMany({
        where: {
          OR: [
            {
              accesses: {
                some: {
                  userId,
                },
              },
            },
            { userId },
          ],
        },
        include: {
          accesses: {
            where: {
              userId,
            },
            select: {
              role: true,
            },
            take: 1,
          },
        },
        orderBy: [{ updatedAt: "desc" }, { plate: "asc" }],
      });

      return reply.send({
        vehicles: vehicles.map(({ accesses, ...vehicle }) => ({
          ...toPublicVehicle(vehicle),
          accessRole:
            accesses[0]?.role ?? (vehicle.userId === userId ? "owner" : "shared"),
        })),
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle list fetch.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Vehicle list fetch failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle list fetch failed.",
      });
    }
  });

  app.patch("/vehicles/:vehicleId", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
    const parsedBody = updateVehicleBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
        ["owner"],
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      const updateData: {
        currentOdometerIsEstimated?: boolean;
        currentOdometerKm?: number;
        displayName?: string;
      } = {};

      if (parsedBody.data.displayName !== undefined) {
        updateData.displayName = parsedBody.data.displayName;
      }

      if (parsedBody.data.currentOdometerKm !== undefined) {
        updateData.currentOdometerKm = parsedBody.data.currentOdometerKm;
        updateData.currentOdometerIsEstimated = false;
      }

      const updatedVehicle = await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: updateData,
      });

      return reply.send({ vehicle: toPublicVehicle(updatedVehicle) });
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

      request.log.warn({ error }, "Vehicle update failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle update failed.",
      });
    }
  });

  app.delete("/vehicles/:vehicleId", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
        ["owner"],
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      await prisma.vehicle.delete({ where: { id: vehicle.id } });
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

      request.log.warn({ error }, "Vehicle deletion failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle deletion failed.",
      });
    }
  });

  app.post("/vehicles/licensing-document", async (request, reply) => {
    try {
      const userId = await getAuthenticatedUserId(request);

      const document = await request.file({
        limits: {
          fileSize: MAX_LICENSING_DOCUMENT_BYTES,
          files: 1,
        },
      });

      if (!document) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A licensing document PDF is required.",
        });
      }

      if (!isPdfPart(document)) {
        return reply.code(415).send({
          error: "invalid_licensing_document",
          message: "Licensing document must be a PDF.",
        });
      }

      const buffer = await document.toBuffer();

      if (!hasPdfMagicBytes(buffer)) {
        return reply.code(415).send({
          error: "invalid_licensing_document",
          message: "Licensing document must be a valid PDF.",
        });
      }

      const parsedDocument = await extractLicensingDocumentFromPdf(buffer);

      if (!parsedDocument.plate || !parsedDocument.renavam) {
        return reply.code(422).send({
          error: "unable_to_read_vehicle_document",
          message: "Could not find required vehicle identity fields in this PDF.",
          missingFields: parsedDocument.missingFields,
        });
      }

      const plate = parsedDocument.plate;
      const renavam = parsedDocument.renavam;
      const documentHash = createHash("sha256").update(buffer).digest("hex");
      const extractedVehicle = {
        plate,
        renavam,
        brandModel: parsedDocument.brandModel,
        manufactureYear: parsedDocument.manufactureYear,
        modelYear: parsedDocument.modelYear,
        ownerName: parsedDocument.ownerName,
        ownerDocumentMasked: parsedDocument.ownerDocumentMasked,
      };
      const existingVehicle = await prisma.vehicle.findFirst({
        where: {
          userId,
          renavam,
        },
      });
      const documentData = {
        hash: documentHash,
        fileName: document.filename,
        mimeType: document.mimetype,
        sizeBytes: buffer.length,
      };
      const extraction = {
        confidence: parsedDocument.confidence,
        missingFields: parsedDocument.missingFields,
      };

      if (existingVehicle) {
        return reply.code(200).send({
          status: "existing_vehicle",
          vehicle: toPublicVehicle(existingVehicle),
          extractedVehicle,
          document: documentData,
          existingVehicleMatch: {
            renavamMatches: true,
            plateMatches: existingVehicle.plate === plate,
            existingPlate: existingVehicle.plate,
            extractedPlate: plate,
            existingRenavam: existingVehicle.renavam,
            extractedRenavam: renavam,
            canReplace: existingVehicle.plate !== plate,
          },
          extraction,
        });
      }

      return reply.code(200).send({
        status: "ready_for_confirmation",
        extractedVehicle,
        document: documentData,
        extraction,
      });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send(getFileTooLargePayload());
      }

      if (error instanceof LicensingDocumentParseError) {
        return reply.code(422).send({
          error: "unable_to_read_vehicle_document",
          message: error.message,
        });
      }

      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle document upload.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      if (isUniqueConstraintError(error)) {
        request.log.warn(
          { error },
          "Vehicle document matched an existing vehicle constraint.",
        );
        return reply.code(409).send({
          error: "vehicle_already_exists",
          message: "Vehicle already exists for this user.",
        });
      }

      request.log.warn({ error }, "Vehicle licensing document upload failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle licensing document upload failed.",
      });
    }
  });

  app.post("/vehicles/licensing-document/confirm", async (request, reply) => {
    const parsedBody = licensingDocumentConfirmationBodySchema.safeParse(
      request.body,
    );

    if (!parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const { document, existingVehicleResolution, extractedVehicle } =
        parsedBody.data;
      const existingVehicle = await prisma.vehicle.findFirst({
        where: {
          userId,
          renavam: extractedVehicle.renavam,
        },
      });

      if (existingVehicle && existingVehicleResolution !== "replace") {
        const confirmedVehicle = await prisma.$transaction(async (tx) => {
          const updatedVehicle = await tx.vehicle.update({
            where: { id: existingVehicle.id },
            data: {
              documentConfirmedAt: new Date(),
              documentConfirmedByUserId: userId,
            },
          });

          await tx.vehicleAccess.upsert({
            where: {
              userId_vehicleId: {
                userId,
                vehicleId: existingVehicle.id,
              },
            },
            create: {
              userId,
              vehicleId: existingVehicle.id,
              role: "owner",
            },
            update: {
              role: "owner",
            },
          });

          return updatedVehicle;
        });

        return reply.code(200).send({
          status: "existing_vehicle",
          vehicle: toPublicVehicle(confirmedVehicle),
          extractedVehicle,
          document,
          existingVehicleMatch: {
            renavamMatches: true,
            plateMatches: existingVehicle.plate === extractedVehicle.plate,
            existingPlate: existingVehicle.plate,
            extractedPlate: extractedVehicle.plate,
            existingRenavam: existingVehicle.renavam,
            extractedRenavam: extractedVehicle.renavam,
            canReplace: existingVehicle.plate !== extractedVehicle.plate,
          },
        });
      }

      const vehicleData = {
        ...extractedVehicle,
        verificationSource: "licensing_pdf" as const,
        documentHash: document.hash,
        documentFileName: document.fileName,
        documentMimeType: document.mimeType,
        documentSizeBytes: document.sizeBytes,
        documentConfirmedAt: new Date(),
        documentConfirmedByUserId: userId,
      };
      const vehicle = await prisma.$transaction(async (tx) => {
        const upsertedVehicle = existingVehicle
          ? await tx.vehicle.update({
              where: { id: existingVehicle.id },
              data: vehicleData,
            })
          : await tx.vehicle.create({
              data: {
                userId,
                ...vehicleData,
              },
            });

        await tx.vehicleAccess.upsert({
          where: {
            userId_vehicleId: {
              userId,
              vehicleId: upsertedVehicle.id,
            },
          },
          create: {
            userId,
            vehicleId: upsertedVehicle.id,
            role: "owner",
          },
          update: {
            role: "owner",
          },
        });

        return upsertedVehicle;
      });

      return reply.code(existingVehicle ? 200 : 201).send({
        status: existingVehicle ? "updated_existing_vehicle" : "created_vehicle",
        vehicle: toPublicVehicle(vehicle),
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle document confirmation.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      if (isUniqueConstraintError(error)) {
        request.log.warn(
          { error },
          "Vehicle document confirmation matched an existing vehicle constraint.",
        );
        return reply.code(409).send({
          error: "vehicle_already_exists",
          message: "Vehicle already exists for this user.",
        });
      }

      request.log.warn({ error }, "Vehicle document confirmation failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle document confirmation failed.",
      });
    }
  });

  app.post("/vehicles/:vehicleId/hero-image", async (request, reply) => {
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

      const image = await request.file({
        limits: {
          fileSize: MAX_VEHICLE_IMAGE_BYTES,
          files: 1,
        },
      });

      if (!image) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A vehicle image is required.",
        });
      }

      if (!isVehicleImagePart(image)) {
        return reply.code(415).send({
          error: "invalid_vehicle_image",
          message: "Vehicle image must be a JPG, PNG, or WebP file.",
        });
      }

      const imageBuffer = await image.toBuffer();
      const transparentImageBuffer = await removeVehicleBackground({
        buffer: imageBuffer,
        command: config.rembgCommand,
        fileName: image.filename,
        mimeType: image.mimetype,
        model: config.rembgModel,
        timeoutMs: config.rembgTimeoutMs,
      });
      const uploadDir = path.join(
        process.cwd(),
        config.vehicleImagesUploadDir,
      );
      await mkdir(uploadDir, { recursive: true });

      const imageToken = createRandomToken(12);
      const originalExtension = getVehicleImageExtension(
        image.mimetype,
        image.filename,
      );
      const originalFileName = `${vehicle.id}-${imageToken}-original.${originalExtension}`;
      const transparentFileName = `${vehicle.id}-${imageToken}-hero.png`;

      await writeFile(path.join(uploadDir, originalFileName), imageBuffer);
      await writeFile(
        path.join(uploadDir, transparentFileName),
        transparentImageBuffer,
      );

      const updatedVehicle = await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: {
          heroImageOriginalUrl: vehicleImagePublicUrl(
            request,
            originalFileName,
          ),
          heroImageUrl: vehicleImagePublicUrl(request, transparentFileName),
          heroImageMimeType: "image/png",
          heroImageSizeBytes: transparentImageBuffer.length,
        },
      });

      return reply.code(201).send({
        vehicle: toPublicVehicle(updatedVehicle),
      });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send(getVehicleImageTooLargePayload());
      }

      if (error instanceof BackgroundRemovalError) {
        request.log.warn({ error }, "Vehicle background removal failed.");
        return reply.code(error.status === 401 ? 502 : error.status).send({
          error:
            error.code === "not_configured"
              ? "remove_bg_not_configured"
              : "vehicle_background_removal_failed",
          message:
            error.code === "not_configured"
              ? "Background removal is not configured on the server."
              : "Vehicle image background removal failed.",
        });
      }

      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle hero image upload.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Vehicle hero image upload failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle hero image upload failed.",
      });
    }
  });

  app.post(
    "/vehicles/:vehicleId/current-odometer/image",
    async (request, reply) => {
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

        const image = await request.file({
          limits: {
            fileSize: MAX_ODOMETER_IMAGE_BYTES,
            files: 1,
          },
        });

        if (!image) {
          return reply.code(400).send({
            error: "invalid_request",
            message: "An odometer image is required.",
          });
        }

        if (!isVehicleImagePart(image)) {
          return reply.code(415).send({
            error: "invalid_odometer_image",
            message: "Odometer image must be a JPG, PNG, or WebP file.",
          });
        }

        const imageBuffer = await image.toBuffer();
        const imageMimeType = vehicleImageMimeTypes.has(image.mimetype)
          ? image.mimetype
          : getVehicleImageContentType(image.filename);
        const reading = await extractOdometerFromImage({
          apiKey: config.openaiApiKey,
          buffer: imageBuffer,
          fileName: image.filename,
          mimeType: imageMimeType,
          model: config.odometerReadingModel,
        });
        const updatedVehicle = await prisma.vehicle.update({
          where: { id: vehicle.id },
          data: {
            currentOdometerKm: reading.odometerKm,
            currentOdometerIsEstimated: false,
          },
        });

        return reply.code(201).send({
          vehicle: toPublicVehicle(updatedVehicle),
          odometerReading: reading,
        });
      } catch (error) {
        if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
          return reply.code(413).send(getOdometerImageTooLargePayload());
        }

        if (error instanceof OdometerImageError) {
          if (error.code === "not_configured") {
            return reply.code(501).send({
              error: "odometer_ocr_not_configured",
              message: "Odometer image reading is not configured.",
            });
          }

          if (error.code === "unable_to_read") {
            return reply.code(422).send({
              error: "unable_to_read_odometer",
              message: "Could not read the odometer from this image.",
            });
          }

          request.log.warn({ error }, "Odometer image reading failed.");
          return reply.code(502).send({
            error: "odometer_ocr_failed",
            message: "Odometer image reading failed.",
          });
        }

        if (isDatabaseConnectionError(error)) {
          request.log.warn(
            { error },
            "Database unavailable during vehicle odometer image upload.",
          );
          return reply.code(503).send(databaseUnavailablePayload);
        }

        if (error instanceof AuthError) {
          return reply.code(401).send({
            error: "invalid_access_token",
            message: "Access token is invalid or expired.",
          });
        }

        request.log.warn({ error }, "Vehicle odometer image upload failed.");
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle odometer image upload failed.",
        });
      }
    },
  );

  app.get("/vehicles/:vehicleId/fipe", async (request, reply) => {
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

      try {
        const response = await getFipeResponseForVehicle(fipeClient, vehicle);

        return reply.send({
          candidates: response.candidates,
          error: response.error,
          link: response.link,
          stale: response.stale,
          status: response.status,
          valuation: response.valuation,
          vehicle: toPublicVehicle(response.vehicle),
        });
      } catch (error) {
        if (error instanceof FipeClientError) {
          request.log.warn(
            { error, vehicleId: vehicle.id },
            "Vehicle FIPE fetch failed.",
          );
          return reply.send({
            candidates: [],
            error: getFipeErrorPayload(error).error,
            link: toPublicFipeLink(vehicle),
            stale: false,
            status: "unavailable",
            valuation: null,
            vehicle: toPublicVehicle(vehicle),
          });
        }

        throw error;
      }
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

      request.log.warn({ error }, "Vehicle FIPE fetch failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle FIPE fetch failed.",
      });
    }
  });

  app.get("/vehicles/:vehicleId/fipe/options", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
    const parsedQuery = fipeOptionsQuerySchema.safeParse(request.query);

    if (!parsedParams.success || !parsedQuery.success) {
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

      const { brandCode, modelCode, vehicleType } = parsedQuery.data;

      if (!brandCode) {
        const brands = await fipeClient.getBrands(vehicleType);

        return reply.send({ brands, vehicleType });
      }

      if (!modelCode) {
        const models = await fipeClient.getModels(vehicleType, brandCode);

        return reply.send({ brandCode, models, vehicleType });
      }

      const years = await fipeClient.getYearsByModel(
        vehicleType,
        brandCode,
        modelCode,
      );

      return reply.send({ brandCode, modelCode, vehicleType, years });
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

      if (error instanceof FipeClientError) {
        const payload = getFipeErrorPayload(error);
        return reply.code(payload.status).send({
          error: payload.error,
          message: payload.message,
        });
      }

      request.log.warn({ error }, "Vehicle FIPE options fetch failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle FIPE options fetch failed.",
      });
    }
  });

  app.put("/vehicles/:vehicleId/fipe-link", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
    const parsedBody = fipeLinkBodySchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
        ["owner"],
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      const { brandCode, modelCode, source, vehicleType, yearId } =
        parsedBody.data;
      const detail = await fipeClient.getVehicleDetailByModel(
        vehicleType,
        brandCode,
        modelCode,
        yearId,
      );
      const updatedVehicle = await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: {
          fipeBrandCode: brandCode,
          fipeCode: detail.codeFipe,
          fipeDisplayName: toFipeDisplayName(detail),
          fipeLinkedAt: new Date(),
          fipeLinkSource: source ?? "manual",
          fipeModelCode: modelCode,
          fipeVehicleType: vehicleType,
          fipeYearId: yearId,
        },
      });
      const history = await getFipeHistoryForLink({
        fallbackHistory: priceHistoryFromDetail(detail),
        fipeClient,
        fipeCode: detail.codeFipe,
        vehicleType,
        yearId,
      });

      const freshPrices = await cacheVehicleFipePrices({
        fipeCode: detail.codeFipe,
        history,
        vehicleId: updatedVehicle.id,
        yearId,
      });
      const valuation = buildFipeValuation(freshPrices);

      return reply.send({
        fipe: {
          candidates: [],
          error: null,
          link: toPublicFipeLink(updatedVehicle),
          stale: false,
          status: valuation ? "linked" : "unavailable",
          valuation,
          vehicle: toPublicVehicle(updatedVehicle),
        },
        vehicle: toPublicVehicle(updatedVehicle),
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

      if (error instanceof FipeClientError) {
        const payload = getFipeErrorPayload(error);
        return reply.code(payload.status).send({
          error: payload.error,
          message: payload.message,
        });
      }

      request.log.warn({ error }, "Vehicle FIPE link update failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle FIPE link update failed.",
      });
    }
  });

  app.get(
    "/vehicles/:vehicleId/maintenance-baselines",
    async (request, reply) => {
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

        const maintenanceBaselines =
          await prisma.vehicleMaintenanceBaseline.findMany({
            where: { vehicleId: vehicle.id },
            orderBy: { item: "asc" },
          });

        return reply.send({
          maintenanceBaselines: maintenanceBaselines.map(
            toPublicMaintenanceBaseline,
          ),
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

        request.log.warn(
          { error },
          "Vehicle maintenance baseline list failed.",
        );
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle maintenance baseline list failed.",
        });
      }
    },
  );

  app.post(
    "/vehicles/:vehicleId/maintenance-baselines",
    async (request, reply) => {
      const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
      const parsedBody = maintenanceBaselineBodySchema.safeParse(request.body);

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

        const usageProfile =
          parsedBody.data.usageProfile ??
          (parsedBody.data.item === "engine_oil" ? "severe" : undefined);
        const schedule = getMaintenanceSchedule(
          parsedBody.data.item,
          usageProfile,
        );
        const intervalKm = parsedBody.data.intervalKm ?? schedule.intervalKm;
        const intervalMonths =
          parsedBody.data.intervalMonths ?? schedule.intervalMonths;
        const baseline = await prisma.$transaction(async (tx) => {
          const nextBaseline = await tx.vehicleMaintenanceBaseline.upsert({
            where: {
              vehicleId_item: {
                vehicleId: vehicle.id,
                item: parsedBody.data.item,
              },
            },
            create: {
              userId,
              vehicleId: vehicle.id,
              item: parsedBody.data.item,
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
              usageProfile,
              intervalKm,
              intervalMonths,
              intervalDays: schedule.intervalDays,
            },
            update: {
              userId,
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
              usageProfile,
              intervalKm,
              intervalMonths,
              intervalDays: schedule.intervalDays,
            },
          });

          await tx.vehicleMaintenanceEvent.create({
            data: {
              userId,
              vehicleId: vehicle.id,
              item: parsedBody.data.item,
              source: parsedBody.data.source ?? "baseline_update",
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
            },
          });

          return nextBaseline;
        });

        if (baseline.item === "engine_oil") {
          await createOilChangeLoggedNotifications({
            baseline,
            vehicleId: vehicle.id,
          }).catch((error) => {
            request.log.warn(
              { error },
              "Oil change notification creation failed.",
            );
          });
        }

        return reply.code(201).send({
          maintenanceBaseline: toPublicMaintenanceBaseline(baseline),
        });
      } catch (error) {
        if (isDatabaseConnectionError(error)) {
          request.log.warn(
            { error },
            "Database unavailable during vehicle maintenance baseline upsert.",
          );
          return reply.code(503).send(databaseUnavailablePayload);
        }

        if (error instanceof AuthError) {
          return reply.code(401).send({
            error: "invalid_access_token",
            message: "Access token is invalid or expired.",
          });
        }

        request.log.warn(
          { error },
          "Vehicle maintenance baseline upsert failed.",
        );
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle maintenance baseline upsert failed.",
        });
      }
    },
  );

  app.get(
    "/vehicles/:vehicleId/maintenance-events",
    async (request, reply) => {
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

        const maintenanceEvents = await prisma.vehicleMaintenanceEvent.findMany({
          where: { vehicleId: vehicle.id },
          orderBy: [{ performedAt: "desc" }, { createdAt: "desc" }],
          take: 200,
        });

        return reply.send({
          maintenanceEvents: maintenanceEvents.map(toPublicMaintenanceEvent),
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

        request.log.warn({ error }, "Vehicle maintenance event list failed.");
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle maintenance event list failed.",
        });
      }
    },
  );

  app.post(
    "/vehicles/:vehicleId/maintenance-events",
    async (request, reply) => {
      const parsedParams = vehicleIdParamsSchema.safeParse(request.params);
      const parsedBody = maintenanceEventBodySchema.safeParse(request.body);

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

        const usageProfile =
          parsedBody.data.usageProfile ??
          (parsedBody.data.item === "engine_oil" ? "severe" : undefined);
        const schedule = getMaintenanceSchedule(
          parsedBody.data.item,
          usageProfile,
        );
        const intervalKm = parsedBody.data.intervalKm ?? schedule.intervalKm;
        const intervalMonths =
          parsedBody.data.intervalMonths ?? schedule.intervalMonths;
        const result = await prisma.$transaction(async (tx) => {
          const maintenanceEvent = await tx.vehicleMaintenanceEvent.create({
            data: {
              userId,
              vehicleId: vehicle.id,
              item: parsedBody.data.item,
              source: "manual",
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
              costCents: parsedBody.data.costCents,
              notes: parsedBody.data.notes,
            },
          });
          const maintenanceBaseline = await tx.vehicleMaintenanceBaseline.upsert({
            where: {
              vehicleId_item: {
                vehicleId: vehicle.id,
                item: parsedBody.data.item,
              },
            },
            create: {
              userId,
              vehicleId: vehicle.id,
              item: parsedBody.data.item,
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
              usageProfile,
              intervalKm,
              intervalMonths,
              intervalDays: schedule.intervalDays,
            },
            update: {
              userId,
              performedAt: parsedBody.data.performedAt,
              odometerKm: parsedBody.data.odometerKm,
              usageProfile,
              intervalKm,
              intervalMonths,
              intervalDays: schedule.intervalDays,
            },
          });

          return { maintenanceBaseline, maintenanceEvent };
        });

        if (result.maintenanceBaseline.item === "engine_oil") {
          await createOilChangeLoggedNotifications({
            baseline: result.maintenanceBaseline,
            vehicleId: vehicle.id,
          }).catch((error) => {
            request.log.warn(
              { error },
              "Oil change notification creation failed.",
            );
          });
        }

        return reply.code(201).send({
          maintenanceBaseline: toPublicMaintenanceBaseline(
            result.maintenanceBaseline,
          ),
          maintenanceEvent: toPublicMaintenanceEvent(result.maintenanceEvent),
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

        request.log.warn({ error }, "Vehicle maintenance event creation failed.");
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle maintenance event creation failed.",
        });
      }
    },
  );

  app.get(
    "/vehicles/:vehicleId/maintenance-health",
    async (request, reply) => {
      const parsedParams = vehicleIdParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send(validationError());
      }

      try {
        const userId = await getAuthenticatedUserId(request);
        const vehicle = await prisma.vehicle.findFirst({
          where: {
            id: parsedParams.data.vehicleId,
            accesses: {
              some: {
                userId,
              },
            },
          },
          include: {
            maintenanceBaselines: true,
            trips: {
              orderBy: { startedAt: "desc" },
              take: 500,
            },
          },
        });

        if (!vehicle) {
          return reply.code(404).send({
            error: "vehicle_not_found",
            message: "Vehicle was not found for this user.",
          });
        }

        return reply.send({
          maintenanceHealth: calculateMaintenanceHealth({
            currentOdometerKm: vehicle.currentOdometerKm,
            maintenanceBaselines: vehicle.maintenanceBaselines,
            trips: vehicle.trips,
          }),
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

        request.log.warn({ error }, "Vehicle maintenance health fetch failed.");
        return reply.code(500).send({
          error: "request_failed",
          message: "Vehicle maintenance health fetch failed.",
        });
      }
    },
  );

  app.post("/vehicles/:vehicleId/share-invites", async (request, reply) => {
    const parsedParams = vehicleIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const vehicle = await getVehicleWithAccess(
        parsedParams.data.vehicleId,
        userId,
        ["owner"],
      );

      if (!vehicle) {
        return reply.code(404).send({
          error: "vehicle_not_found",
          message: "Vehicle was not found for this user.",
        });
      }

      const rawToken = createRandomToken(32);
      const invite = await prisma.vehicleShareInvite.create({
        data: {
          vehicleId: vehicle.id,
          inviterUserId: userId,
          tokenHash: hashToken(rawToken),
          expiresAt: addDays(new Date(), config.vehicleShareInviteTtlDays),
        },
      });

      return reply.code(201).send({
        token: rawToken,
        status: invite.status,
        expiresAt: invite.expiresAt.toISOString(),
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle share invite creation.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Vehicle share invite creation failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle share invite creation failed.",
      });
    }
  });

  app.post("/vehicles/share-invites/accept", async (request, reply) => {
    const parsedBody = acceptShareInviteBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send(validationError());
    }

    try {
      const userId = await getAuthenticatedUserId(request);
      const tokenHash = hashToken(parsedBody.data.token);
      const vehicle = await prisma.$transaction(async (tx) => {
        const invite = await tx.vehicleShareInvite.findUnique({
          where: { tokenHash },
          include: { vehicle: true },
        });

        if (!invite) {
          return null;
        }

        if (invite.status === "revoked") {
          return "revoked" as const;
        }

        if (invite.status === "expired" || invite.expiresAt.getTime() <= Date.now()) {
          if (invite.status === "pending") {
            await tx.vehicleShareInvite.update({
              where: { id: invite.id },
              data: { status: "expired" },
            });
          }

          return "expired" as const;
        }

        if (invite.status === "accepted" && invite.acceptedByUserId !== userId) {
          return "accepted" as const;
        }

        const existingAccess = await tx.vehicleAccess.findUnique({
          where: {
            userId_vehicleId: {
              userId,
              vehicleId: invite.vehicleId,
            },
          },
        });

        if (!existingAccess) {
          await tx.vehicleAccess.create({
            data: {
              userId,
              vehicleId: invite.vehicleId,
              role: "shared",
              inviteId: invite.id,
            },
          });
        }

        if (invite.status !== "accepted" || invite.acceptedByUserId !== userId) {
          await tx.vehicleShareInvite.update({
            where: { id: invite.id },
            data: {
              status: "accepted",
              acceptedAt: new Date(),
              acceptedByUserId: userId,
            },
          });
        }

        return invite.vehicle;
      });

      if (!vehicle) {
        return reply.code(404).send({
          error: "invalid_vehicle_share_invite",
          message: "Vehicle share invite is invalid.",
        });
      }

      if (vehicle === "expired") {
        return reply.code(410).send({
          error: "vehicle_share_invite_expired",
          message: "Vehicle share invite expired.",
        });
      }

      if (vehicle === "revoked") {
        return reply.code(410).send({
          error: "vehicle_share_invite_revoked",
          message: "Vehicle share invite was revoked.",
        });
      }

      if (vehicle === "accepted") {
        return reply.code(409).send({
          error: "vehicle_share_invite_already_used",
          message: "Vehicle share invite was already used.",
        });
      }

      return reply.send({
        vehicle: toPublicVehicle(vehicle),
      });
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        request.log.warn(
          { error },
          "Database unavailable during vehicle share invite acceptance.",
        );
        return reply.code(503).send(databaseUnavailablePayload);
      }

      if (error instanceof AuthError) {
        return reply.code(401).send({
          error: "invalid_access_token",
          message: "Access token is invalid or expired.",
        });
      }

      request.log.warn({ error }, "Vehicle share invite acceptance failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle share invite acceptance failed.",
      });
    }
  });
};
