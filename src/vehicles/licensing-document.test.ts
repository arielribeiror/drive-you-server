import { describe, expect, it } from "vitest";

import { parseLicensingDocumentText } from "./licensing-document.js";

describe("licensing document parser", () => {
  it("extracts vehicle and owner fields from CRLV-like text", () => {
    const parsed = parseLicensingDocumentText(`
      CERTIFICADO DE REGISTRO E LICENCIAMENTO DE VEICULO
      CODIGO RENAVAM
      01234567890
      PLACA
      ABC1D23
      MARCA / MODELO / VERSAO
      CHEVROLET/ONIX 1.0 TURBO
      ANO FABRICACAO
      2022
      ANO MODELO
      2023
      NOME DO PROPRIETARIO
      MARIA DA SILVA
      CPF / CNPJ
      123.456.789-00
    `);

    expect(parsed).toMatchObject({
      plate: "ABC1D23",
      renavam: "01234567890",
      brandModel: "CHEVROLET/ONIX 1.0 TURBO",
      manufactureYear: 2022,
      modelYear: 2023,
      ownerName: "MARIA DA SILVA",
      ownerDocumentMasked: "***.456.789-**",
      confidence: "high",
      missingFields: [],
    });
  });

  it("supports old plate format and reports missing optional fields", () => {
    const parsed = parseLicensingDocumentText(`
      PLACA: ABC1234
      CODIGO RENAVAM: 123456789
    `);

    expect(parsed.plate).toBe("ABC1234");
    expect(parsed.renavam).toBe("123456789");
    expect(parsed.confidence).toBe("medium");
    expect(parsed.missingFields).toEqual(["brandModel", "ownerName"]);
  });

  it("extracts the official CRLV-e fields even when labels are grouped", () => {
    const parsed = parseLicensingDocumentText(`
      CERTIFICADO DE REGISTRO E LICENCIAMENTO DE VEICULO - DIGITAL
      CODIGO RENAVAM
      00405850670
      PLACA EXERCICIO
      EZV3J20 2021
      ANO FABRICACAO ANO MODELO
      2011 2012
      NUMERO DO CRV
      213240100290
      CODIGO DE SEGURANCA DO CLA
      50845888824
      MARCA / MODELO / VERSAO I/PEUGEOT 307 PREMIUM AT
      ESPECIE / TIPO
      PASSAGEIRO AUTOMOVEL
      NOME CPF / CNPJ
      ARIEL RIBEIRO RODRIGUES DA CUNHA 412.372.618-64
      MENSAGENS DENATRAN
    `);

    expect(parsed).toMatchObject({
      plate: "EZV3J20",
      renavam: "00405850670",
      manufactureYear: 2011,
      modelYear: 2012,
      brandModel: "I/PEUGEOT 307 PREMIUM AT",
      ownerName: "ARIEL RIBEIRO RODRIGUES DA CUNHA",
      ownerDocumentMasked: "***.372.618-**",
    });
  });

  it("ignores promotional copy when CRLV-e labels and values are separate blocks", () => {
    const parsed = parseLicensingDocumentText(`
      CERTIFICADO DE REGISTRO E LICENCIAMENTO DE VEICULO - DIGITAL
      CODIGO RENAVAM
      ANO FABRICACAO
      ANO MODELO
      PLACA EXERCICIO
      NOME
      LOCAL DATA
      CPF / CNPJ
      MENSAGENS SENATRAN
      NUMERO DO CRV
      MARCA / MODELO / VERSAO
      Na Carteira Digital de Transito voce tem acesso ao CRLV e ainda ganha
      desconto nas infracoes, alem de muitos outros servicos de transito.
      Leia o QR Code e baixe agora.
      01126670810
      FXQ6G03 2025
      2016 2017
      244185723679
      42440208217 ***
      I/FORD FOCUS TI AT 2.0HC
      PASSAGEIRO AUTOMOVEL
      NAO APLICAVEL
      MARIA DA SILVA
      123.456.789-00
      SAO JOSE DOS CAMPOS SP 18/01/2025
    `);

    expect(parsed).toMatchObject({
      plate: "FXQ6G03",
      renavam: "01126670810",
      manufactureYear: 2016,
      modelYear: 2017,
      brandModel: "I/FORD FOCUS TI AT 2.0HC",
      ownerName: "MARIA DA SILVA",
      ownerDocumentMasked: "***.456.789-**",
      confidence: "high",
      missingFields: [],
    });
  });

  it("extracts owner name when the PDF joins owner and document labels", () => {
    const parsed = parseLicensingDocumentText(`
      NOME CPF / CNPJ
      ARIEL RIBEIRO RODRIGUES DA CUNHA 412.372.618-64
      LOCAL DATA
      SAO JOSE DOS CAMPOS SP 01/10/2021
    `);

    expect(parsed.ownerName).toBe("ARIEL RIBEIRO RODRIGUES DA CUNHA");
    expect(parsed.ownerDocumentMasked).toBe("***.372.618-**");
  });

  it("extracts owner name when CRLV-e column labels are merged", () => {
    const parsed = parseLicensingDocumentText(`
      CARROCERIA NOME CPF / CNPJ LOCAL DATA
      NAO APLICAVEL
      ARIEL RIBEIRO RODRIGUES DA CUNHA 412.372.618-64 SAO JOSE DOS CAMPOS SP 01/10/2021
    `);

    expect(parsed.ownerName).toBe("ARIEL RIBEIRO RODRIGUES DA CUNHA");
    expect(parsed.ownerDocumentMasked).toBe("***.372.618-**");
  });

  it("extracts owner name near the owner document when labels are out of order", () => {
    const parsed = parseLicensingDocumentText(`
      CARROCERIA NOME CPF / CNPJ
      NAO APLICAVEL
      ARIEL RIBEIRO RODRIGUES DA CUNHA
      412.372.618-64
      LOCAL DATA
      SAO JOSE DOS CAMPOS SP 01/10/2021
    `);

    expect(parsed.ownerName).toBe("ARIEL RIBEIRO RODRIGUES DA CUNHA");
    expect(parsed.ownerDocumentMasked).toBe("***.372.618-**");
  });

  it("extracts owner name when previous field values share the owner line", () => {
    const parsed = parseLicensingDocumentText(`
      CARROCERIA NOME CPF / CNPJ
      NAO APLICAVEL ARIEL RIBEIRO RODRIGUES DA CUNHA 412.372.618-64
      LOCAL DATA
      SAO JOSE DOS CAMPOS SP 01/10/2021
    `);

    expect(parsed.ownerName).toBe("ARIEL RIBEIRO RODRIGUES DA CUNHA");
    expect(parsed.ownerDocumentMasked).toBe("***.372.618-**");
  });

  it("ignores licensing year when CRLV-e year labels are extracted together", () => {
    const parsed = parseLicensingDocumentText(`
      CODIGO RENAVAM PLACA EXERCICIO ANO FABRICACAO ANO MODELO
      00405850670 EZV3J20 2021 2011 2012
      MARCA / MODELO / VERSAO I/PEUGEOT 307 PREMIUM AT
    `);

    expect(parsed.manufactureYear).toBe(2011);
    expect(parsed.modelYear).toBe(2012);
  });

  it("does not treat instruction text as the owner name", () => {
    const parsed = parseLicensingDocumentText(`
      NOME
      Para sua comodidade, voce pode acessar este servico pelo portal
      CPF / CNPJ
      412.372.618-64
    `);

    expect(parsed.ownerName).toBeNull();
  });

  it("does not treat the issue city as the owner name", () => {
    const parsed = parseLicensingDocumentText(`
      NOME CPF / CNPJ
      LOCAL DATA
      SAO JOSE DOS CAMPOS SP 01/10/2021
    `);

    expect(parsed.ownerName).toBeNull();
  });

  it("does not treat ATPV-e field labels as extracted values", () => {
    const parsed = parseLicensingDocumentText(`
      AUTORIZACAO PARA TRANSFERENCIA DE PROPRIEDADE DO VEICULO
      CODIGO RENAVAM
      01234567890
      PLACA
      SVI0A15
      MARCA / MODELO / VERSAO
      NUMERO CRV
      HODOMETRO
      VALOR
      NOME DO PROPRIETARIO
      Autorizo o orgao ou entidade executivo de transito dos Estados ou do Distrito Federal, transferir
      E-MAIL
      TELEFONE
    `);

    expect(parsed.plate).toBe("SVI0A15");
    expect(parsed.renavam).toBe("01234567890");
    expect(parsed.brandModel).toBeNull();
    expect(parsed.ownerName).toBeNull();
    expect(parsed.missingFields).toEqual(["brandModel", "ownerName"]);
  });
});
