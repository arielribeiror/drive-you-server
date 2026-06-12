import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  Vehicle,
  VehicleAccessRole,
  VehicleMaintenanceBaseline,
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

const MAX_LICENSING_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_VEHICLE_IMAGE_BYTES = 10 * 1024 * 1024;
const vehicleImageFileNameSchema = z.object({
  fileName: z.string().regex(/^[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/),
});
const vehicleImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const toPublicVehicle = (vehicle: Vehicle) => ({
  id: vehicle.id,
  plate: vehicle.plate,
  renavam: vehicle.renavam,
  brandModel: vehicle.brandModel,
  manufactureYear: vehicle.manufactureYear,
  modelYear: vehicle.modelYear,
  ownerName: vehicle.ownerName,
  ownerDocumentMasked: vehicle.ownerDocumentMasked,
  verificationStatus: vehicle.verificationStatus,
  verificationSource: vehicle.verificationSource,
  heroImageOriginalUrl: vehicle.heroImageOriginalUrl,
  heroImageUrl: vehicle.heroImageUrl,
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

export const registerVehiclesRoutes = async (app: FastifyInstance) => {
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
          accesses: {
            some: {
              userId,
            },
          },
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
          accessRole: accesses[0]?.role ?? "shared",
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

      if (!parsedDocument.plate) {
        return reply.code(422).send({
          error: "unable_to_read_vehicle_document",
          message: "Could not find a vehicle plate in this PDF.",
          missingFields: parsedDocument.missingFields,
        });
      }

      const plate = parsedDocument.plate;
      const documentHash = createHash("sha256").update(buffer).digest("hex");
      const vehicle = await prisma.$transaction(async (tx) => {
        const upsertedVehicle = await tx.vehicle.upsert({
          where: {
            userId_plate: {
              userId,
              plate,
            },
          },
          create: {
            userId,
            plate,
            renavam: parsedDocument.renavam,
            brandModel: parsedDocument.brandModel,
            manufactureYear: parsedDocument.manufactureYear,
            modelYear: parsedDocument.modelYear,
            ownerName: parsedDocument.ownerName,
            ownerDocumentMasked: parsedDocument.ownerDocumentMasked,
            verificationStatus: "pending_review",
            verificationSource: "licensing_pdf",
            documentHash,
            documentFileName: document.filename,
            documentMimeType: document.mimetype,
            documentSizeBytes: buffer.length,
          },
          update: {
            renavam: parsedDocument.renavam,
            brandModel: parsedDocument.brandModel,
            manufactureYear: parsedDocument.manufactureYear,
            modelYear: parsedDocument.modelYear,
            ownerName: parsedDocument.ownerName,
            ownerDocumentMasked: parsedDocument.ownerDocumentMasked,
            verificationStatus: "pending_review",
            verificationSource: "licensing_pdf",
            documentHash,
            documentFileName: document.filename,
            documentMimeType: document.mimetype,
            documentSizeBytes: buffer.length,
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

      return reply.code(201).send({
        vehicle: toPublicVehicle(vehicle),
        extraction: {
          confidence: parsedDocument.confidence,
          missingFields: parsedDocument.missingFields,
        },
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

      request.log.warn({ error }, "Vehicle licensing document upload failed.");
      return reply.code(500).send({
        error: "request_failed",
        message: "Vehicle licensing document upload failed.",
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
        apiKey: config.removeBgApiKey,
        buffer: imageBuffer,
        fileName: image.filename,
        mimeType: image.mimetype,
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
              ? "remove.bg API key is not configured."
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
        const baseline = await prisma.vehicleMaintenanceBaseline.upsert({
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
            intervalKm: schedule.intervalKm,
            intervalMonths: schedule.intervalMonths,
            intervalDays: schedule.intervalDays,
          },
          update: {
            userId,
            performedAt: parsedBody.data.performedAt,
            odometerKm: parsedBody.data.odometerKm,
            usageProfile,
            intervalKm: schedule.intervalKm,
            intervalMonths: schedule.intervalMonths,
            intervalDays: schedule.intervalDays,
          },
        });

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
