import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BackgroundRemovalError,
  removeVehicleBackground,
} from "./background-removal.js";

describe("vehicle background removal", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "drive-you-rembg-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it("returns the generated PNG bytes from a rembg-compatible command", async () => {
    const mockCommandPath = path.join(tempDir, "mock-rembg.mjs");
    await writeFile(
      mockCommandPath,
      [
        'import { copyFile } from "node:fs/promises";',
        "const inputPath = process.argv.at(-2);",
        "const outputPath = process.argv.at(-1);",
        "await copyFile(inputPath, outputPath);",
      ].join("\n"),
    );

    const result = await removeVehicleBackground({
      buffer: Buffer.from("image-bytes"),
      command: process.execPath,
      commandArgs: [mockCommandPath],
      fileName: "vehicle.jpg",
      mimeType: "image/jpeg",
      model: "u2netp",
      timeoutMs: 5_000,
    });

    expect(result).toEqual(Buffer.from("image-bytes"));
  });

  it("reports a missing rembg command as not configured", async () => {
    await expect(
      removeVehicleBackground({
        buffer: Buffer.from("image-bytes"),
        command: "drive-you-missing-rembg-command",
        fileName: "vehicle.jpg",
        mimeType: "image/jpeg",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "not_configured",
      status: 503,
    } satisfies Partial<BackgroundRemovalError>);
  });

  it("reports non-zero rembg exits as provider failures", async () => {
    const mockCommandPath = path.join(tempDir, "failing-rembg.mjs");
    await writeFile(
      mockCommandPath,
      [
        'process.stderr.write("model failed");',
        "process.exit(7);",
      ].join("\n"),
    );

    await expect(
      removeVehicleBackground({
        buffer: Buffer.from("image-bytes"),
        command: process.execPath,
        commandArgs: [mockCommandPath],
        fileName: "vehicle.png",
        mimeType: "image/png",
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      code: "provider_failed",
      status: 502,
    } satisfies Partial<BackgroundRemovalError>);
  });
});
