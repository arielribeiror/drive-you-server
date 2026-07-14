import { PDFParse } from "pdf-parse";

export type ParsedLicensingDocument = {
  plate: string | null;
  renavam: string | null;
  brandModel: string | null;
  manufactureYear: number | null;
  modelYear: number | null;
  ownerName: string | null;
  ownerDocumentMasked: string | null;
  confidence: "low" | "medium" | "high";
  missingFields: string[];
};

export class LicensingDocumentParseError extends Error {
  constructor(message = "Unable to read licensing document.") {
    super(message);
  }
}

const YEAR_MIN = 1980;
const YEAR_MAX = new Date().getFullYear() + 2;

const FIELD_LABELS = [
  "ASSINADO",
  "ANO",
  "CAPACIDADE",
  "CARROCERIA",
  "CATEGORIA",
  "CERTIFICADO",
  "CHASSI",
  "CILINDRADA",
  "CLA",
  "CNPJ",
  "CODIGO",
  "COMBUSTIVEL",
  "COR",
  "CPF",
  "DATA",
  "DENATRAN",
  "DEPARTAMENTO",
  "DETRAN",
  "E-MAIL",
  "EMAIL",
  "ENDERECO",
  "DOCUMENTO",
  "ESPECIE",
  "EXERCICIO",
  "HODOMETRO",
  "IDENTIFICACAO",
  "LICENCIAMENTO",
  "LOCAL",
  "MARCA",
  "MENSAGENS",
  "MODELO",
  "MUNICIPIO",
  "NUMERO",
  "OBSERVACOES",
  "ORGAO",
  "PAGAMENTO",
  "PESO",
  "PLACA",
  "POTENCIA",
  "PROPRIETARIO",
  "QUILOMETRAGEM",
  "RENAVAM",
  "REPUBLICA",
  "SEGURO",
  "TELEFONE",
  "TIPO",
  "TRANSITO",
  "TRANSFERENCIA",
  "TRANSFERIR",
  "UF",
  "VALOR",
  "VEICULO",
  "VERSAO",
];

const BLOCKED_FIELD_VALUES = [
  "ASSINATURA",
  "AUTORIZACAO",
  "AUTORIZO",
  "CHASSI",
  "CLA",
  "CPF",
  "CNPJ",
  "DENATRAN",
  "DEPARTAMENTO",
  "DETRAN",
  "E-MAIL",
  "EMAIL",
  "HODOMETRO",
  "MARCA",
  "MENSAGENS",
  "MODELO",
  "NAO APLICAVEL",
  "NOME",
  "NUMERO CRV",
  "ORGAO",
  "PAGAMENTO",
  "PLACA",
  "PROPRIETARIO",
  "RENAVAM",
  "REPUBLICA",
  "SEGURO",
  "TELEFONE",
  "TRANSITO",
  "TRANSFERIR",
  "VALOR",
  "VERSAO",
];

const normalizeForMatch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

const cleanValue = (value?: string | null) =>
  value?.replace(/\s+/g, " ").replace(/^[\s:.-]+|[\s:.-]+$/g, "").trim() ||
  null;

const toLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map(cleanValue)
    .filter((line): line is string => Boolean(line));

const isLikelyLabel = (value: string) => {
  const normalized = normalizeForMatch(value);

  if (!normalized) {
    return true;
  }

  const labelHits = FIELD_LABELS.filter((label) =>
    normalized.includes(label),
  ).length;

  return labelHits >= 2 || (/^[A-Z\s/.-]+$/.test(normalized) && labelHits >= 1);
};

const isBlockedFieldValue = (value: string) => {
  const normalized = normalizeForMatch(value);

  return BLOCKED_FIELD_VALUES.some((label) => normalized.includes(label));
};

const BLOCKED_OWNER_TERMS = [
  "ACESSAR",
  "AGORA",
  "APLICAVEL",
  "BAIXE",
  "COMODIDADE",
  "DESCONTO",
  "ENTIDADE",
  "EXECUTIVO",
  "GANHA",
  "INFRACOES",
  "MENSAGENS",
  "ORGAO",
  "PARA",
  "PORTAL",
  "QR CODE",
  "SERVICOS",
  "TRANSITO",
  "VOCE",
];

const isBlockedOwnerValue = (value: string) => {
  const normalized = normalizeForMatch(value);

  return BLOCKED_OWNER_TERMS.some((term) => normalized.includes(term));
};

const OWNER_DOCUMENT_PATTERN =
  "\\b(?:\\d{3}\\s*\\.?\\s*\\d{3}\\s*\\.?\\s*\\d{3}\\s*-?\\s*\\d{2}|\\d{2}\\s*\\.?\\s*\\d{3}\\s*\\.?\\s*\\d{3}\\s*\\/?\\s*\\d{4}\\s*-?\\s*\\d{2})\\b";
const OWNER_DOCUMENT_REGEX = new RegExp(OWNER_DOCUMENT_PATTERN);
const OWNER_DOCUMENT_GLOBAL_REGEX = new RegExp(OWNER_DOCUMENT_PATTERN, "g");

const cleanOwnerCandidate = (value?: string | null) =>
  cleanValue(
    value
      ?.replace(OWNER_DOCUMENT_GLOBAL_REGEX, " ")
      .replace(/\bCPF\s*\/?\s*CNPJ\b/gi, " ")
      .replace(/\bCPF\b|\bCNPJ\b/gi, " ")
      .replace(/^N[AÃ]O\s+APLIC[AÁ]VEL\b/gi, " ")
      .replace(/^NOME(?:\s+DO\s+PROPRIET[AÁ]RIO)?\b/gi, " "),
  );

const getValueAfterLastPattern = (value: string, patterns: RegExp[]) => {
  let lastMatch: RegExpExecArray | null = null;

  for (const pattern of patterns) {
    const matches = [...value.matchAll(new RegExp(pattern, "gi"))];
    const match = matches.at(-1);

    if (match?.index !== undefined && (!lastMatch || match.index > lastMatch.index)) {
      lastMatch = match;
    }
  }

  return lastMatch?.index === undefined
    ? null
    : value.slice(lastMatch.index + lastMatch[0].length);
};

const cleanOwnerCandidateBeforeDocument = (value: string) => {
  const match = OWNER_DOCUMENT_REGEX.exec(value);

  if (!match) {
    return null;
  }

  const beforeDocument = value.slice(0, match.index);
  const afterOwnerLabel = getInlineValueAfter(
    beforeDocument,
    /^.*NOME(?:\s+DO\s+PROPRIET[AÁ]RIO)?(?:\s+CPF\s*\/?\s*CNPJ)?\s*/i,
  );
  const afterPreviousFieldValue = getValueAfterLastPattern(beforeDocument, [
    /N[AÃ]O\s+APLIC[AÁ]VEL\s+/,
    /PASSAGEIRO\s+AUTOM[OÓ]VEL\s+/,
  ]);

  return cleanOwnerCandidate(
    afterOwnerLabel ?? afterPreviousFieldValue ?? beforeDocument,
  );
};

const getInlineValue = (line: string) => {
  const colonIndex = line.indexOf(":");

  if (colonIndex === -1) {
    return null;
  }

  return cleanValue(line.slice(colonIndex + 1));
};

const getInlineValueAfter = (line: string, labelPattern: RegExp) => {
  const value = line.replace(labelPattern, "");

  return value === line ? null : cleanValue(value);
};

const findFollowingValue = (
  lines: string[],
  labelPatterns: RegExp[],
  accepts: (value: string) => boolean,
  maxLookAhead = 5,
) => {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeForMatch(line);

    if (!labelPatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    const candidates = [
      getInlineValue(line),
      ...lines.slice(index + 1, index + maxLookAhead + 1),
    ];

    for (const candidate of candidates) {
      const value = cleanValue(candidate);

      if (value && accepts(value)) {
        return value;
      }
    }
  }

  return null;
};

const extractWindowAfterLabel = (
  lines: string[],
  labelPatterns: RegExp[],
  maxLookAhead = 4,
) => {
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeForMatch(lines[index]);

    if (labelPatterns.some((pattern) => pattern.test(normalized))) {
      return [lines[index], ...lines.slice(index + 1, index + maxLookAhead + 1)]
        .join(" ")
        .replace(/\s+/g, " ");
    }
  }

  return "";
};

const extractPlate = (text: string) => {
  const normalized = normalizeForMatch(text);
  const matches =
    normalized.match(/\b[A-Z]{3}[-\s]?[0-9][A-Z0-9][0-9]{2}\b/g) ?? [];

  return matches[0]?.replace(/[-\s]/g, "") ?? null;
};

const extractRenavam = (lines: string[], text: string) => {
  const labeledWindow = extractWindowAfterLabel(lines, [/RENAVAM/]);
  const labeledMatch = labeledWindow.match(/\b\d{9,11}\b/);

  if (labeledMatch) {
    return labeledMatch[0];
  }

  const allCandidates = text.match(/\b\d{9,11}\b/g) ?? [];
  return allCandidates[0] ?? null;
};

const isValidYear = (value: number) => value >= YEAR_MIN && value <= YEAR_MAX;

const extractYears = (value: string) =>
  value
    .match(/\b(19\d{2}|20\d{2})\b/g)
    ?.map((year) => Number(year))
    .filter(isValidYear) ?? [];

const extractYearNearLabel = (lines: string[], labelPatterns: RegExp[]) => {
  const labeledWindow = extractWindowAfterLabel(lines, labelPatterns, 3);
  const years = extractYears(labeledWindow);

  return years?.[0] ?? null;
};

const extractVehicleYears = (lines: string[]) => {
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeForMatch(lines[index]);

    if (!/ANO.*FABRIC/.test(normalized) || !/ANO.*MODELO/.test(normalized)) {
      continue;
    }

    const years = extractYears(
      [lines[index], ...lines.slice(index + 1, index + 4)].join(" "),
    );

    if (years.length >= 2) {
      const vehicleYears = years.length > 2 ? years.slice(-2) : years;

      return {
        manufactureYear: vehicleYears[0],
        modelYear: vehicleYears[1],
      };
    }
  }

  const labeledYears = {
    manufactureYear: extractYearNearLabel(lines, [/ANO.*FABRIC/]),
    modelYear: extractYearNearLabel(lines, [/ANO.*MODELO/]),
  };

  if (labeledYears.manufactureYear || labeledYears.modelYear) {
    return labeledYears;
  }

  const allYears = extractYears(lines.join(" "));
  const yearPair = allYears.find((year, index) => {
    const nextYear = allYears[index + 1];

    return nextYear !== undefined && nextYear >= year && nextYear - year <= 2;
  });

  if (yearPair) {
    const index = allYears.indexOf(yearPair);

    return {
      manufactureYear: allYears[index],
      modelYear: allYears[index + 1],
    };
  }

  return labeledYears;
};

const normalizeVehicleModel = (value: string) =>
  cleanValue(value.replace(/\s*\/\s*/g, "/"));

const looksLikeVehicleModel = (value: string) => {
  const normalized = normalizeForMatch(value);
  const alphaTokens = normalized.match(/[A-Z]{2,}/g) ?? [];
  const hasVehicleShape =
    normalized.includes("/") || alphaTokens.length >= 2 || /\d/.test(normalized);

  return (
    /[A-Z]/.test(normalized) &&
    hasVehicleShape &&
    !extractPlate(normalized) &&
    !isBlockedFieldValue(value) &&
    !isLikelyLabel(value) &&
    normalized.length >= 4
  );
};

const extractBrandModel = (lines: string[]) => {
  for (const line of lines) {
    const inlineValue = getInlineValueAfter(
      line,
      /^.*MARCA\s*\/\s*MODELO\s*\/\s*VERS[AÃ]O\s*/i,
    );

    if (inlineValue && looksLikeVehicleModel(inlineValue)) {
      return normalizeVehicleModel(inlineValue);
    }
  }

  const importedModel = lines.find((line) =>
    /^[A-Z]{1,3}\s*\/\s*[A-Z0-9][A-Z0-9\s./-]{4,}$/i.test(line),
  );

  if (importedModel && looksLikeVehicleModel(importedModel)) {
    return normalizeVehicleModel(importedModel);
  }

  const followingValue = findFollowingValue(
    lines,
    [/MARCA.*MODELO/, /MODELO.*VERSAO/, /^MODELO$/],
    looksLikeVehicleModel,
    12,
  );

  if (followingValue) {
    return normalizeVehicleModel(followingValue);
  }

  return null;
};

const looksLikeOwnerName = (value: string) => {
  const ownerCandidate = cleanOwnerCandidate(value);

  if (!ownerCandidate) {
    return false;
  }

  const normalized = normalizeForMatch(ownerCandidate);
  const nameTokens = normalized.match(/[A-Z]{2,}/g) ?? [];

  return (
    normalized.length >= 5 &&
    normalized.length <= 70 &&
    nameTokens.length >= 2 &&
    /[A-Z]/.test(normalized) &&
    !/[,:;]/.test(ownerCandidate) &&
    !normalized.includes("@") &&
    !/\b[A-Z]{3}[0-9][A-Z0-9][0-9]{2}\b/.test(normalized) &&
    !/\d{5,}/.test(normalized) &&
    !isBlockedOwnerValue(ownerCandidate) &&
    !isBlockedFieldValue(ownerCandidate) &&
    !isLikelyLabel(ownerCandidate)
  );
};

const extractOwnerName = (lines: string[]) => {
  const stopPatterns = [
    /ASSINADO/,
    /DADOS/,
    /\bDATA\b/,
    /\bLOCAL\b/,
    /MENSAGENS/,
  ];
  const ownerLabelPatterns = [
    /NOME.*PROPRIETARIO/,
    /^PROPRIETARIO$/,
    /^NOME$/,
    /^NOME\s+CPF.*CNPJ$/,
    /^NOME\s+CNPJ$/,
    /\bNOME\b/,
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ownerBeforeDocument = cleanOwnerCandidateBeforeDocument(line);

    if (ownerBeforeDocument && looksLikeOwnerName(ownerBeforeDocument)) {
      return ownerBeforeDocument;
    }

    if (!OWNER_DOCUMENT_REGEX.test(line)) {
      continue;
    }

    for (const candidate of lines
      .slice(Math.max(index - 4, 0), index)
      .reverse()) {
      const ownerCandidate = cleanOwnerCandidate(candidate);

      if (ownerCandidate && looksLikeOwnerName(ownerCandidate)) {
        return ownerCandidate;
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inlineValue = getInlineValueAfter(
      line,
      /^.*NOME(?:\s+DO\s+PROPRIET[AÁ]RIO)?(?:\s+CPF\s*\/?\s*CNPJ)?\s*/i,
    );
    const inlineOwner = cleanOwnerCandidate(inlineValue);

    if (inlineOwner && looksLikeOwnerName(inlineOwner)) {
      return inlineOwner;
    }

    const normalized = normalizeForMatch(line);

    if (!ownerLabelPatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    for (const candidate of lines.slice(index + 1, index + 9)) {
      const normalizedCandidate = normalizeForMatch(candidate);
      const ownerCandidate =
        cleanOwnerCandidateBeforeDocument(candidate) ??
        cleanOwnerCandidate(candidate);

      if (ownerCandidate && looksLikeOwnerName(ownerCandidate)) {
        return ownerCandidate;
      }

      if (stopPatterns.some((pattern) => pattern.test(normalizedCandidate))) {
        break;
      }

      if (
        OWNER_DOCUMENT_REGEX.test(candidate) &&
        (!ownerCandidate || !looksLikeOwnerName(ownerCandidate))
      ) {
        break;
      }
    }
  }

  return null;
};

const maskDocument = (value: string) => {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }

  if (digits.length === 14) {
    return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(
      8,
      12,
    )}-**`;
  }

  return cleanValue(value);
};

const extractOwnerDocument = (lines: string[], ownerName: string | null) => {
  if (ownerName) {
    const normalizedOwnerName = normalizeForMatch(ownerName);

    for (let index = 0; index < lines.length; index += 1) {
      if (!normalizeForMatch(lines[index]).includes(normalizedOwnerName)) {
        continue;
      }

      const ownerWindow = lines.slice(index, index + 3).join(" ");
      const ownerMatch = ownerWindow.match(OWNER_DOCUMENT_REGEX);

      if (ownerMatch) {
        return maskDocument(ownerMatch[0]);
      }
    }
  }

  const labeledWindow = extractWindowAfterLabel(lines, [
    /CPF.*CNPJ/,
    /CPF/,
    /CNPJ/,
  ]);
  const match = labeledWindow.match(OWNER_DOCUMENT_REGEX);

  if (match) {
    return maskDocument(match[0]);
  }

  const formattedDocument = lines
    .map((line) => line.match(OWNER_DOCUMENT_REGEX)?.[0] ?? null)
    .find((document) => document && /[./-]/.test(document));

  return formattedDocument ? maskDocument(formattedDocument) : null;
};

type ParsedVehicleFields = Pick<
  ParsedLicensingDocument,
  "brandModel" | "ownerName" | "plate" | "renavam"
>;

const getConfidence = (parsed: ParsedVehicleFields) => {
  if (parsed.plate && parsed.renavam && parsed.brandModel && parsed.ownerName) {
    return "high";
  }

  if (parsed.plate && (parsed.renavam || parsed.brandModel)) {
    return "medium";
  }

  return "low";
};

const getMissingFields = (parsed: ParsedVehicleFields) => {
  const requiredFields: Array<[string, string | null]> = [
    ["plate", parsed.plate],
    ["renavam", parsed.renavam],
    ["brandModel", parsed.brandModel],
    ["ownerName", parsed.ownerName],
  ];

  return requiredFields
    .filter(([, value]) => !value)
    .map(([field]) => field);
};

export const parseLicensingDocumentText = (
  text: string,
): ParsedLicensingDocument => {
  const lines = toLines(text);
  const normalizedText = lines.join("\n");
  const vehicleYears = extractVehicleYears(lines);
  const ownerName = extractOwnerName(lines);

  const parsedWithoutConfidence = {
    plate: extractPlate(normalizedText),
    renavam: extractRenavam(lines, normalizedText),
    brandModel: extractBrandModel(lines),
    manufactureYear: vehicleYears.manufactureYear,
    modelYear: vehicleYears.modelYear,
    ownerName,
    ownerDocumentMasked: extractOwnerDocument(lines, ownerName),
  };
  const missingFields = getMissingFields(parsedWithoutConfidence);

  return {
    ...parsedWithoutConfidence,
    confidence: getConfidence(parsedWithoutConfidence),
    missingFields,
  };
};

export const extractLicensingDocumentFromPdf = async (buffer: Buffer) => {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();

    if (!result.text.trim()) {
      throw new LicensingDocumentParseError("PDF does not contain readable text.");
    }

    return parseLicensingDocumentText(result.text);
  } catch (error) {
    if (error instanceof LicensingDocumentParseError) {
      throw error;
    }

    throw new LicensingDocumentParseError();
  } finally {
    await parser.destroy();
  }
};
