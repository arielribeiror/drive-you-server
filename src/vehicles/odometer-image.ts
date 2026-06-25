type OdometerImageErrorCode =
  | "not_configured"
  | "request_failed"
  | "unable_to_read";

type OdometerImageConfidence = "low" | "medium" | "high";

type OdometerImageReading = {
  confidence: OdometerImageConfidence;
  odometerKm: number;
};

type ExtractOdometerFromImageInput = {
  apiKey?: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  model: string;
};

type ResponsesApiBody = {
  error?: {
    message?: string;
  };
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
    type?: string;
  }>;
  output_text?: string;
};

export class OdometerImageError extends Error {
  constructor(
    readonly code: OdometerImageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getOutputText = (body: ResponsesApiBody) => {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  return (
    body.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .find((text): text is string => typeof text === "string") ?? ""
  );
};

const parseJsonObject = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]) as unknown;
    } catch {
      return null;
    }
  }
};

const parseOdometerReading = (text: string): OdometerImageReading => {
  const parsed = parseJsonObject(text);

  if (!isRecord(parsed)) {
    throw new OdometerImageError(
      "unable_to_read",
      "Could not parse odometer reading.",
    );
  }

  const rawOdometerKm = parsed.odometerKm;
  const odometerKm =
    typeof rawOdometerKm === "number"
      ? rawOdometerKm
      : typeof rawOdometerKm === "string"
        ? Number(rawOdometerKm.replace(/\D/g, ""))
        : Number.NaN;
  const confidence = parsed.confidence;

  if (
    typeof odometerKm !== "number" ||
    !Number.isInteger(odometerKm) ||
    odometerKm < 0 ||
    odometerKm > 2_000_000
  ) {
    throw new OdometerImageError(
      "unable_to_read",
      "Could not find a valid odometer value.",
    );
  }

  if (
    confidence !== "low" &&
    confidence !== "medium" &&
    confidence !== "high"
  ) {
    return {
      odometerKm,
      confidence: "low",
    };
  }

  return {
    odometerKm,
    confidence,
  };
};

export const extractOdometerFromImage = async ({
  apiKey,
  buffer,
  fileName,
  mimeType,
  model,
}: ExtractOdometerFromImageInput) => {
  if (!apiKey) {
    throw new OdometerImageError(
      "not_configured",
      "Odometer image reading is not configured.",
    );
  }

  const base64Image = buffer.toString("base64");
  const prompt = [
    "Read the current vehicle odometer from this dashboard photo.",
    "Return only JSON with this exact shape:",
    '{"odometerKm": 123456, "confidence": "low|medium|high"}',
    "Use kilometers. If the display is unreadable, return odometerKm as null.",
    `Original file name: ${fileName}`,
  ].join("\n");

  let response: Response;

  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
              {
                type: "input_image",
                image_url: `data:${mimeType};base64,${base64Image}`,
              },
            ],
          },
        ],
      }),
    });
  } catch {
    throw new OdometerImageError(
      "request_failed",
      "Odometer image reading request failed.",
    );
  }

  let body: ResponsesApiBody | undefined;

  try {
    body = (await response.json()) as ResponsesApiBody;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new OdometerImageError(
      "request_failed",
      body?.error?.message ?? "Odometer image reading request failed.",
    );
  }

  return parseOdometerReading(body ? getOutputText(body) : "");
};
