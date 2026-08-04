/* ==========================================================================
   Favicon a partir do logotipo, sem ferramenta externa.

   POR QUE RECORTAR E NÃO ENCOLHER O LOGOTIPO INTEIRO: a 16 pixels, "Borda
   Tudo" com a máquina em cima vira três borrões cinzas. O que sobrevive nesse
   tamanho é UM símbolo — e o mais honesto é a própria letra da marca, com o
   traço de bordado que ela já tem. Recortar não altera o logotipo; encolher
   até ficar ilegível, sim, na prática.

   O ICO leva três tamanhos: 16 (aba), 32 (favoritos) e 48 (atalho na área de
   trabalho). Um só tamanho força o sistema a redimensionar, e o resultado é
   sempre pior que redimensionar aqui, com filtro de área.

   Uso:  node src/gerar-favicon.cjs
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { lerPng, gravarPng, crc32 } = require("./png.cjs");

const RAIZ = path.join(__dirname, "..");
const ORIGEM = path.join(RAIZ, "assets/img/logo-transparente.png");

/* Região do "B" no logotipo de 657x481, medida na própria imagem. */
const CORTE = { x: 54, y: 142, lado: 122 };
const TAMANHOS = [16, 32, 48];
const FUNDO = [13, 18, 64];   // --tinta-fundo: o "B" é escuro e some sobre aba clara

const origem = lerPng(ORIGEM);

/* Recorte quadrado, já achatado sobre o marinho. Favicon com transparência
   fica invisível em aba de tema escuro num navegador e em tema claro noutro —
   fundo próprio é mais previsível que torcer pelo tema de quem visita. */
function recortar() {
  const { x, y, lado } = CORTE;
  const saida = Buffer.alloc(lado * lado * 4);
  for (let j = 0; j < lado; j++) {
    for (let i = 0; i < lado; i++) {
      const si = ((y + j) * origem.largura + (x + i)) * 4;
      const di = (j * lado + i) * 4;
      const a = origem.rgba[si + 3] / 255;
      for (let c = 0; c < 3; c++) {
        saida[di + c] = Math.round(origem.rgba[si + c] * a + FUNDO[c] * (1 - a));
      }
      saida[di + 3] = 255;
    }
  }
  return { largura: lado, altura: lado, rgba: saida };
}

/* Redução por MÉDIA DE ÁREA, não por amostragem.
   Pegar "o pixel mais próximo" a 16px descarta 98% da informação e transforma
   a serrilha do traço em ruído. A média preserva a forma da letra. */
function reduzir(img, destino) {
  const escala = img.largura / destino;
  const saida = Buffer.alloc(destino * destino * 4);
  for (let y = 0; y < destino; y++) {
    for (let x = 0; x < destino; x++) {
      const x0 = Math.floor(x * escala), x1 = Math.min(img.largura, Math.ceil((x + 1) * escala));
      const y0 = Math.floor(y * escala), y1 = Math.min(img.altura, Math.ceil((y + 1) * escala));
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = y0; j < y1; j++) {
        for (let i = x0; i < x1; i++) {
          const s = (j * img.largura + i) * 4;
          r += img.rgba[s]; g += img.rgba[s + 1]; b += img.rgba[s + 2]; n++;
        }
      }
      const d = (y * destino + x) * 4;
      saida[d] = Math.round(r / n); saida[d + 1] = Math.round(g / n);
      saida[d + 2] = Math.round(b / n); saida[d + 3] = 255;
    }
  }
  return { largura: destino, altura: destino, rgba: saida };
}

/* PNG em memória, para entrar no ICO sem passar pelo disco. */
function pngEmMemoria({ largura, altura, rgba }) {
  const pedaco = (tipo, corpo) => {
    const cab = Buffer.alloc(8);
    cab.writeUInt32BE(corpo.length, 0);
    cab.write(tipo, 4, "ascii");
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(Buffer.concat([cab.subarray(4), corpo])), 0);
    return Buffer.concat([cab, corpo, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const passo = largura * 4;
  const cru = Buffer.alloc(altura * (passo + 1));
  for (let y = 0; y < altura; y++) {
    cru[y * (passo + 1)] = 0;
    rgba.copy(cru, y * (passo + 1) + 1, y * passo, (y + 1) * passo);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pedaco("IHDR", ihdr),
    pedaco("IDAT", zlib.deflateSync(cru, { level: 9 })),
    pedaco("IEND", Buffer.alloc(0)),
  ]);
}

const quadrado = recortar();
const imagens = TAMANHOS.map((t) => ({ tamanho: t, png: pngEmMemoria(reduzir(quadrado, t)) }));

/* Empacota em ICO. O cabeçalho tem 6 bytes, cada entrada 16, e as imagens vêm
   depois — o deslocamento de cada uma só existe depois de somar tudo. */
const cabecalho = Buffer.alloc(6);
cabecalho.writeUInt16LE(0, 0);                 // reservado
cabecalho.writeUInt16LE(1, 2);                 // 1 = ícone
cabecalho.writeUInt16LE(imagens.length, 4);

let deslocamento = 6 + imagens.length * 16;
const entradas = imagens.map(({ tamanho, png }) => {
  const e = Buffer.alloc(16);
  e[0] = tamanho === 256 ? 0 : tamanho;         // 0 significa 256 no formato
  e[1] = tamanho === 256 ? 0 : tamanho;
  e[2] = 0; e[3] = 0;                           // sem paleta, reservado
  e.writeUInt16LE(1, 4);                        // planos
  e.writeUInt16LE(32, 6);                       // bits por pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(deslocamento, 12);
  deslocamento += png.length;
  return e;
});

fs.writeFileSync(path.join(RAIZ, "favicon.ico"),
  Buffer.concat([cabecalho, ...entradas, ...imagens.map((i) => i.png)]));

/* Ampliação para conferência: favicon não se confere por tamanho de arquivo.
   Cada tamanho aparece ampliado 8x, com o 16 à esquerda. */
const LUPA = 8;
const larguraFolha = TAMANHOS.reduce((a, t) => a + t * LUPA + 12, 12);
const alturaFolha = 48 * LUPA + 24;
const folha = Buffer.alloc(larguraFolha * alturaFolha * 4);
for (let i = 0; i < larguraFolha * alturaFolha; i++) {
  folha[i * 4] = 247; folha[i * 4 + 1] = 245; folha[i * 4 + 2] = 242; folha[i * 4 + 3] = 255;
}
let cursor = 12;
for (const t of TAMANHOS) {
  const pequeno = reduzir(quadrado, t);
  for (let y = 0; y < t * LUPA; y++) {
    for (let x = 0; x < t * LUPA; x++) {
      const s = (((y / LUPA) | 0) * t + ((x / LUPA) | 0)) * 4;
      const d = ((y + 12) * larguraFolha + (x + cursor)) * 4;
      folha[d] = pequeno.rgba[s]; folha[d + 1] = pequeno.rgba[s + 1];
      folha[d + 2] = pequeno.rgba[s + 2]; folha[d + 3] = 255;
    }
  }
  cursor += t * LUPA + 12;
}
gravarPng(path.join(__dirname, "conferencia-favicon.png"), {
  largura: larguraFolha, altura: alturaFolha, rgba: folha });

const tam = fs.statSync(path.join(RAIZ, "favicon.ico")).size;
console.log(`  favicon.ico com ${TAMANHOS.join(", ")} px — ${(tam / 1024).toFixed(1)} KB`);
console.log(`  ABRA src/conferencia-favicon.png. A 16px ainda dá para reconhecer a letra?`);
