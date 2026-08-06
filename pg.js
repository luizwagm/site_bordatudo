/* ==========================================================================
   pg.js — acesso ao PostgreSQL do sistema de gestão (/restrito)

   O SITE e o /admin continuam no SQLite (data/site.db). Só o /restrito —
   IMÓVEIS, leads, visitas e propostas — vive no Postgres. Os dois bancos
   convivem no mesmo processo Node sem se falarem.

   A divisão não é capricho. O conteúdo do site (textos, serviços, matérias,
   depoimentos) é pequeno, muda pouco e precisa estar junto do publish, que é
   síncrono; o SQLite resolve isso sem servidor nenhum. Os imóveis são o
   contrário: crescem, têm foto, histórico, várias pessoas mexendo ao mesmo
   tempo e consultas que cruzam tabelas. Aí o Postgres paga o próprio custo.

   Esta camada foi PORTADA do Instituto Kenósis, onde a mesma separação já
   estava rodando. O que veio de lá está comentado como veio; o que muda é o
   domínio.

   ---------------------------------------------------------------------------
   POR QUE A API TEM NOME DIFERENTE DO better-sqlite3

   O better-sqlite3 é SÍNCRONO (`db.prepare(sql).get(...)` devolve a linha) e o
   `pg` é ASSÍNCRONO (devolve uma Promise). Numa conversão de 124 consultas, o
   erro que mata é esquecer um `await`: a Promise é um objeto, então
   `if (linha)` passa, `linha.id` vira undefined e NADA estoura — o sistema
   segue rodando e grava errado.

   Por isso a API aqui NÃO imita a antiga. Ela se chama Q.get / Q.all / Q.run,
   e o objeto `db` do restrito.js deixou de existir. Assim, qualquer consulta
   que eu tenha deixado sem converter quebra na hora, com "db is not defined",
   em vez de falhar em silêncio meses depois dentro de uma ficha de imóvel.

   ---------------------------------------------------------------------------
   O QUE O ADAPTADOR TRADUZ (e por quê o SQL do restrito.js não mudou)

   1. `?` → `$1, $2…`  — o SQLite usa `?`, o Postgres usa `$n`. Traduzir aqui
      significa que as 124 consultas continuam escritas exatamente como estavam;
      eu não reescrevi SQL, só a forma de chamar. Menos texto mexido, menos
      erro.

   2. `LIKE` → `ILIKE` — ESTA É A ARMADILHA SILENCIOSA DA MIGRAÇÃO. No SQLite,
      `LIKE` ignora maiúsculas/minúsculas para ASCII; no Postgres, NÃO. Sem esta
      tradução, procurar "maria" simplesmente pararia de achar "Maria" — a busca
      de imóvel por bairro, título e referência morreria sem erro nenhum, e só o
      cliente descobriria. `ILIKE` é o equivalente do Postgres.

   Ambas as traduções pulam o que está dentro de aspas e de comentários: um
   texto que contenha "?" ou a palavra LIKE não é tocado.
   ========================================================================== */
const { AsyncLocalStorage } = require("node:async_hooks");

/* ==========================================================================
   O require do 'pg' NÃO PODE DERRUBAR O PROCESSO.

   Este arquivo é carregado pelo server.js, que também serve o site público e o
   /admin — e esses dois vivem no SQLite, sem nenhuma relação com o Postgres.
   Um `require("pg")` cru no topo faz o processo INTEIRO morrer quando o pacote
   falta (servidor sem `npm ci`, deploy pela metade). Foi assim que a produção
   caiu na virada: faltava a dependência e o site saiu do ar junto.

   Com o require dentro do try, a falta do pacote vira um erro claro na PRIMEIRA
   consulta do /restrito — e só ali. O site continua no ar.
   ========================================================================== */
let pg = null;
let ERRO_DRIVER = "";
try {
  pg = require("pg");
} catch {
  ERRO_DRIVER = "o pacote 'pg' não está instalado — rode: npm ci --omit=dev";
}

const exigirDriver = () => {
  if (!pg) throw new Error(ERRO_DRIVER);
  return pg;
};

/* ==========================================================================
   COUNT(*) PRECISA VOLTAR COMO NÚMERO — e por padrão não volta.

   No Postgres, COUNT() é `bigint`. Como bigint não cabe em Number com
   segurança, o driver entrega o valor como STRING, para não perder precisão.
   O problema: `"0"` é VERDADEIRO em JavaScript.

   Todo o sistema faz `if (conta("SELECT COUNT(*) ..."))` para decidir se um
   imóvel tem lead, se já existe usuário, se a pasta tem lançamento. Com a
   string, ZERO passaria a valer como "tem" — o sistema recusaria excluir um
   cadastro sem nenhum vínculo, e diria que já existe usuário admin num banco
   vazio (nunca criando o login inicial). Nenhum desses erros dá exceção.

   O tipo 20 é o int8/bigint. Convertê-lo para Number devolve exatamente o
   comportamento que o SQLite tinha. O limite seguro é 9 quatrilhões — a
   imobiliária conta imóveis e atendimentos, não estrelas.
   ========================================================================== */
if (pg) {
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  /* NUMERIC (1700) tem o mesmo dilema. Aqui ele só aparece em soma de valores,
     que o sistema já trata como texto — converter mantém a aritmética simples. */
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
}

/* ------------------------------ conexão ---------------------------------- */
/* Em produção as credenciais vêm do systemd (EnvironmentFile=/etc/bordatudo.env)
   e nunca do git. Localmente, um .env na raiz serve; carregá-lo é opcional
   (ver carregarEnv abaixo). DATABASE_URL, se existir, tem prioridade — é o
   formato que qualquer hospedagem entende. */
function config() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || "bordatudo",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || "bordatudo_producao",
  };
}

let pool = null;
function obterPool() {
  if (!pool) {
    const { Pool } = exigirDriver();
    pool = new Pool({
      ...config(),
      max: Number(process.env.PGPOOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      /* application_name aparece no pg_stat_activity: quando o cliente ligar
         dizendo "o sistema travou", dá para ver no servidor quem está segurando
         conexão sem precisar adivinhar. */
      application_name: "bordatudo-restrito",
    });
    /* Um erro num cliente OCIOSO do pool (o Postgres reiniciou, a rede caiu)
       chega como evento 'error'. Sem este listener o Node derruba o processo
       inteiro — o site sairia do ar por causa de uma conexão parada. */
    pool.on("error", (e) => console.error("  ✖ pool Postgres (cliente ocioso):", e.message));
  }
  return pool;
}

/* ---------------------- tradução do dialeto ------------------------------ */
/* Percorre o SQL uma vez, sabendo quando está dentro de uma string, de um
   identificador entre aspas duplas ou de um comentário. Só traduz o que está
   fora disso. */
function traduzir(sql) {
  let fora = "";           // resultado
  let n = 0;               // contador de $1, $2…
  let i = 0;
  const s = String(sql);

  while (i < s.length) {
    const c = s[i];

    // string literal: '...' com '' como escape
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") { j++; break; }
        j++;
      }
      fora += s.slice(i, j); i = j; continue;
    }
    // identificador entre aspas duplas
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j++;
      fora += s.slice(i, j + 1); i = j + 1; continue;
    }
    // comentário de linha
    if (c === "-" && s[i + 1] === "-") {
      let j = s.indexOf("\n", i);
      if (j < 0) j = s.length;
      fora += s.slice(i, j); i = j; continue;
    }
    // comentário de bloco
    if (c === "/" && s[i + 1] === "*") {
      let j = s.indexOf("*/", i);
      j = j < 0 ? s.length : j + 2;
      fora += s.slice(i, j); i = j; continue;
    }
    // o marcador de parâmetro
    if (c === "?") { fora += "$" + ++n; i++; continue; }

    // LIKE → ILIKE (palavra inteira, e sem transformar um ILIKE já escrito)
    if ((c === "l" || c === "L") && /^like\b/i.test(s.slice(i, i + 5))) {
      const antes = i > 0 ? s[i - 1] : " ";
      if (!/[A-Za-z0-9_]/.test(antes)) { fora += "ILIKE"; i += 4; continue; }
    }

    fora += c; i++;
  }
  return fora;
}

/* --------------------------- transações ---------------------------------- */
/* Dentro de Q.tx(), TODA consulta precisa sair pelo MESMO cliente — senão o
   pool entrega outra conexão, que está fora da transação, e o BEGIN/COMMIT não
   cobre nada. Em vez de passar o cliente de função em função (o que mudaria a
   assinatura de dezenas de helpers), guardamos ele no contexto assíncrono:
   quem chama Q.get lá dentro pega o cliente da transação sozinho. */
const ctx = new AsyncLocalStorage();
const executor = () => ctx.getStore() || obterPool();

/* ==========================================================================
   DECIFRAGEM AUTOMÁTICA NA LEITURA

   Os campos sensíveis (nome, telefone, e-mail, CPF do lead…) são gravados
   cifrados. Decifrar aqui, no ÚNICO caminho por onde toda leitura passa, e não
   em cada consulta, é o que garante que nenhuma tela mostre texto cifrado: são
   mais de 40 pontos que leem essas tabelas, e bastaria esquecer um.

   Como o valor cifrado se identifica sozinho pelo prefixo "enc:", não é
   preciso saber de qual tabela ou coluna ele veio — o que também faz isto
   funcionar em consultas com JOIN, apelido de coluna e subconsulta.

   Só strings são inspecionadas, e só as que começam com o prefixo. Texto comum
   passa direto, sem custo perceptível.
   ========================================================================== */
const { decifrar, PREFIXO } = require("./cripto");

function revelarLinhas(linhas) {
  if (!linhas || !linhas.length) return linhas;
  for (const linha of linhas) {
    for (const chave in linha) {
      const v = linha[chave];
      if (typeof v === "string" && v.startsWith(PREFIXO)) linha[chave] = decifrar(v);
    }
  }
  return linhas;
}

async function consultar(sql, args) {
  const texto = traduzir(sql);
  try {
    const r = await executor().query(texto, args);
    if (r.rows) revelarLinhas(r.rows);
    return r;
  } catch (e) {
    /* A mensagem do Postgres sozinha ("relation X does not exist") não diz de
       ONDE veio. Anexar o SQL aqui é o que transforma meia hora de caça em
       trinta segundos — vai só para o log do servidor, nunca para a tela. */
    e.message = `${e.message}\n     SQL: ${texto.replace(/\s+/g, " ").trim().slice(0, 300)}`;
    throw e;
  }
}

const Q = {
  /* todas as linhas */
  async all(sql, ...args) {
    return (await consultar(sql, args)).rows;
  },
  /* a primeira linha, ou undefined — mesmo contrato do .get() antigo */
  async get(sql, ...args) {
    return (await consultar(sql, args)).rows[0];
  },
  /* INSERT/UPDATE/DELETE. Devolve { changes } como o better-sqlite3 devolvia,
     porque o código já lê `.changes` em 6 lugares. NÃO devolve lastInsertRowid:
     no Postgres o id novo só existe com RETURNING, e fingir que existe seria
     devolver undefined em silêncio. Para inserir e saber o id, use Q.inserir. */
  async run(sql, ...args) {
    const r = await consultar(sql, args);
    return { changes: r.rowCount };
  },
  /* INSERT que devolve o id novo. Acrescenta RETURNING id se não houver. */
  async inserir(sql, ...args) {
    const comRetorno = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`;
    const r = await consultar(comRetorno, args);
    return r.rows[0] ? Number(r.rows[0].id) : null;
  },
  /* DDL e vários comandos de uma vez (sem parâmetros) */
  async exec(sql) {
    await executor().query(traduzir(sql));
  },
  /* Lê SEM decifrar — devolve o que está gravado, tal e qual.
     Só dois usos legítimos: o script que cifra os dados antigos (precisa saber
     o que ainda está em texto puro) e a conferência que PROVA que o banco
     guarda texto cifrado. Nunca use isto para alimentar tela. */
  async bruto(sql, ...args) {
    const texto = traduzir(sql);
    return (await executor().query(texto, args)).rows;
  },
  /* Transação. Tudo que rodar dentro do callback usa o mesmo cliente. */
  async tx(fn) {
    const store = ctx.getStore();
    if (store) return fn();          // já estamos numa transação: não aninha
    const cliente = await obterPool().connect();
    try {
      await cliente.query("BEGIN");
      const r = await ctx.run(cliente, fn);
      await cliente.query("COMMIT");
      return r;
    } catch (e) {
      try { await cliente.query("ROLLBACK"); } catch { /* conexão já morta */ }
      throw e;
    } finally {
      cliente.release();
    }
  },
  /* Testa a conexão e devolve a versão — usado no boot e no verificar.sh */
  async versao() {
    const r = await obterPool().query("SELECT version() v, current_database() d, current_user u");
    return r.rows[0];
  },
  async fechar() {
    if (pool) { await pool.end(); pool = null; }
  },
};

/* ------------------------------- .env ------------------------------------ */
/* Leitor mínimo, só para desenvolvimento. Em produção quem entrega as
   variáveis é o systemd (EnvironmentFile), que não depende disto.
   Nunca sobrescreve variável que já veio do ambiente. */
function carregarEnv(arquivo) {
  try {
    const txt = require("node:fs").readFileSync(arquivo, "utf8");
    for (const linha of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(linha);
      if (!m || linha.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    return true;
  } catch { return false; }
}

/* ==========================================================================
   DE ONDE VÊM AS CREDENCIAIS, NA ORDEM

   O systemd entrega /etc/bordatudo.env ao SERVIÇO. Mas o deploy.sh, o
   restaurar.sh e o verificar.sh rodam no shell do `deploy`, fora do serviço —
   e ali essas variáveis não existem. Sem isto, `node migrar.js` no meio do
   deploy falharia com "password authentication failed" num servidor onde o
   sistema funciona perfeitamente.

   Ordem: o que já está no ambiente sempre vence (é o caso do serviço); depois
   o arquivo do servidor; por último o .env local de desenvolvimento.
   ========================================================================== */
function carregarAmbiente(raiz) {
  const path = require("node:path");
  const tentados = [
    process.env.BORDATUDO_ENV,                    // caminho explícito, se alguém quiser
    "/etc/bordatudo.env",                          // produção (o mesmo que o systemd lê)
    path.join(raiz || __dirname, ".env"),         // desenvolvimento
  ].filter(Boolean);
  const lidos = [];
  for (const arq of tentados) if (carregarEnv(arq)) lidos.push(arq);
  return lidos;
}

module.exports = { Q, carregarEnv, carregarAmbiente, traduzir, config };
