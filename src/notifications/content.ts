import type { AppNotificationType, Prisma } from "@prisma/client";

type PushContent = {
  title: string;
  body: string;
};

const isRecord = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getString = (payload: Prisma.JsonObject, key: string) => {
  const value = payload[key];
  return typeof value === "string" ? value : null;
};

const getNumber = (payload: Prisma.JsonObject, key: string) => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const formatNumber = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

const formatDate = (value: string | null, locale: string) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

const formatMaintenanceDueBody = (
  payload: Prisma.JsonObject,
  locale: string,
) => {
  const remainingKm = getNumber(payload, "remainingKm");
  const remainingDays = getNumber(payload, "remainingDays");

  if (locale.startsWith("pt")) {
    if (remainingKm !== null && remainingDays !== null) {
      return `Faltam aproximadamente ${formatNumber(
        Math.max(0, remainingKm),
        locale,
      )} km ou ${Math.max(0, remainingDays)} dias para a próxima troca.`;
    }

    if (remainingKm !== null) {
      return `Faltam aproximadamente ${formatNumber(
        Math.max(0, remainingKm),
        locale,
      )} km para a próxima troca.`;
    }

    if (remainingDays !== null) {
      return `Faltam aproximadamente ${Math.max(
        0,
        remainingDays,
      )} dias para a próxima troca.`;
    }

    return "Agende uma visita à oficina para manter seu motor saudável.";
  }

  if (remainingKm !== null && remainingDays !== null) {
    return `About ${formatNumber(
      Math.max(0, remainingKm),
      locale,
    )} km or ${Math.max(0, remainingDays)} days left until the next change.`;
  }

  if (remainingKm !== null) {
    return `About ${formatNumber(
      Math.max(0, remainingKm),
      locale,
    )} km left until the next change.`;
  }

  if (remainingDays !== null) {
    return `About ${Math.max(0, remainingDays)} days left until the next change.`;
  }

  return "Schedule a workshop visit to keep your engine healthy.";
};

export const formatPushContent = ({
  locale,
  payload,
  type,
}: {
  locale?: string | null;
  payload: Prisma.JsonValue;
  type: AppNotificationType;
}): PushContent => {
  const resolvedLocale = locale || "en-US";
  const values = isRecord(payload) ? payload : {};
  const vehicleTitle = getString(values, "vehicleTitle");
  const performedAt = formatDate(
    getString(values, "performedAt"),
    resolvedLocale,
  );
  const isPt = resolvedLocale.startsWith("pt");

  if (type === "maintenance_due") {
    return {
      title: isPt ? "Troca de óleo próxima" : "Oil change coming up",
      body: formatMaintenanceDueBody(values, resolvedLocale),
    };
  }

  if (type === "oil_change_logged") {
    return {
      title: isPt ? "Última troca registrada" : "Last change logged",
      body: isPt
        ? `Troca de óleo${performedAt ? ` em ${performedAt}` : ""} registrada para ${
            vehicleTitle ?? "seu veículo"
          }.`
        : `Oil change${performedAt ? ` on ${performedAt}` : ""} logged for ${
            vehicleTitle ?? "your vehicle"
          }.`,
    };
  }

  if (type === "driving_tip") {
    return {
      title: isPt ? "Dica de direção" : "Driving tip",
      body: isPt
        ? "Detectamos uso severo do veículo. Acelerações suaves ajudam a economizar óleo e combustível."
        : "We detected severe vehicle use. Smooth acceleration helps save oil and fuel.",
    };
  }

  return {
    title: isPt ? "Manutenção preventiva" : "Preventive maintenance",
    body: isPt
      ? "Não esqueça de verificar fluidos, pneus e freios regularmente."
      : "Remember to check fluids, tires, and brakes regularly.",
  };
};
