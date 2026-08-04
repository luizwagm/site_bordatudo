/* ==========================================================================
   Tira o fundo de toalha da logo, preservando tudo que é linha bordada.

   TRÊS TENTATIVAS ERRADAS ANTES DESTA. Ficam registradas porque cada uma
   parecia obviamente certa antes de rodar:

   1. "apagar o que for parecido com a cor da borda" — a moldura da imagem é
      quase branca (252) e a toalha é 235. A diferença estourou a tolerância e
      o alagamento morreu no primeiro passo: 26% de ~55% esperados.

   2. "apagar o que for claro e sem cor, pela SATURAÇÃO" — perto do branco o
      denominador da saturação HSL vai a zero, e um pixel de toalha (250,248,
      245) marca 0,34, acima de qualquer limiar razoável. Metade da toalha saiu
      e metade ficou: sobre fundo escuro virou chuvisco. Só apareceu ao OLHAR a
      imagem composta sobre marinho — nenhum número da execução acusou.

   3. "os vãos fechados das letras são toalha e devem sair" — ampliadas 5x, as
      áreas brancas dentro do "o" e das cabeças da máquina mostram direção de
      ponto e brilho de cetim: são linha branca BORDADA. Apagá-las abriria
      buraco no meio do logotipo.

   4. "então nenhuma região fechada sai" — também errado, e pelo motivo
      oposto. O laço da linha laranja cerca um pedaço de TOALHA, com a felpa
      em argolinhas bem visível na ampliação. Mantê-lo põe um oval branco no
      meio da arte quando a logo for para cima do marinho.

   O que funciona: CROMA ABSOLUTO (distância entre o maior e o menor canal),
   não saturação relativa — a toalha fica em 5, o marinho em 78, o laranja em
   168 —, somado à claridade, porque as sombras do marinho também têm croma
   baixo. Sai o que o alagamento alcança pela borda, mais as regiões fechadas
   que forem tecido — e tecido se reconhece por ser ao mesmo tempo mais claro
   e mais LISO que bordado, porque não tem sombra de ponto:

        interior do laço (toalha)   claridade 238-241   desvio  8-11
        vão de letra (bordado)      claridade 223-225   desvio 15-17
        cabeça da máquina (bordado) claridade 217-219   desvio 18-21

   As duas medidas concordam e sobra folga entre elas — é separação real, não
   limiar ajustado até dar certo.

   Uso:  node src/logo-transparente.cjs
   ========================================================================== */
"use strict";

const path = require("node:path");
const { lerPng, gravarPng } = require("./png.cjs");

const RAIZ = path.join(__dirname, "..");
const ORIGEM = path.join(RAIZ, "assets/img/logo.png");
const DESTINO = path.join(RAIZ, "assets/img/logo-transparente.png");

/* Medidos na própria imagem, não estimados:
   toalha  croma mediano  5, percentil 95 =  7
   marinho croma mediano 78
   laranja croma mediano 168                                                  */
const CROMA_MAX = 14;   // acima disto tem cor: é bordado
const CLARO_MIN = 180;  // abaixo disto é sombra de ponto, não tecido

const { largura, altura, rgba } = lerPng(ORIGEM);
const total = largura * altura;

const croma = new Uint8Array(total);
const luz = new Uint8Array(total);
for (let i = 0; i < total; i++) {
  const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  croma[i] = mx - mn;
  luz[i] = (mx + mn) >> 1;
}
const ehFundo = (p) => croma[p] < CROMA_MAX && luz[p] > CLARO_MIN;

/* Alagamento a partir das quatro bordas. Pilha explícita, não recursão: são
   316 mil pixels e a pilha de chamadas do Node estoura muito antes disso. */
const fundo = new Uint8Array(total);
const pilha = [];
for (let x = 0; x < largura; x++) { pilha.push(x); pilha.push((altura - 1) * largura + x); }
for (let y = 0; y < altura; y++) { pilha.push(y * largura); pilha.push(y * largura + largura - 1); }
while (pilha.length) {
  const p = pilha.pop();
  if (fundo[p] || !ehFundo(p)) continue;
  fundo[p] = 1;
  const x = p % largura, y = (p / largura) | 0;
  if (x > 0) pilha.push(p - 1);
  if (x < largura - 1) pilha.push(p + 1);
  if (y > 0) pilha.push(p - largura);
  if (y < altura - 1) pilha.push(p + largura);
}

/* Regiões fechadas: tecido cercado por arte, como o interior do laço da linha.
   Vale a pena separar de bordado branco, que também é claro e sem croma. */
const TECIDO_CLARO = 232;   // acima disto e liso: tecido
const TECIDO_LISO = 13;     // desvio da claridade; bordado passa de 14 por causa da sombra do ponto
const visto = new Uint8Array(total);
let fechadasApagadas = 0, fechadasMantidas = 0;
for (let inicio = 0; inicio < total; inicio++) {
  if (fundo[inicio] || visto[inicio] || !ehFundo(inicio)) continue;

  const regiao = [];
  const fila = [inicio]; visto[inicio] = 1;
  while (fila.length) {
    const p = fila.pop(); regiao.push(p);
    const x = p % largura, y = (p / largura) | 0;
    for (const q of [x > 0 ? p - 1 : -1, x < largura - 1 ? p + 1 : -1,
                     y > 0 ? p - largura : -1, y < altura - 1 ? p + largura : -1]) {
      if (q >= 0 && !visto[q] && ehFundo(q)) { visto[q] = 1; fila.push(q); }
    }
  }
  /* Região minúscula não tem textura mensurável — o desvio de 30 pixels é
     ruído, e decidir por ele seria sortear. Ficam. */
  if (regiao.length < 120) { fechadasMantidas += regiao.length; continue; }

  const media = regiao.reduce((a, p) => a + luz[p], 0) / regiao.length;
  const desvio = Math.sqrt(regiao.reduce((a, p) => a + (luz[p] - media) ** 2, 0) / regiao.length);
  if (media > TECIDO_CLARO && desvio < TECIDO_LISO) {
    for (const p of regiao) fundo[p] = 1;
    fechadasApagadas += regiao.length;
  } else fechadasMantidas += regiao.length;
}

/* Contorno macio. O recorte duro deixa um halo claro — herança da suavização
   da própria foto — que sobre fundo escuro vira contorno branco.

   A largura e o corte saíram de medição, não de tentativa. Distância do corte
   contra claridade, na imagem de origem:

        1 px do fundo   mediana 204   p90 235
        2 px do fundo   mediana  82   p75 212
        3 px do fundo   mediana  73

   Ou seja: o halo tem DOIS pixels, e a partir do terceiro já é arte. A
   primeira rampa que escrevi zerava só acima de 230 — o p90 — e deixava dois
   terços do halo de pé.

   A transparência cai com a CLARIDADE, não com o croma: as sombras do
   marinho têm croma 1 e seriam apagadas junto, abrindo o contorno das letras. */
const FAIXA = 2;
const HALO_CLARO = 215;   // daqui para cima, resto de tecido: some
const HALO_ESCURO = 165;  // daqui para baixo, sombra de ponto: fica inteira

const saida = Buffer.from(rgba);
let suavizados = 0;
for (let p = 0; p < total; p++) {
  if (fundo[p]) { saida[p * 4 + 3] = 0; continue; }
  const x = p % largura, y = (p / largura) | 0;

  let perto = false;
  for (let dy = -FAIXA; dy <= FAIXA && !perto; dy++) {
    for (let dx = -FAIXA; dx <= FAIXA; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= largura || ny >= altura) continue;
      if (fundo[ny * largura + nx]) { perto = true; break; }
    }
  }
  if (!perto) continue;

  const a = Math.max(0, Math.min(1, (HALO_CLARO - luz[p]) / (HALO_CLARO - HALO_ESCURO)));
  if (a < 1) { saida[p * 4 + 3] = Math.round(255 * a); suavizados++; }
}

gravarPng(DESTINO, { largura, altura, rgba: saida });

const apagados = fundo.reduce((a, b) => a + b, 0);
const pct = (n) => (n * 100 / total).toFixed(1) + "%";
console.log(`  fundo removido ......... ${pct(apagados)} da imagem`);
console.log(`  tecido fechado apagado . ${pct(fechadasApagadas)}  (interior do laço)`);
console.log(`  bordado preservado ..... ${pct(fechadasMantidas)}  (vãos de letra e máquina)`);
console.log(`  contorno suavizado ..... ${suavizados} pixels`);
console.log(`  gravado em assets/img/logo-transparente.png`);
console.log(`  confira com:  node src/conferir-logo.cjs`);
