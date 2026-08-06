/* ==========================================================================
   Dados de TESTE — para o sistema ter o que mostrar antes de a fábrica
   cadastrar o que é dela.

       node sql/03-dados-de-teste.cjs                mostra o que faria
       node sql/03-dados-de-teste.cjs --gravar       grava
       node sql/03-dados-de-teste.cjs --limpar       APAGA os cadastros
       node sql/03-dados-de-teste.cjs --limpar-tudo  APAGA TAMBÉM a produção

   DE ONDE VIERAM ESTES NOMES

   Clientes, desenhos e mercadorias foram LIDOS DAS DUAS FOTOS das planilhas de
   papel. São o vocabulário real da fábrica — "RECIFE1 com 9484 pontos" é o
   exemplo que o próprio Eduardo mandou. Servem para o sistema ser testado com
   dados que se parecem com a realidade, e não com "Cliente 1, Desenho A".

   As MÁQUINAS são inventadas (MAQ 01 a 04): as fotos não dizem quantas
   existem nem como vocês as chamam. Renomeie na tela.

   AS PONTUAÇÕES SÃO CHUTE, menos as duas das fotos. Bordado se cobra por
   ponto: pontuação errada vira nota errada. Confira TODAS antes de faturar
   qualquer coisa em cima delas.

   IDEMPOTENTE: só insere o que ainda não existe. E `--limpar` remove
   exatamente o que este arquivo criou, para quando os dados de verdade
   chegarem — sem levar junto nada que a fábrica tenha cadastrado depois.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Q, carregarAmbiente } = require("./../pg.js");

carregarAmbiente(path.join(__dirname, ".."));

const GRAVAR = process.argv.includes("--gravar");
const LIMPAR_TUDO = process.argv.includes("--limpar-tudo");
const LIMPAR = LIMPAR_TUDO || process.argv.includes("--limpar");

/* Lidos da segunda foto (a folha do Eduardo) e da primeira (a do operador). */
const CLIENTES = ["Marcela", "Nessia", "Malcondes", "Jamy", "Marcia"];

const MERCADORIAS = [
  "Camisa", "Calça", "Bolso", "Jaleco", "Manga", "Aba",
  "Blusa", "Coletão", "Colete", "Avental", "Margas",
];

/* Cores das abas que o Eduardo citou, mais as básicas. */
const CORES = ["Preta", "Branca", "Azul", "Bege", "Marrom", "Cinza", "Vermelha", "Verde", "Amarela"];

const MAQUINAS = [
  ["MAQ 01", 6], ["MAQ 02", 6], ["MAQ 03", 4], ["MAQ 04", 1],
];

/* [cliente, desenho, pontuação]. As duas primeiras são das fotos; o resto tem
   pontuação chutada — ver o aviso no cabeçalho. */
const DESENHOS = [
  ["Marcela",   "RECIFE1",      9484],   // da foto
  ["Marcela",   "RECIFE2",     34422],   // da foto
  ["Nessia",    "WA MORELI 77", 12500],
  ["Nessia",    "JALECO 3P",     4800],
  ["Malcondes", "ASCES",         7300],
  ["Malcondes", "CORECT1",      15200],
  ["Jamy",      "EDEMO2",        6100],
  ["Jamy",      "CONTINUM",      9900],
  ["Marcia",    "VERSENI",      11800],
  ["Marcia",    "BELMONTE",     18400],
  ["Marcia",    "PERU PE",       5200],
];

const TUDO_DE_TESTE = {
  clientes: CLIENTES,
  mercadorias: MERCADORIAS,
  cores: CORES,
  maquinas: MAQUINAS.map((m) => m[0]),
  desenhos: DESENHOS.map((d) => d[1]),
};

(async () => {
  if (LIMPAR) {
    /* Ordem importa: desenho aponta para cliente. E só apaga o que NÃO está
       em uso — uma ficha de produção real referenciando um destes cadastros
       significa que ele virou dado de verdade, e aí não é mais "de teste". */
    const emUso = await Q.get(`SELECT
      (SELECT COUNT(*) FROM fichas) f, (SELECT COUNT(*) FROM lotes) l`);

    if ((Number(emUso.f) || Number(emUso.l)) && !LIMPAR_TUDO) {
      console.log(`\n  ✖ existem ${emUso.f} ficha(s) e ${emUso.l} lote(s) no banco.`);
      console.log("    Estes cadastros podem já estar em uso de verdade — não vou apagar.");
      console.log("    Se TUDO isso for produção de teste: --limpar-tudo\n");
      process.exitCode = 1;
      return;
    }

    if (LIMPAR_TUDO) {
      /* Zera a produção inteira, não só a que este arquivo criou: uma ficha
         aponta para cliente e desenho, e apagar o cadastro deixando a ficha
         quebraria a chave estrangeira. Ou vai tudo, ou não vai nada.

         É por isso que a ordem importa: ficha → lote → jornada. */
      console.log(`\n  ⚠  apagando ${emUso.f} ficha(s) e ${emUso.l} lote(s) — TODA a produção.`);
      await Q.run("DELETE FROM fichas");
      await Q.run("DELETE FROM lotes");
      await Q.run("DELETE FROM jornadas");
    }
    await Q.run("DELETE FROM desenhos WHERE nome = ANY(?)", TUDO_DE_TESTE.desenhos);
    await Q.run("DELETE FROM clientes WHERE nome = ANY(?)", TUDO_DE_TESTE.clientes);
    await Q.run("DELETE FROM mercadorias WHERE nome = ANY(?)", TUDO_DE_TESTE.mercadorias);
    await Q.run("DELETE FROM cores WHERE nome = ANY(?)", TUDO_DE_TESTE.cores);
    await Q.run("DELETE FROM maquinas WHERE nome = ANY(?)", TUDO_DE_TESTE.maquinas);
    console.log("\n  dados de teste removidos\n");
    return;
  }

  console.log(GRAVAR ? "\n  gravando…\n" : "\n  (ensaio — nada será gravado; use --gravar)\n");
  let novos = 0, jaTinha = 0;

  const inserir = async (tabela, colunas, valores, chave) => {
    const existe = await Q.get(`SELECT id FROM ${tabela} WHERE lower(nome) = lower(?)`, chave);
    if (existe) { jaTinha++; return existe.id; }
    novos++;
    if (!GRAVAR) return null;
    return Q.inserir(
      `INSERT INTO ${tabela} (${colunas.join(",")}) VALUES (${colunas.map(() => "?").join(",")}) RETURNING id`,
      ...valores);
  };

  for (const n of CLIENTES)    await inserir("clientes", ["nome"], [n], n);
  for (const n of MERCADORIAS) await inserir("mercadorias", ["nome"], [n], n);
  for (const n of CORES)       await inserir("cores", ["nome"], [n], n);
  for (const [n, cab] of MAQUINAS)
    await inserir("maquinas", ["nome", "cabecas", "token"], [n, cab, crypto.randomBytes(9).toString("base64url")], n);

  for (const [cliente, desenho, pontos] of DESENHOS) {
    const c = await Q.get("SELECT id FROM clientes WHERE lower(nome) = lower(?)", cliente);
    const ja = await Q.get("SELECT id FROM desenhos WHERE lower(nome) = lower(?)", desenho);
    if (ja) { jaTinha++; continue; }
    novos++;
    if (GRAVAR) await Q.run("INSERT INTO desenhos (cliente_id, nome, pontuacao) VALUES (?, ?, ?)",
      c ? c.id : null, desenho, pontos);
  }

  console.log(`  ${novos} registro(s) ${GRAVAR ? "criados" : "seriam criados"}` +
              (jaTinha ? `; ${jaTinha} já existiam` : ""));

  if (GRAVAR) {
    for (const t of ["clientes", "desenhos", "mercadorias", "cores", "maquinas"]) {
      const r = await Q.get(`SELECT COUNT(*) c FROM ${t}`);
      console.log(`    ${t.padEnd(12)} ${r.c}`);
    }
    console.log("\n  ATENÇÃO: as pontuações são CHUTE, menos RECIFE1 (9484) e RECIFE2 (34422),");
    console.log("  que vieram da foto. Bordado se cobra por ponto — confira TODAS antes de");
    console.log("  faturar em cima delas. As máquinas MAQ 01..04 são inventadas; renomeie.");
    console.log("\n  Para apagar tudo isto depois: node sql/03-dados-de-teste.cjs --limpar\n");
  } else {
    console.log("\n  Para gravar: node sql/03-dados-de-teste.cjs --gravar\n");
  }
})().catch((e) => {
  console.error("\n  ✖ " + String(e.message).split("\n")[0]);
  process.exit(1);
}).finally(() => Q.fechar());
