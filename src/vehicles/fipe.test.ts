import { describe, expect, it, vi } from "vitest";

import {
  buildFipeValuation,
  FipeClient,
  FipeClientError,
  getConfidentAutomaticCandidate,
  isFipeCacheFresh,
  parseBrazilianPriceToCents,
  priceHistoryFromDetail,
  resolveFipeCandidates,
  scoreFipeModelMatch,
} from "./fipe.js";

describe("fipe helpers", () => {
  it("parses Brazilian currency prices into cents", () => {
    expect(parseBrazilianPriceToCents("R$ 83.200,00")).toBe(8_320_000);
    expect(parseBrazilianPriceToCents("R$ 1.234,56")).toBe(123_456);
  });

  it("scores model matches against CRLV brand/model text", () => {
    expect(
      scoreFipeModelMatch(
        "CHEVROLET/ONIX 1.0 TURBO",
        "GM - Chevrolet",
        "ONIX Hatch LT 1.0 12V TB Flex 5p Mec.",
      ),
    ).toBeGreaterThan(0.7);
  });

  it("builds a 12-month valuation and variation from cached prices", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const valuation = buildFipeValuation(
      Array.from({ length: 13 }, (_, index) => ({
        fetchedAt: now,
        priceCents: 8_000_000 + index * 10_000,
        referenceCode: String(300 + index),
        referenceMonth: `mes ${index}`,
      })),
    );

    expect(valuation?.history).toHaveLength(12);
    expect(valuation?.currentPriceCents).toBe(8_120_000);
    expect(valuation?.variationDirection).toBe("up");
    expect(valuation?.variationPercent).toBeGreaterThan(1);
  });

  it("detects fresh and stale FIPE cache windows", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");

    expect(
      isFipeCacheFresh(
        [
          {
            fetchedAt: new Date("2026-07-14T01:00:00.000Z"),
            priceCents: 1,
            referenceCode: "1",
            referenceMonth: "julho de 2026",
          },
        ],
        now,
      ),
    ).toBe(true);
    expect(
      isFipeCacheFresh(
        [
          {
            fetchedAt: new Date("2026-07-12T01:00:00.000Z"),
            priceCents: 1,
            referenceCode: "1",
            referenceMonth: "julho de 2026",
          },
        ],
        now,
      ),
    ).toBe(false);
  });
});

describe("fipe client", () => {
  it("sends the optional subscription token and parses history", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          brand: "VW - VolksWagen",
          codeFipe: "005340-6",
          fuel: "Diesel",
          fuelAcronym: "D",
          model: "AMAROK High.CD 2.0 16V TDI 4x4 Dies. Aut",
          modelYear: 2014,
          price: "R$ 100.000,00",
          priceHistory: [
            {
              month: "junho de 2026",
              price: "R$ 99.000,00",
              reference: "334",
            },
          ],
          referenceMonth: "julho de 2026",
          vehicleType: 1,
        }),
      ),
    );
    const client = new FipeClient({
      baseUrl: "https://fipe.example/api/v2",
      fetchImpl,
      timeoutMs: 1000,
      token: "test-token",
    });

    const detail = await client.getVehicleHistoryByFipeCode(
      "cars",
      "005340-6",
      "2014-3",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fipe.example/api/v2/cars/005340-6/years/2014-3/history",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Subscription-Token": "test-token",
        }),
      }),
    );
    expect(priceHistoryFromDetail(detail)).toEqual([
      {
        priceCents: 9_900_000,
        referenceCode: "334",
        referenceMonth: "junho de 2026",
      },
    ]);
  });

  it("maps rate limiting to a typed FIPE error", async () => {
    const client = new FipeClient({
      baseUrl: "https://fipe.example/api/v2",
      fetchImpl: async () => new Response("{}", { status: 429 }),
      timeoutMs: 1000,
    });

    await expect(client.getBrands("cars")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });
});

describe("fipe automatic resolution", () => {
  it("resolves one confident vehicle candidate from CRLV model text", async () => {
    const api = {
      getBrands: vi.fn(async () => [
        { code: "23", name: "GM - Chevrolet" },
        { code: "59", name: "VW - VolksWagen" },
      ]),
      getModels: vi.fn(async () => [
        { code: "100", name: "ONIX Hatch LT 1.0 12V TB Flex 5p Mec." },
        { code: "200", name: "CRUZE LT 1.8 16V FlexPower 4p Aut." },
      ]),
      getVehicleDetailByModel: vi.fn(async () => ({
        brand: "GM - Chevrolet",
        codeFipe: "004278-1",
        fuel: "Gasolina",
        fuelAcronym: "G",
        model: "ONIX Hatch LT 1.0 12V TB Flex 5p Mec.",
        modelYear: 2023,
        price: "R$ 83.200,00",
        priceHistory: [],
        referenceMonth: "julho de 2026",
        vehicleType: 1,
      })),
      getYearsByModel: vi.fn(async () => [
        { code: "2023-1", name: "2023 Gasolina" },
      ]),
    };

    const candidates = await resolveFipeCandidates(api, {
      brandModel: "CHEVROLET/ONIX 1.0 TURBO",
      manufactureYear: 2022,
      modelYear: 2023,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      codeFipe: "004278-1",
      confidence: "high",
      priceCents: 8_320_000,
    });
    expect(getConfidentAutomaticCandidate(candidates)?.codeFipe).toBe(
      "004278-1",
    );
  });

  it("does not auto-link ambiguous candidates", () => {
    expect(
      getConfidentAutomaticCandidate([
        {
          brandCode: "1",
          brandName: "Brand",
          codeFipe: "111111-1",
          confidence: "high",
          displayName: "A",
          modelCode: "10",
          modelName: "A",
          modelYear: 2023,
          priceCents: 1,
          score: 0.75,
          vehicleType: "cars",
          yearId: "2023-1",
          yearName: "2023 Gasolina",
        },
        {
          brandCode: "1",
          brandName: "Brand",
          codeFipe: "222222-2",
          confidence: "high",
          displayName: "B",
          modelCode: "20",
          modelName: "B",
          modelYear: 2023,
          priceCents: 1,
          score: 0.7,
          vehicleType: "cars",
          yearId: "2023-1",
          yearName: "2023 Gasolina",
        },
      ]),
    ).toBeNull();
  });

  it("throws typed errors for invalid prices", () => {
    expect(() => parseBrazilianPriceToCents("sob consulta")).toThrow(
      FipeClientError,
    );
  });
});
