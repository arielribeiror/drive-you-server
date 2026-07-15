import { z } from "zod";

export const fipeVehicleTypeSchema = z.enum([
  "cars",
  "motorcycles",
  "trucks",
]);

export type FipeVehicleType = z.infer<typeof fipeVehicleTypeSchema>;
export type FipeLinkSource = "automatic" | "confirmed" | "manual";
export type FipeOption = {
  code: string;
  name: string;
};
export type FipeReference = {
  code: string;
  month: string;
};
export type FipeVehicleYear = FipeOption;
export type FipePriceHistoryItem = {
  month: string;
  price: string;
  reference: string;
};
export type FipeVehicleBaseDetail = {
  brand: string;
  codeFipe: string;
  fuel: string;
  fuelAcronym: string;
  model: string;
  modelYear: number;
  priceHistory: FipePriceHistoryItem[];
  vehicleType: number;
};
export type FipeVehicleDetail = FipeVehicleBaseDetail & {
  price: string;
  referenceMonth: string;
};
export type FipeVehicleHistoryDetail = FipeVehicleBaseDetail & {
  price?: string;
  referenceMonth?: string;
};
export type FipeCandidateConfidence = "high" | "low" | "medium";
export type FipeCandidate = {
  brandCode: string;
  brandName: string;
  codeFipe: string;
  confidence: FipeCandidateConfidence;
  displayName: string;
  history: FipeValuationHistoryPoint[];
  modelCode: string;
  modelName: string;
  modelYear: number;
  priceCents: number;
  score: number;
  vehicleType: FipeVehicleType;
  yearId: string;
  yearName: string;
};
export type FipeValuationHistoryPoint = {
  priceCents: number;
  referenceCode: string;
  referenceMonth: string;
};
export type FipeValuation = {
  currentPriceCents: number;
  currentPriceFormatted: string;
  history: FipeValuationHistoryPoint[];
  referenceMonth: string;
  variationDirection: "down" | "flat" | "up" | "unknown";
  variationPercent: number | null;
};
export type CachedFipePrice = FipeValuationHistoryPoint & {
  fetchedAt: Date;
};
export type FipeVehicleForResolution = {
  brandModel: string | null;
  manufactureYear: number | null;
  modelYear: number | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const optionCodeSchema = z.union([z.number(), z.string()]).transform(String);
const fipeOptionSchema = z.object({
  code: optionCodeSchema,
  name: z.string(),
});
const fipeReferenceSchema = z.object({
  code: optionCodeSchema,
  month: z.string(),
});
const fipePriceHistorySchema = z.object({
  month: z.string(),
  price: z.string(),
  reference: optionCodeSchema,
});
const fipeVehicleBaseDetailSchema = z.object({
  brand: z.string(),
  codeFipe: z.string(),
  fuel: z.string().default(""),
  fuelAcronym: z.string().default(""),
  model: z.string(),
  modelYear: z.coerce.number().int(),
  priceHistory: z.array(fipePriceHistorySchema).default([]),
  vehicleType: z.coerce.number().int(),
});
const fipeVehicleDetailSchema = fipeVehicleBaseDetailSchema.extend({
  price: z.string(),
  referenceMonth: z.string(),
});
const fipeVehicleHistoryDetailSchema = fipeVehicleBaseDetailSchema.extend({
  price: z.string().optional(),
  referenceMonth: z.string().optional(),
});

export const FIPE_CACHE_TTL_MS = 32 * 24 * 60 * 60 * 1000;
export const FIPE_CHART_HISTORY_LIMIT = 13;
const FIPE_HISTORY_LIMIT = 24;
const AUTO_LINK_SCORE_THRESHOLD = 0.7;
const AUTO_LINK_SCORE_GAP = 0.12;
const MODEL_CANDIDATE_LIMIT = 10;
const BRAND_CANDIDATE_LIMIT = 5;

export class FipeClientError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "network"
      | "not_found"
      | "payment_required"
      | "rate_limited"
      | "request_failed",
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export const parseBrazilianPriceToCents = (price: string) => {
  const normalized = price
    .replace(/\s/g, "")
    .replace(/^R\$/i, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const numericValue = Number(normalized);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new FipeClientError(
      "invalid_response",
      `Invalid FIPE price: ${price}`,
    );
  }

  return Math.round(numericValue * 100);
};

export const formatBrazilianPriceFromCents = (priceCents: number) =>
  new Intl.NumberFormat("pt-BR", {
    currency: "BRL",
    style: "currency",
  }).format(priceCents / 100);

export const normalizeFipeReferenceMonth = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+de\s+/gi, "/")
    .replace(/[^a-z0-9]+/gi, "/")
    .replace(/^\/|\/$/g, "")
    .toLowerCase();

const normalizePathPart = (value: string) => encodeURIComponent(value);

const normalizeBaseUrl = (value: string) => value.replace(/\/$/, "");

const toFipeHeaders = (token?: string) => ({
  Accept: "application/json",
  ...(token ? { "X-Subscription-Token": token } : {}),
});

const fetchJson = async <Result>(
  fetchImpl: FetchLike,
  url: string,
  schema: z.ZodType<Result>,
  timeoutMs: number,
  token?: string,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: toFipeHeaders(token),
      signal: controller.signal,
    });
  } catch (error) {
    throw new FipeClientError(
      "network",
      error instanceof Error ? error.message : "FIPE request failed.",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 404) {
    throw new FipeClientError("not_found", "FIPE resource not found.", 404);
  }

  if (response.status === 429) {
    throw new FipeClientError("rate_limited", "FIPE rate limit reached.", 429);
  }

  if (response.status === 402) {
    throw new FipeClientError(
      "payment_required",
      "FIPE extended history requires a paid token.",
      402,
    );
  }

  if (!response.ok) {
    throw new FipeClientError(
      "request_failed",
      "FIPE request failed.",
      response.status,
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new FipeClientError(
      "invalid_response",
      "FIPE response was not JSON.",
      response.status,
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new FipeClientError(
      "invalid_response",
      "FIPE response did not match the expected schema.",
      response.status,
    );
  }

  return parsed.data;
};

export class FipeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly token?: string;

  constructor({
    baseUrl,
    fetchImpl = fetch,
    timeoutMs,
    token,
  }: {
    readonly baseUrl: string;
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs: number;
    readonly token?: string;
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = token;
  }

  getReferences = () =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/references`,
      z.array(fipeReferenceSchema),
      this.timeoutMs,
      this.token,
    );

  getBrands = (vehicleType: FipeVehicleType) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/brands`,
      z.array(fipeOptionSchema),
      this.timeoutMs,
      this.token,
    );

  getModels = (vehicleType: FipeVehicleType, brandCode: string) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/brands/${normalizePathPart(
        brandCode,
      )}/models`,
      z.array(fipeOptionSchema),
      this.timeoutMs,
      this.token,
    );

  getYearsByModel = (
    vehicleType: FipeVehicleType,
    brandCode: string,
    modelCode: string,
  ) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/brands/${normalizePathPart(
        brandCode,
      )}/models/${normalizePathPart(modelCode)}/years`,
      z.array(fipeOptionSchema),
      this.timeoutMs,
      this.token,
    );

  getVehicleDetailByModel = (
    vehicleType: FipeVehicleType,
    brandCode: string,
    modelCode: string,
    yearId: string,
  ) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/brands/${normalizePathPart(
        brandCode,
      )}/models/${normalizePathPart(modelCode)}/years/${normalizePathPart(
        yearId,
      )}`,
      fipeVehicleDetailSchema,
      this.timeoutMs,
      this.token,
    );

  getYearsByFipeCode = (vehicleType: FipeVehicleType, fipeCode: string) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/${normalizePathPart(fipeCode)}/years`,
      z.array(fipeOptionSchema),
      this.timeoutMs,
      this.token,
    );

  getVehicleDetailByFipeCode = (
    vehicleType: FipeVehicleType,
    fipeCode: string,
    yearId: string,
    referenceCode?: string,
  ) => {
    const referenceQuery = referenceCode
      ? `?reference=${normalizePathPart(referenceCode)}`
      : "";

    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/${normalizePathPart(
        fipeCode,
      )}/years/${normalizePathPart(yearId)}${referenceQuery}`,
      fipeVehicleDetailSchema,
      this.timeoutMs,
      this.token,
    );
  };

  getVehicleHistoryByFipeCode = (
    vehicleType: FipeVehicleType,
    fipeCode: string,
    yearId: string,
  ) =>
    fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${vehicleType}/${normalizePathPart(
        fipeCode,
      )}/years/${normalizePathPart(yearId)}/history`,
      fipeVehicleHistoryDetailSchema,
      this.timeoutMs,
      this.token,
    );
}

type FipeApi = Pick<
  FipeClient,
  "getBrands" | "getModels" | "getVehicleDetailByModel" | "getYearsByModel"
>;

const normalizeForMatch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bI\//gi, " ")
    .replace(/[^A-Z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

const STOP_TOKENS = new Set([
  "A",
  "ANO",
  "AT",
  "AUT",
  "AUTO",
  "AUTOMATICA",
  "AUTOMATICO",
  "CD",
  "COM",
  "DA",
  "DE",
  "DO",
  "DOS",
  "E",
  "FLEX",
  "G",
  "GAS",
  "GASOLINA",
  "I",
  "IMP",
  "IMPORTADO",
  "MEC",
  "MECANICO",
  "NAC",
  "NACIONAL",
  "O",
  "OU",
  "P",
  "PREMIUM",
]);

const tokenize = (value: string) =>
  normalizeForMatch(value)
    .split(" ")
    .filter((token) => token.length > 0 && !STOP_TOKENS.has(token));

const tokenSet = (value: string) => new Set(tokenize(value));

const countOverlap = (left: Set<string>, right: Set<string>) => {
  let count = 0;

  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }

  return count;
};

const scoreBrand = (brandName: string, sourceTokens: Set<string>) => {
  const brandTokens = tokenSet(brandName);

  if (brandTokens.size === 0 || sourceTokens.size === 0) {
    return 0;
  }

  const overlap = countOverlap(brandTokens, sourceTokens);

  return overlap / Math.min(brandTokens.size, sourceTokens.size);
};

export const scoreFipeModelMatch = (
  sourceBrandModel: string,
  brandName: string,
  modelName: string,
) => {
  const sourceTokens = [...tokenSet(sourceBrandModel)];
  const brandTokens = tokenSet(brandName);
  const modelTokens = [...tokenSet(modelName)];
  const sourceWithoutBrand = sourceTokens.filter(
    (token) => !brandTokens.has(token),
  );

  if (sourceWithoutBrand.length === 0 || modelTokens.length === 0) {
    return 0;
  }

  const sourceCore = new Set(sourceWithoutBrand);
  const modelCore = new Set(modelTokens);
  const overlap = countOverlap(sourceCore, modelCore);

  if (overlap === 0) {
    return 0;
  }

  const sourceCoverage = overlap / sourceCore.size;
  const compactSource = sourceWithoutBrand.join("");
  const compactModel = modelTokens.join("");
  const firstSourceToken = sourceWithoutBrand[0];
  const firstTokenScore =
    firstSourceToken !== undefined && modelCore.has(firstSourceToken)
      ? /\d/.test(firstSourceToken) || firstSourceToken.length >= 3
        ? 0.55
        : 0.4
      : 0;
  const compactScore =
    compactSource.length >= 3 && compactModel.includes(compactSource)
      ? 0.82
      : 0;

  return Math.max(sourceCoverage, firstTokenScore, compactScore);
};

const confidenceFromScore = (score: number): FipeCandidateConfidence => {
  if (score >= AUTO_LINK_SCORE_THRESHOLD) {
    return "high";
  }

  if (score >= 0.45) {
    return "medium";
  }

  return "low";
};

const getYearFromYearId = (yearId: string) => {
  const [year] = yearId.split("-");
  const parsed = Number(year);

  return Number.isInteger(parsed) ? parsed : null;
};

const getCandidateYears = (
  years: FipeVehicleYear[],
  vehicle: FipeVehicleForResolution,
) => {
  const targetYears = [
    vehicle.modelYear,
    vehicle.manufactureYear,
  ].filter((year): year is number => typeof year === "number");

  if (targetYears.length === 0) {
    return years.slice(0, 3);
  }

  const exactYears = years.filter((year) => {
    const parsedYear = getYearFromYearId(year.code);

    return parsedYear !== null && targetYears.includes(parsedYear);
  });

  if (exactYears.length > 0) {
    return exactYears;
  }

  const nearestYears = years
    .map((year) => {
      const parsedYear = getYearFromYearId(year.code);

      if (parsedYear === null) {
        return null;
      }

      return {
        distance: Math.min(
          ...targetYears.map((targetYear) => Math.abs(targetYear - parsedYear)),
        ),
        year,
      };
    })
    .filter(
      (item): item is { distance: number; year: FipeVehicleYear } =>
        item !== null,
    )
    .sort((left, right) => left.distance - right.distance);

  const closestDistance = nearestYears[0]?.distance;

  if (closestDistance === undefined || closestDistance > 1) {
    return [];
  }

  return nearestYears
    .filter((item) => item.distance === closestDistance)
    .map((item) => item.year)
    .slice(0, 3);
};

export const toFipeDisplayName = (detail: FipeVehicleDetail) =>
  [
    detail.brand,
    detail.model,
    String(detail.modelYear),
    detail.fuel ? `- ${detail.fuel}` : null,
  ]
    .filter(Boolean)
    .join(" ");

export const resolveFipeCandidates = async (
  api: FipeApi,
  vehicle: FipeVehicleForResolution,
  vehicleTypes: readonly FipeVehicleType[] = ["cars"],
) => {
  const brandModel = vehicle.brandModel?.trim();

  if (!brandModel) {
    return [];
  }

  const sourceTokens = tokenSet(brandModel);
  const candidates: FipeCandidate[] = [];

  for (const vehicleType of vehicleTypes) {
    const brands = await api.getBrands(vehicleType);
    const brandMatches = brands
      .map((brand) => ({
        brand,
        score: scoreBrand(brand.name, sourceTokens),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, BRAND_CANDIDATE_LIMIT);

    for (const { brand } of brandMatches) {
      const models = await api.getModels(vehicleType, brand.code);
      const modelMatches = models
        .map((model) => ({
          model,
          score: scoreFipeModelMatch(brandModel, brand.name, model.name),
        }))
        .filter((match) => match.score >= 0.35)
        .sort((left, right) => right.score - left.score)
        .slice(0, MODEL_CANDIDATE_LIMIT);

      for (const { model, score } of modelMatches) {
        const years = await api.getYearsByModel(
          vehicleType,
          brand.code,
          model.code,
        );
        const matchingYears = getCandidateYears(years, vehicle);

        for (const year of matchingYears) {
          try {
            const detail = await api.getVehicleDetailByModel(
              vehicleType,
              brand.code,
              model.code,
              year.code,
            );
            const history = priceHistoryFromDetail(detail);

            candidates.push({
              brandCode: brand.code,
              brandName: brand.name,
              codeFipe: detail.codeFipe,
              confidence: confidenceFromScore(score),
              displayName: toFipeDisplayName(detail),
              history,
              modelCode: model.code,
              modelName: model.name,
              modelYear: detail.modelYear,
              priceCents: parseBrazilianPriceToCents(detail.price),
              score,
              vehicleType,
              yearId: year.code,
              yearName: year.name,
            });
          } catch (error) {
            if (
              !(error instanceof FipeClientError) ||
              error.code !== "not_found"
            ) {
              throw error;
            }
          }
        }
      }
    }
  }

  const uniqueCandidates = new Map<string, FipeCandidate>();

  for (const candidate of candidates.sort(
    (left, right) => right.score - left.score,
  )) {
    const key = `${candidate.vehicleType}:${candidate.codeFipe}:${candidate.yearId}`;

    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, candidate);
    }
  }

  return [...uniqueCandidates.values()].slice(0, MODEL_CANDIDATE_LIMIT);
};

export const getConfidentAutomaticCandidate = (
  candidates: readonly FipeCandidate[],
) => {
  const [best, secondBest] = [...candidates].sort(
    (left, right) => right.score - left.score,
  );

  if (!best || best.score < AUTO_LINK_SCORE_THRESHOLD) {
    return null;
  }

  if (secondBest && best.score - secondBest.score < AUTO_LINK_SCORE_GAP) {
    return null;
  }

  return best;
};

export const isFipeCacheFresh = (
  prices: readonly CachedFipePrice[],
  now = new Date(),
) => {
  if (prices.length === 0) {
    return false;
  }

  const newestFetchTime = Math.max(
    ...prices.map((price) => price.fetchedAt.getTime()),
  );
  const newestFetchDate = new Date(newestFetchTime);
  const sameReferenceWindow =
    newestFetchDate.getUTCFullYear() === now.getUTCFullYear() &&
    newestFetchDate.getUTCMonth() === now.getUTCMonth();

  return (
    sameReferenceWindow &&
    newestFetchTime <= now.getTime() &&
    now.getTime() - newestFetchTime <= FIPE_CACHE_TTL_MS
  );
};

export const isFipeHistoryCacheFresh = (
  prices: readonly CachedFipePrice[],
  now = new Date(),
) =>
  new Set(
    prices.map((price) => normalizeFipeReferenceMonth(price.referenceMonth)),
  ).size >= FIPE_CHART_HISTORY_LIMIT && isFipeCacheFresh(prices, now);

const sortByReferenceAscending = <Price extends FipeValuationHistoryPoint>(
  prices: readonly Price[],
) =>
  [...prices].sort((left, right) => {
    const leftReference = Number(left.referenceCode);
    const rightReference = Number(right.referenceCode);

    if (Number.isFinite(leftReference) && Number.isFinite(rightReference)) {
      return leftReference - rightReference;
    }

    return left.referenceCode.localeCompare(right.referenceCode);
  });

export const dedupeFipeHistoryByReferenceMonth = <
  Price extends FipeValuationHistoryPoint,
>(
  prices: readonly Price[],
) => {
  const pointByMonth = new Map<string, Price>();

  for (const point of sortByReferenceAscending(prices)) {
    const monthKey = normalizeFipeReferenceMonth(point.referenceMonth);
    const currentPoint = pointByMonth.get(monthKey);

    if (!currentPoint) {
      pointByMonth.set(monthKey, point);
      continue;
    }

    if (currentPoint.referenceCode === "0" && point.referenceCode !== "0") {
      pointByMonth.set(monthKey, point);
    }
  }

  return sortByReferenceAscending([...pointByMonth.values()]);
};

export const buildFipeValuation = (
  prices: readonly CachedFipePrice[],
  historyLimit = FIPE_HISTORY_LIMIT,
): FipeValuation | null => {
  if (prices.length === 0) {
    return null;
  }

  const history = dedupeFipeHistoryByReferenceMonth(prices).slice(-historyLimit);
  const first = history[0];
  const current = history.at(-1);

  if (!current) {
    return null;
  }

  const variationPercent =
    first && first.referenceCode !== current.referenceCode && first.priceCents > 0
      ? ((current.priceCents - first.priceCents) / first.priceCents) * 100
      : null;
  const variationDirection =
    variationPercent === null
      ? "unknown"
      : Math.abs(variationPercent) < 0.05
        ? "flat"
        : variationPercent > 0
          ? "up"
          : "down";

  return {
    currentPriceCents: current.priceCents,
    currentPriceFormatted: formatBrazilianPriceFromCents(current.priceCents),
    history: history.map(({ priceCents, referenceCode, referenceMonth }) => ({
      priceCents,
      referenceCode,
      referenceMonth,
    })),
    referenceMonth: current.referenceMonth,
    variationDirection,
    variationPercent,
  };
};

export const priceHistoryFromDetail = (
  detail: FipeVehicleDetail | FipeVehicleHistoryDetail,
): FipeValuationHistoryPoint[] => {
  if (detail.priceHistory.length > 0) {
    return detail.priceHistory.map((item) => ({
      priceCents: parseBrazilianPriceToCents(item.price),
      referenceCode: item.reference,
      referenceMonth: item.month,
    }));
  }

  if (!detail.price || !detail.referenceMonth) {
    throw new FipeClientError(
      "invalid_response",
      "FIPE detail did not include a price history.",
    );
  }

  return [
    {
      priceCents: parseBrazilianPriceToCents(detail.price),
      referenceCode: "0",
      referenceMonth: detail.referenceMonth,
    },
  ];
};
