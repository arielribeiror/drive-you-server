import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  buffer: Buffer;
  command?: string;
  commandArgs?: string[];
  fileName: string;
  mimeType: string;
  model?: string;
  timeoutMs?: number;
};

type RembgResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

const DEFAULT_REMBG_COMMAND = "rembg";
const DEFAULT_REMBG_MODEL = "u2net";
const DEFAULT_REMBG_TIMEOUT_MS = 180_000;
const MAX_STDERR_LENGTH = 4_000;

const getInputExtension = (mimeType: string, fileName: string) => {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  const extension = path.extname(fileName).replace(".", "").toLowerCase();
  return extension === "png" || extension === "webp" ? extension : "jpg";
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const runRembg = async ({
  command,
  args,
  timeoutMs,
}: {
  command: string;
  args: string[];
  timeoutMs: number;
}) => {
  let stderr = "";
  let timedOut = false;

  const child = spawn(command, args, {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const result = await new Promise<RembgResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal, stderr });
      });
    });

    if (timedOut) {
      throw new BackgroundRemovalError(
        `rembg timed out after ${timeoutMs}ms.`,
        "provider_failed",
        504,
      );
    }

    return result;
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      throw new BackgroundRemovalError(
        `rembg command is not available: ${command}.`,
        "not_configured",
        503,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const removeVehicleBackground = async ({
  buffer,
  command = DEFAULT_REMBG_COMMAND,
  commandArgs = [],
  fileName,
  mimeType,
  model = DEFAULT_REMBG_MODEL,
  timeoutMs = DEFAULT_REMBG_TIMEOUT_MS,
}: RemoveVehicleBackgroundInput) => {
  if (!command.trim()) {
    throw new BackgroundRemovalError(
      "rembg command is not configured.",
      "not_configured",
      503,
    );
  }

  let tempDir: string | undefined;

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "drive-you-rembg-"));

    const inputPath = path.join(
      tempDir,
      `input.${getInputExtension(mimeType, fileName)}`,
    );
    const outputPath = path.join(tempDir, "output.png");

    await writeFile(inputPath, buffer);

    const args = [
      ...commandArgs,
      "i",
      "-m",
      model,
      inputPath,
      outputPath,
    ];
    const result = await runRembg({
      command,
      args,
      timeoutMs,
    });

    if (result.code !== 0) {
      throw new BackgroundRemovalError(
        `rembg failed with exit code ${result.code ?? "unknown"}${
          result.signal ? ` and signal ${result.signal}` : ""
        }.${result.stderr ? ` stderr: ${result.stderr.trim()}` : ""}`,
        "provider_failed",
        502,
      );
    }

    try {
      return await readFile(outputPath);
    } catch {
      throw new BackgroundRemovalError(
        "rembg completed without writing an output PNG.",
        "provider_failed",
        502,
      );
    }
  } finally {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
};
