export class BackgroundRemovalError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "provider_failed",
    readonly status = 500,
  ) {
    super(message);
  }
}

type RemoveVehicleBackgroundInput = {
  apiKey?: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

export const removeVehicleBackground = async ({
  apiKey,
  buffer,
  fileName,
  mimeType,
}: RemoveVehicleBackgroundInput) => {
  if (!apiKey) {
    throw new BackgroundRemovalError(
      "remove.bg API key is not configured.",
      "not_configured",
      503,
    );
  }

  const formData = new FormData();
  formData.append("size", "auto");
  formData.append(
    "image_file",
    new Blob([new Uint8Array(buffer)], { type: mimeType }),
    fileName,
  );

  const response = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new BackgroundRemovalError(
      `remove.bg failed with status ${response.status}.`,
      "provider_failed",
      response.status,
    );
  }

  return Buffer.from(await response.arrayBuffer());
};
