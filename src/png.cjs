/* ==========================================================================
   PNG em Node puro — ler e gravar, sem dependência nenhuma.

   Por que existe: as ferramentas de imagem do Windows já cobraram caro neste
   conjunto de projetos. O GDI+ do PowerShell mede texto com uma métrica e
   desenha com outra, e o interpretador confunde `$D` com `$d` porque não
   diferencia maiúscula de minúscula — um dado inteiro sumiu assim. Aqui não há
   camada nenhuma: `zlib` vem com o Node, o resto é aritmética de bytes.

   Cobre o que este projeto usa: profundidade de 8 bits, cor verdadeira com e
   sem transparência, tons de cinza e paleta. Entrelaçado (Adam7) não — é raro,
   e decodificar errado em silêncio seria pior que recusar.
   ========================================================================== */
"use strict";

const zlib = require("node:zlib");
const fs = require("node:fs");

const ASSINATURA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/* Tabela do CRC-32, a mesma que o formato exige. Calculada uma vez. */
const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --------------------------------------------------------------- LEITURA */

function lerPng(caminho) {
  const d = fs.readFileSync(caminho);
  if (!d.subarray(0, 8).equals(ASSINATURA)) throw new Error("não é um PNG");

  let largura = 0, altura = 0, bits = 0, tipoCor = 0, entrelacado = 0;
  let paleta = null, transparencia = null;
  const pedacos = [];

  let p = 8;
  while (p < d.length) {
    const tam = d.readUInt32BE(p);
    const tipo = d.toString("ascii", p + 4, p + 8);
    const corpo = d.subarray(p + 8, p + 8 + tam);

    if (tipo === "IHDR") {
      largura = corpo.readUInt32BE(0);
      altura = corpo.readUInt32BE(4);
      bits = corpo[8];
      tipoCor = corpo[9];
      entrelacado = corpo[12];
    } else if (tipo === "PLTE") paleta = Buffer.from(corpo);
    else if (tipo === "tRNS") transparencia = Buffer.from(corpo);
    else if (tipo === "IDAT") pedacos.push(Buffer.from(corpo));
    else if (tipo === "IEND") break;

    p += 12 + tam;                                   // tamanho + tipo + corpo + crc
  }

  if (bits !== 8) throw new Error(`profundidade ${bits} bits não suportada (só 8)`);
  if (entrelacado) throw new Error("PNG entrelaçado não suportado");

  const canais = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[tipoCor];
  if (!canais) throw new Error(`tipo de cor ${tipoCor} desconhecido`);

  const cru = zlib.inflateSync(Buffer.concat(pedacos));
  const bpp = canais;                                // bytes por pixel (8 bits/canal)
  const passo = largura * bpp;
  const linhas = Buffer.alloc(altura * passo);

  /* Desfaz os filtros. Cada linha começa com um byte dizendo qual filtro o
     codificador usou; sem desfazer na ordem certa a imagem vira ruído. */
  let off = 0;
  for (let y = 0; y < altura; y++) {
    const filtro = cru[off++];
    const linha = cru.subarray(off, off + passo); off += passo;
    const destino = linhas.subarray(y * passo, (y + 1) * passo);
    const acima = y > 0 ? linhas.subarray((y - 1) * passo, y * passo) : null;

    for (let x = 0; x < passo; x++) {
      const a = x >= bpp ? destino[x - bpp] : 0;     // pixel à esquerda
      const b = acima ? acima[x] : 0;                // pixel acima
      const c = acima && x >= bpp ? acima[x - bpp] : 0; // acima e à esquerda
      let v = linha[x];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filtro !== 0) throw new Error(`filtro ${filtro} inválido na linha ${y}`);
      destino[x] = v & 0xff;
    }
  }

  /* Normaliza tudo para RGBA — quem usa não precisa saber de paleta. */
  const rgba = Buffer.alloc(largura * altura * 4);
  for (let i = 0, n = largura * altura; i < n; i++) {
    let r, g, b, a = 255;
    const s = i * bpp;
    if (tipoCor === 0) { r = g = b = linhas[s]; }
    else if (tipoCor === 4) { r = g = b = linhas[s]; a = linhas[s + 1]; }
    else if (tipoCor === 2) { r = linhas[s]; g = linhas[s + 1]; b = linhas[s + 2]; }
    else if (tipoCor === 6) { r = linhas[s]; g = linhas[s + 1]; b = linhas[s + 2]; a = linhas[s + 3]; }
    else {                                            // paleta
      const idx = linhas[s];
      r = paleta[idx * 3]; g = paleta[idx * 3 + 1]; b = paleta[idx * 3 + 2];
      if (transparencia && idx < transparencia.length) a = transparencia[idx];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }

  return { largura, altura, rgba };
}

/* --------------------------------------------------------------- ESCRITA */

function pedaco(tipo, corpo) {
  const cab = Buffer.alloc(8);
  cab.writeUInt32BE(corpo.length, 0);
  cab.write(tipo, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([cab.subarray(4), corpo])), 0);
  return Buffer.concat([cab, corpo, crc]);
}

function gravarPng(caminho, { largura, altura, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // cor verdadeira com transparência
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  /* Filtro 0 em todas as linhas. Escolher filtro por linha renderia arquivo
     menor, mas aqui o que importa é ser obviamente correto. */
  const passo = largura * 4;
  const cru = Buffer.alloc(altura * (passo + 1));
  for (let y = 0; y < altura; y++) {
    cru[y * (passo + 1)] = 0;
    rgba.copy(cru, y * (passo + 1) + 1, y * passo, (y + 1) * passo);
  }

  fs.writeFileSync(caminho, Buffer.concat([
    ASSINATURA,
    pedaco("IHDR", ihdr),
    pedaco("IDAT", zlib.deflateSync(cru, { level: 9 })),
    pedaco("IEND", Buffer.alloc(0)),
  ]));
}

module.exports = { lerPng, gravarPng, crc32 };
