/* ==========================================================================
   Roda um arquivo .sql pelo psql, montando o comando certo para cada um.

   POR QUE NÃO É SÓ UM `psql -f`:

   · o 01 precisa de SUPERUSUÁRIO e recebe a senha do papel como variável.
     Deixar essa senha na linha de comando a exporia na lista de processos e
     no histórico do terminal — por isso ela vai como `-v senha=…` lida do
     .env, e o .env nunca vai para o git.

   · o 02 roda como o papel `bordatudo`, já com a senha via PGPASSWORD no
     ambiente do processo filho, que não aparece em `ps`.

   · no Windows o psql quase nunca está no PATH. Procurar o executável aqui
     evita o "command not found" que não diz nada sobre o que fazer.

   Uso:  npm run banco:criar     (pede a senha do postgres, uma vez)
         npm run banco:esquema
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { carregarAmbiente } = require("../pg.js");

const RAIZ = path.join(__dirname, "..");
carregarAmbiente(RAIZ);

const arquivo = process.argv[2];
if (!arquivo) { console.error("  uso: node sql/rodar.cjs <arquivo.sql>"); process.exit(1); }
const caminho = path.join(__dirname, arquivo);
if (!fs.existsSync(caminho)) { console.error(`  não achei ${caminho}`); process.exit(1); }

/* Acha o psql: PATH primeiro, depois os lugares onde o instalador do Windows
   costuma pôr. Testar a versão é o que separa "existe o arquivo" de "roda". */
function acharPsql() {
  const tentar = (cmd) => {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    return r.status === 0 ? cmd : null;
  };
  if (tentar("psql")) return "psql";
  const raizes = ["C:/Program Files/PostgreSQL", "C:/Program Files (x86)/PostgreSQL"];
  for (const raiz of raizes) {
    let versoes = [];
    try { versoes = fs.readdirSync(raiz); } catch { continue; }
    /* Da versão mais nova para a mais velha: se houver duas instaladas, a
       nova entende o banco da velha, o contrário não é verdade. */
    for (const v of versoes.sort((a, b) => Number(b) - Number(a))) {
      const c = path.join(raiz, v, "bin", "psql.exe");
      if (fs.existsSync(c) && tentar(c)) return c;
    }
  }
  return null;
}

const psql = acharPsql();
if (!psql) {
  console.error("  não achei o psql. Instale o PostgreSQL ou ponha o psql no PATH.");
  process.exit(1);
}

const superusuario = arquivo.startsWith("01");
const args = ["-v", "ON_ERROR_STOP=1", "-f", caminho];
const env = { ...process.env };

if (superusuario) {
  if (!env.PGPASSWORD) {
    console.error("  PGPASSWORD vazia no .env — sem ela o papel nasceria sem senha.");
    process.exit(1);
  }
  /* A senha do PAPEL vai como variável do psql. A do SUPERUSUÁRIO não vem
     daqui: o psql pergunta no terminal, e é você quem digita. Eu não guardo,
     não leio e não passo adiante credencial de superusuário. */
  args.unshift("-v", `senha=${env.PGPASSWORD}`);
  args.unshift("-U", env.PGSUPERUSER || "postgres", "-h", env.PGHOST || "127.0.0.1",
               "-p", String(env.PGPORT || 5432), "-d", "postgres");
  delete env.PGPASSWORD;          // senão o psql tentaria usá-la para o postgres
  console.log(`  rodando ${arquivo} como ${env.PGSUPERUSER || "postgres"} — ele vai pedir a senha do superusuário`);
} else {
  args.unshift("-U", env.PGUSER || "bordatudo", "-h", env.PGHOST || "127.0.0.1",
               "-p", String(env.PGPORT || 5432), "-d", env.PGDATABASE || "bordatudo_producao");
  console.log(`  rodando ${arquivo} como ${env.PGUSER || "bordatudo"}`);
}

const r = spawnSync(psql, args, { stdio: "inherit", env });
process.exit(r.status === null ? 1 : r.status);
