/* ==========================================================================
   SUÍTE DO SITE — situação (no ar / em construção / em manutenção)

       node testar-site.cjs

   É a chave que decide se o site do cliente aparece ou não para o mundo.
   Errar aqui é o site sumir sem ninguém entender por quê, ou — pior — o site
   voltar sozinho quando não devia.

   Roda contra um BANCO DESCARTÁVEL (`SITE_DB`), numa porta própria. Não toca
   no `data/site.db` do cliente e não precisa da senha do painel: o banco de
   teste nasce com a senha padrão que o próprio servidor cria.
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const PORTA = Number(process.env.PORTA_TESTE_SITE) || 5198;
const BASE = `http://127.0.0.1:${PORTA}`;
const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), "bordatudo-teste-"));
const BANCO = path.join(PASTA, "site.db");
const LIMITES = path.join(PASTA, "limites.json");

/* A senha padrão que o servidor grava quando o banco nasce vazio. Está no
   código dele, não é segredo de ninguém — e é justamente por isso que existe
   o aviso para trocá-la na primeira entrada. */
const SENHA_PADRAO = "borda-admin";

let passou = 0, falhou = 0, servidor = null;
const falhas = [];

function ok(condicao, titulo, detalhe) {
  if (condicao) { passou++; return true; }
  falhou++; falhas.push(titulo + (detalhe ? "  → " + detalhe : ""));
  return false;
}
const eq = (a, b, t) => ok(a === b, t, `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

let cookie = "";
async function pedir(caminho, metodo, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo || "GET",
    headers: Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {}),
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    redirect: "manual",
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const texto = await r.text();
  return {
    status: r.status, texto,
    tipo: r.headers.get("content-type") || "",
    retry: r.headers.get("retry-after") || "",
  };
}

async function subir(preparar) {
  if (servidor) { servidor.kill(); await new Promise((r) => setTimeout(r, 250)); }
  if (preparar) preparar();
  servidor = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORTA), HOST: "127.0.0.1", SITE_DB: BANCO, LIMITES_ARQUIVO: LIMITES,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  servidor.stdout.on("data", (d) => { saida += d; });
  servidor.stderr.on("data", (d) => { saida += d; });

  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + "/favicon.ico"); return saida; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("o servidor de teste não subiu:\n" + saida);
}

const bancoAberto = () => require("./db").abrirBanco(BANCO);
function porFora(chave, valor) {
  const db = bancoAberto();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(chave, valor);
  db.close();
}
function lerChave(chave) {
  const db = bancoAberto();
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(chave);
  db.close();
  return r ? r.value : null;
}

/* As páginas do site que o visitante alcança. Se uma delas escapar do bloqueio,
   o cliente descobre pelo Google. */
const PAGINAS = ["/", "/servicos/", "/vitrine/", "/empresa/", "/orcamento/",
                 "/privacidade/", "/busca/", "/sitemap.xml", "/robots.txt"];

(async () => {
  console.log("\n  1. site no ar");
  let saida = await subir();
  ok(!/situação do site migrada/.test(saida), "banco novo não anuncia migração");
  eq(lerChave("site_estado"), "no-ar", "banco novo nasce no ar");

  let r = await pedir("/");
  eq(r.status, 200, "a home responde");
  ok(r.texto.includes("Borda Tudo"), "e é o site de verdade");
  ok(!r.texto.includes("sendo bordado"), "não é a página de construção");

  /* ---------------------------------------------------- 2. construção --- */
  console.log("  2. em construção");
  porFora("site_estado", "construcao");
  await subir();

  for (const p of PAGINAS) {
    r = await pedir(p);
    eq(r.status, 503, `${p} sai do ar`);
  }
  r = await pedir("/");
  ok(r.texto.includes("sendo bordado"), "e mostra a página de construção");
  ok(r.texto.includes("noindex"), "com noindex — senão o Google guarda o aviso no lugar da home");
  ok(r.texto.includes("wa.me/"), "com o caminho para o WhatsApp, que é o que a fábrica precisa");
  ok(r.texto.includes("luizaugust.me"), "e com o crédito do desenvolvedor");
  eq(r.retry, "86400", "Retry-After longo: não adianta o robô voltar em 10 minutos");

  /* 503 e não 200: `200` diria ao Google que ESTA é a home, e o aviso ficaria
     indexado semanas depois de o site subir. */
  eq((await pedir("/naoexiste")).status, 503, "página inventada também não vaza o 404 do site");

  eq((await pedir("/admin/")).status, 200, "o PAINEL continua de pé — senão não haveria como voltar");
  eq((await pedir("/restrito")).status, 200, "e o /restrito também: a fábrica não para com o site");
  eq((await pedir("/favicon.ico")).status, 200, "o favicon passa (a própria página de aviso o pede)");
  eq((await pedir("/assets/css/styles.css")).status, 200, "os assets passam (o painel precisa deles)");

  /* ---------------------------------------------------- 3. manutenção --- */
  console.log("  3. em manutenção");
  porFora("site_estado", "manutencao");
  await subir();
  r = await pedir("/");
  eq(r.status, 503, "a home sai do ar");
  ok(r.texto.includes("trocando a linha"), "e mostra a página de MANUTENÇÃO, não a de construção");
  ok(!r.texto.includes("sendo bordado"), "as duas páginas não se misturam");
  eq(r.retry, "600", "Retry-After curto: manutenção promete voltar logo");

  /* ------------------------------------------------------ 4. o painel --- */
  console.log("  4. trocar pelo painel");
  porFora("site_estado", "construcao");
  await subir();

  eq((await pedir("/api/conteudo", "PUT", { site_estado: "no-ar" })).status, 401,
     "sem entrar no painel, ninguém muda a situação do site");
  eq((await pedir("/api/login", "POST", { senha: "chute-errado" })).status, 401, "senha errada não entra");
  eq((await pedir("/api/login", "POST", { senha: SENHA_PADRAO })).status, 200, "senha certa entra");

  /* Valor fora da lista tiraria o site do ar sem página nenhuma para mostrar —
     e o painel continuaria dizendo que está tudo certo. */
  eq((await pedir("/api/conteudo", "PUT", { site_estado: "seila" })).status, 400,
     "situação inventada é recusada");
  eq(lerChave("site_estado"), "construcao", "e nada foi gravado");
  eq((await pedir("/api/conteudo", "PUT", { site_estado: "" })).status, 400, "situação vazia também");

  eq((await pedir("/api/conteudo", "PUT", { site_estado: "no-ar" })).status, 200, "o painel põe o site no ar");
  eq(lerChave("site_estado"), "no-ar", "e a chave foi gravada");
  eq((await pedir("/")).status, 200, "a home volta na hora, sem reiniciar nada");

  eq((await pedir("/api/conteudo", "PUT", { site_estado: "construcao" })).status, 200,
     "e volta para construção pelo mesmo caminho");
  eq((await pedir("/")).status, 503, "a home sai de novo");

  /* --------------------------------------------------- 5. a migração ---- */
  /* O `manutencao` de "0"/"1" virou `site_estado`. Um site que estivesse EM
     MANUTENÇÃO voltaria ao ar sozinho no primeiro `git pull` se a chave nova
     nascesse com o padrão — que é a falha silenciosa mais cara possível aqui. */
  console.log("  5. migração da chave antiga");

  const db1 = bancoAberto();
  db1.prepare("DELETE FROM settings WHERE key = 'site_estado'").run();
  db1.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('manutencao', '1')").run();
  db1.close();
  saida = await subir();
  ok(/situação do site migrada/.test(saida), "a migração anuncia o que fez", saida.split("\n")[0]);
  eq(lerChave("site_estado"), "manutencao", "manutencao=1 virou site_estado=manutencao");
  eq(lerChave("manutencao"), null, "e a chave velha saiu — duas dizendo o mesmo acabam discordando");
  eq((await pedir("/")).status, 503, "o site continua fora do ar, como estava antes da atualização");

  const db2 = bancoAberto();
  db2.prepare("DELETE FROM settings WHERE key = 'site_estado'").run();
  db2.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('manutencao', '0')").run();
  db2.close();
  await subir();
  eq(lerChave("site_estado"), "no-ar", "manutencao=0 virou site_estado=no-ar");
  eq((await pedir("/")).status, 200, "e o site continua no ar");

  await subir();
  eq(lerChave("site_estado"), "no-ar", "rodar de novo não desfaz nada (a migração é idempotente)");

  /* --------------------------------------------------------- resultado -- */
  const total = passou + falhou;
  console.log("\n  " + "─".repeat(58));
  if (falhou) {
    console.log(`\n  ✖ ${falhou} de ${total} falharam:\n`);
    for (const f of falhas) console.log("    · " + f);
    console.log("");
    process.exitCode = 1;
  } else {
    console.log(`\n  ✔ ${passou}/${total} — a situação do site obedece\n`);
  }
})().catch((e) => {
  console.error("\n  ✖ a suíte quebrou: " + String((e && e.stack) || e).split("\n").slice(0, 4).join("\n"));
  if (falhas.length) {
    console.error(`\n  ${falhas.length} falha(s) já detectada(s):\n`);
    for (const f of falhas) console.error("    · " + f);
  }
  process.exitCode = 1;
}).finally(() => {
  if (servidor) servidor.kill();
  try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch {}
});
