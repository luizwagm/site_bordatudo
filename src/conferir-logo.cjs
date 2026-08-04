/* ==========================================================================
   Compõe a logo recortada sobre os dois fundos em que ela vai aparecer.

   Existe porque recorte de imagem NÃO SE CONFERE POR NÚMERO. A segunda
   tentativa do `logo-transparente.cjs` imprimiu percentuais plausíveis e
   deixou a toalha em chuvisco por cima do marinho — só apareceu ao olhar.

   Uso:  node src/conferir-logo.cjs     →  src/conferencia-logo.png
   ========================================================================== */
"use strict";

const path = require("node:path");
const { lerPng, gravarPng } = require("./png.cjs");

const RAIZ = path.join(__dirname, "..");
const MARINHO = [13, 18, 64];      // --tinta-fundo
const ALGODAO = [247, 245, 242];   // --algodao

const { largura, altura, rgba } = lerPng(path.join(RAIZ, "assets/img/logo-transparente.png"));

/* Empilhado, não dividido ao meio. A primeira versão partia a imagem em duas
   colunas — e o defeito que eu procurava (o interior do laço da linha) caía
   sempre na metade clara, onde ele é invisível. Cada fundo precisa da arte
   INTEIRA por cima. */
const FUNDOS = [MARINHO, ALGODAO];
const alturaTotal = altura * FUNDOS.length;
const saida = Buffer.alloc(largura * alturaTotal * 4);

FUNDOS.forEach(([fr, fg, fb], n) => {
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const i = (y * largura + x) * 4;
      const d = ((n * altura + y) * largura + x) * 4;
      const a = rgba[i + 3] / 255;
      saida[d] = Math.round(rgba[i] * a + fr * (1 - a));
      saida[d + 1] = Math.round(rgba[i + 1] * a + fg * (1 - a));
      saida[d + 2] = Math.round(rgba[i + 2] * a + fb * (1 - a));
      saida[d + 3] = 255;
    }
  }
});

gravarPng(path.join(RAIZ, "src/conferencia-logo.png"), { largura, altura: alturaTotal, rgba: saida });
console.log("  src/conferencia-logo.png — em cima sobre marinho, embaixo sobre algodão");
console.log("  ABRA O ARQUIVO. Procure halo branco, chuvisco e buraco no meio da arte.");
