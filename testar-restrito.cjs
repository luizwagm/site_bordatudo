/* ==========================================================================
   SUÍTE DO /restrito — Borda Tudo

       node testar-restrito.cjs

   Sobe o servidor numa porta própria, conversa com ele por HTTP de verdade
   (cookie, sessão, JSON) e confere as regras que fazem a nota sair certa.

   SOBRE OS DADOS: tudo que esta suíte cria leva o prefixo `ZZ QA` e é
   APAGADO POR ID no fim — nunca por `LIKE`, nunca por nome. Um `DELETE ...
   LIKE '%'` já apagou uma tabela inteira num outro projeto meu; aqui a lista
   de ids criados é a única coisa que pode ser removida.

   Se a suíte morrer no meio, os restos ficam visíveis com o prefixo ZZ QA e
   somem na próxima execução completa — ou com `--limpar`.
   ========================================================================== */
"use strict";

const path = require("node:path");
const { Q, carregarAmbiente } = require("./pg.js");

carregarAmbiente(__dirname);

const PORTA = Number(process.env.PORTA_TESTE) || 5199;
const BASE = `http://127.0.0.1:${PORTA}`;
const SO_LIMPAR = process.argv.includes("--limpar");
const ARQ_LIMITES = path.join(__dirname, "data", "limites-teste.json");

/* Registro do que esta suíte criou. É a lista de tudo que ela pode apagar. */
const CRIADO = { usuarios: [], clientes: [], desenhos: [], mercadorias: [], cores: [], maquinas: [],
                 lotes: [], fichas: [], jornadas: [], desenho_fotos: [], arquivos: [],
                 /* `notas` entra aqui porque `notas.cliente_id` é RESTRICT: uma
                    nota deixada para trás impede apagar o cliente de teste, e a
                    suíte termina com "violates RESTRICT" longe da causa. */
                 notas: [] };

let passou = 0, falhou = 0;
const falhas = [];
let servidor = null;   // o processo do servidor de teste

function ok(condicao, titulo, detalhe) {
  if (condicao) { passou++; return true; }
  falhou++;
  falhas.push(titulo + (detalhe ? "  → " + detalhe : ""));
  return false;
}
const eq = (a, b, titulo) => ok(a === b, titulo, `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

/* ==========================================================================
   Cliente HTTP com cookie — é o cookie que prova que a sessão funciona.
   ========================================================================== */
const VERBOSO = process.argv.includes("--verboso");

/* ==========================================================================
   A RESPOSTA QUE DENUNCIA A SI MESMA

   Esta suíte já morreu TRÊS VEZES do mesmo jeito: uma rota devolve erro, o
   teste lê `r.dados.itens.some(...)`, e o que aparece é

       TypeError: Cannot read properties of undefined (reading 'some')

   com o número de uma linha que não tem defeito nenhum. Da última vez a causa
   real era uma coluna que faltava no banco da CI, a sessenta linhas dali — e
   as quinze checagens seguintes nem chegaram a rodar, porque a suíte inteira
   caiu junto.

   O erro em si é honesto: `itens` realmente não existe numa resposta de erro.
   O que falta é DIZER O QUE VEIO NO LUGAR. Então a resposta de status ruim
   vira um Proxy que, ao ser perguntada por uma chave que não tem, conta a rota,
   o status e o corpo.

   SÓ PARA 5xx, e a primeira versão desta guarda me ensinou por quê. Eu havia
   posto >= 400, e ela derrubou uma checagem CERTA:

       ok(!(await admin("/restrito/api/desenhos/" + id)).dados.id,
          "e some do banco de verdade")

   Ler `.id` de um 404 ali não é engano — é a asserção: "não tem id porque não
   existe mais". A premissa "chave ausente em resposta de erro é sempre bug"
   estava errada para o 4xx, que esta suíte provoca de propósito o tempo todo.

   O 5xx é outra coisa: nenhum teste daqui espera um. Ele significa sempre que o
   servidor quebrou, e aí nada do que se leia da resposta faz sentido.
   ========================================================================== */
/* Chaves que a LINGUAGEM pergunta, não o teste. `JSON.stringify` procura
   `toJSON`, `await` procura `then`, o console procura `inspect`. Sem esta
   lista, a guarda explodia dentro do próprio `JSON.stringify(r.dados)` que a
   suíte usa para MOSTRAR o erro — a rede de proteção derrubando quem ela devia
   segurar. Achei isto testando a guarda, não em produção. */
const PERGUNTAS_DA_LINGUAGEM = new Set([
  "toJSON", "then", "catch", "finally", "inspect", "constructor",
  "toString", "valueOf", "length", "name", "nodeType", "$$typeof",
]);

function comDenuncia(dados, status, rota, texto) {
  if (status < 500 || !dados || typeof dados !== "object") return dados;
  return new Proxy(dados, {
    get(alvo, chave) {
      if (chave in alvo || typeof chave === "symbol") return alvo[chave];
      if (PERGUNTAS_DA_LINGUAGEM.has(chave)) return undefined;
      throw new Error(
        `${rota} respondeu ${status} e não tem "${String(chave)}".\n` +
        `      O que o servidor devolveu: ${String(texto).slice(0, 300)}`);
    },
  });
}

function criarNavegador(quem) {
  let cookie = "";
  /* O cookie fica acessível de fora por causa do canal de eventos: ele é uma
     resposta que NÃO TERMINA, e o `fetch` desta função espera o corpo inteiro
     antes de devolver — esperaria para sempre. O teste do canal precisa falar
     `http.request` direto, e para isso precisa do cookie desta sessão. */
  pedir.cookie = () => cookie;
  return pedir;

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
    if (VERBOSO) console.log(`      ${quem || "?"} ${metodo || "GET"} ${caminho} -> ${r.status}  [${cookie.slice(0, 14)}]`);
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
    return {
      status: r.status,
      dados: comDenuncia(dados, r.status, (metodo || "GET") + " " + caminho, texto),
      texto, tipo: r.headers.get("content-type") || "",
    };
  }
}

/* ==========================================================================
   OUVIR O CANAL DE EVENTOS

   `fetch` não serve aqui: esta resposta nunca termina, e o `fetch` espera o
   corpo inteiro antes de devolver — ficaria pendurado para sempre. Por isso
   `http.request` cru, lendo os pedaços conforme chegam.

   Abre o canal, espera ele responder, roda o gatilho e devolve o que chegou
   até o primeiro aviso (ou vazio, se estourar o tempo).
   ========================================================================== */
function ouvirEventos(cookie, gatilho, ms) {
  return new Promise((resolve) => {
    let buf = "";
    let pronto = false;
    const req = require("node:http").request(
      { host: "127.0.0.1", port: PORTA, path: "/restrito/api/eventos", headers: { Cookie: cookie } },
      (resp) => {
        if (resp.statusCode !== 200) { req.destroy(); return resolve("status:" + resp.statusCode); }
        resp.on("data", (d) => {
          buf += String(d);
          /* O gatilho só dispara DEPOIS de o canal estar de pé (o servidor
             manda `retry:` de cara). Gravar antes seria uma corrida: o aviso
             sairia para uma lista de ouvintes ainda vazia. */
          if (!pronto) {
            pronto = true;
            /* ZERA O QUE JÁ ESTAVA NA LINHA. Um aviso disparado por uma
               operação ANTERIOR chega neste canal milissegundos depois de ele
               abrir, e seria lido como resposta ao gatilho — um teste que
               aprova a si mesmo com o eco do teste anterior. */
            buf = "";
            Promise.resolve().then(gatilho);
            return;
          }
          if (buf.includes("event: mudou")) { req.destroy(); resolve(buf); }
        });
      });
    req.on("error", () => resolve(buf));
    req.end();
    const relogio = setTimeout(() => { req.destroy(); resolve(buf); }, ms || 4000);
    relogio.unref && relogio.unref();
  });
}

/* ==========================================================================
   Faxina — só por id, só o que está em CRIADO.
   ========================================================================== */
async function limpar() {
  /* `notas` sai ANTES de `lotes` e de `clientes`. A ligação nota↔lote é
     CASCADE (some sozinha), mas `notas.cliente_id` é RESTRICT — e apagar na
     ordem errada trava no cliente, que é o último passo de todos. */
  const ordem = ["desenho_fotos", "fichas", "notas", "lotes", "jornadas", "desenhos", "clientes",
                 "mercadorias", "cores", "maquinas", "usuarios"];
  for (const tabela of ordem) {
    const ids = CRIADO[tabela].filter(Boolean);
    if (!ids.length) continue;

    /* ABRIR FICHA CRIA JORNADA SOZINHA quando não há uma aberta — é a regra
       que protege o operador que esqueceu de bater o início. Essas jornadas
       não passam por `CRIADO.jornadas`, e sem removê-las o RESTRICT da chave
       estrangeira impede apagar os usuários de teste: a suíte terminava com
       "violates RESTRICT" e deixava o rastro para trás.

       Continua sendo por ID: só as jornadas DOS USUÁRIOS que esta suíte
       criou. */
    if (tabela === "usuarios") {
      await Q.run("DELETE FROM fichas WHERE usuario_id = ANY(?)", ids);
      await Q.run("DELETE FROM jornadas WHERE usuario_id = ANY(?)", ids);
    }
    await Q.run(`DELETE FROM ${tabela} WHERE id = ANY(?)`, ids);
  }

  /* Os ARQUIVOS das fotos não saem por CASCADE: apagar o desenho leva a linha
     junto e deixa a imagem no disco. Uma suíte que roda todo dia encheria
     `data/desenhos/` de imagem que ninguém sabe de quem é. */
  const fs = require("node:fs"), path = require("node:path");
  for (const arquivo of CRIADO.arquivos) {
    try { fs.unlinkSync(path.join(__dirname, "data", "desenhos", arquivo)); } catch {}
  }
}

/* Restos de uma execução que morreu no meio. Aqui SIM por nome — mas só com o
   prefixo exato, e só depois de conferir que nenhuma ficha depende deles. */
async function limparRestos() {
  /* SEM o espaço no fim. A suíte cria um cliente chamado `ZZ QA'; DROP TABLE
     fichas; --` para testar injeção — e `ZZ QA %` não casa com ele, porque
     depois de "ZZ QA" vem aspas, não espaço. O resto ficava no banco e fazia a
     execução seguinte falhar no nome repetido, longe da causa. */
  const P = "ZZ QA%";
  /* `_` é CORINGA no LIKE, não sublinhado. Sem o ESCAPE, `zz_qa_%` casaria
     com `zzXqaY…` — e isto é um caminho de DELETE. Um `LIKE` mal escrito já
     apagou uma tabela inteira num outro projeto meu; aqui o risco era apagar a
     conta de alguém que só tem a infelicidade de um nome parecido. */
  const usuarios = await Q.all(
    "SELECT id FROM usuarios WHERE usuario LIKE ? ESCAPE '!'", "zz!_qa!_%");
  const ids = usuarios.map((u) => u.id);
  if (ids.length) {
    await Q.run("DELETE FROM fichas WHERE usuario_id = ANY(?)", ids);
    await Q.run("DELETE FROM jornadas WHERE usuario_id = ANY(?)", ids);
    await Q.run("DELETE FROM usuarios WHERE id = ANY(?)", ids);
  }
  const clientes = await Q.all("SELECT id FROM clientes WHERE nome LIKE ?", P);
  if (clientes.length) {
    const cids = clientes.map((c) => c.id);
    /* A nota do cliente de teste sai primeiro: ela segura o cliente por
       RESTRICT, e os lançamentos dela seguram a nota pelo mesmo motivo. */
    const notas = await Q.all("SELECT id FROM notas WHERE cliente_id = ANY(?)", cids);
    if (notas.length) {
      const nids = notas.map((n) => n.id);
      await Q.run("DELETE FROM lancamentos WHERE nota_id = ANY(?)", nids);
      await Q.run("DELETE FROM notas WHERE id = ANY(?)", nids);
    }
    await Q.run("DELETE FROM lotes WHERE cliente_id = ANY(?)", cids);
    await Q.run("DELETE FROM desenhos WHERE cliente_id = ANY(?)", cids);
    await Q.run("DELETE FROM clientes WHERE id = ANY(?)", cids);
  }
  for (const t of ["desenhos", "mercadorias", "cores", "maquinas"]) {
    await Q.run(`DELETE FROM ${t} WHERE nome LIKE ?`, P);
  }

  /* Arquivo de foto sem linha no banco: sobra de execução interrompida. Compara
     o disco com a tabela e apaga só o que ninguém mais referencia — nunca o
     contrário, que apagaria foto viva. */
  const fs2 = require("node:fs"), path2 = require("node:path");
  const pasta = path2.join(__dirname, "data", "desenhos");
  let noDisco = [];
  try { noDisco = fs2.readdirSync(pasta); } catch { noDisco = []; }
  if (noDisco.length) {
    const vivas = new Set((await Q.all("SELECT arquivo FROM desenho_fotos")).map((f) => f.arquivo));
    for (const a of noDisco) if (!vivas.has(a)) { try { fs2.unlinkSync(path2.join(pasta, a)); } catch {} }
  }
}

/* ==========================================================================
   A SUÍTE
   ========================================================================== */
(async () => {
  if (SO_LIMPAR) {
    await limparRestos();
    console.log("\n  restos ZZ QA removidos\n");
    return;
  }

  await limparRestos();   // começa de um estado conhecido

  const { gerarHash } = require("./restrito.js");

  /* O servidor sobe como PROCESSO SEPARADO, do jeito que sobe em produção —
     `require("./server.js")` não abriria porta nenhuma, porque o `listen` está
     atrás de `require.main === module`. E testar o processo de verdade é o
     único jeito de o teste cobrir a subida. */
  const { spawn } = require("node:child_process");

  /* ------------------------------------------------------------------
     A PORTA ESTÁ LIVRE?

     A espera pela subida dá por concluído assim que ALGUÉM responde na porta
     — e "alguém" pode não ser o nosso servidor. Um processo esquecido ali de
     outra tarefa faz a suíte inteira rodar contra ele: o nosso nem sobe (a
     porta está ocupada), e o erro que aparece é o da primeira coisa que der
     errado depois, longe da causa. Custou uma diagnose na suíte do site.
     ------------------------------------------------------------------ */
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 800);
    await fetch(`${BASE}/favicon.ico`, { signal: c.signal });
    clearTimeout(t);
    throw new Error(
      `a porta ${PORTA} já está ocupada por outro processo.\n` +
      "  A suíte rodaria contra ELE, não contra o servidor de teste.\n" +
      "  Feche o que está usando a porta, ou rode com PORTA_TESTE=<outra>.");
  } catch (e) {
    if (/já está ocupada/.test(e.message)) throw e;   /* o aviso acima */
    /* qualquer outro erro é a porta LIVRE, que é o que se quer */
  }

  servidor = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORTA), HOST: "127.0.0.1",
      /* Trava de tentativas SÓ DESTE teste. A suíte erra senhas de propósito;
         com o arquivo de produção, quem fosse entrar depois pegaria o bloqueio
         que o teste provocou. */
      LIMITES_ARQUIVO: ARQ_LIMITES,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  servidor.stdout.on("data", (d) => { saida += d; });
  servidor.stderr.on("data", (d) => { saida += d; });

  /* Espera ele ATENDER, não só existir. Já registrei uma falha inexistente por
     testar contra um servidor que ainda não tinha subido — e outra por testar
     contra o servidor ANTIGO, que ainda segurava a porta. */
  let subiu = false;
  for (let i = 0; i < 80 && !subiu; i++) {
    try { await fetch(BASE + "/restrito"); subiu = true; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!subiu) {
    console.error("\n  ✖ o servidor de teste não subiu na porta " + PORTA);
    console.error("    saída do processo:\n" + saida.split("\n").map((l) => "    " + l).join("\n"));
    if (servidor) servidor.kill();
    process.exit(1);
  }

  /* ---- usuários próprios, senha só aqui dentro ------------------------- */
  const SENHA_ADMIN = "zz-qa-admin-2026";
  const SENHA_OPER = "zz-qa-oper-2026";
  CRIADO.usuarios.push(await Q.inserir(
    "INSERT INTO usuarios (usuario, nome, senha_hash, papel) VALUES (?,?,?,?) RETURNING id",
    "zz_qa_admin", "ZZ QA Admin", gerarHash(SENHA_ADMIN), "admin"));
  const idOper = await Q.inserir(
    "INSERT INTO usuarios (usuario, nome, senha_hash, papel) VALUES (?,?,?,?) RETURNING id",
    "zz_qa_oper", "ZZ QA Operador", gerarHash(SENHA_OPER), "operador");
  CRIADO.usuarios.push(idOper);
  const idOper2 = await Q.inserir(
    "INSERT INTO usuarios (usuario, nome, senha_hash, papel) VALUES (?,?,?,?) RETURNING id",
    "zz_qa_oper2", "ZZ QA Operador 2", gerarHash(SENHA_OPER), "operador");
  CRIADO.usuarios.push(idOper2);

  const admin = criarNavegador("admin"), oper = criarNavegador("oper"), oper2 = criarNavegador("oper2"), ninguem = criarNavegador("ninguem");

  /* ==================================================== 1. AUTENTICAÇÃO == */
  console.log("\n  1. autenticação");
  eq((await ninguem("/restrito/api/eu")).status, 401, "sem sessão: /eu devolve 401");
  eq((await ninguem("/restrito/api/meu-dia")).status, 401, "sem sessão: /meu-dia devolve 401");

  /* As senhas erradas ficam para o FIM da suíte (seção 14). A trava de força
     bruta é por IP, e aqui todo mundo vem de 127.0.0.1: errar de propósito
     agora bloquearia os logins legítimos que vêm nas linhas seguintes. */

  let r;
  eq((await admin("/restrito/api/entrar", "POST", { usuario: "zz_qa_admin", senha: SENHA_ADMIN })).status, 200, "admin entra");
  eq((await oper("/restrito/api/entrar", "POST", { usuario: "zz_qa_oper", senha: SENHA_OPER })).status, 200, "operador entra");
  eq((await oper2("/restrito/api/entrar", "POST", { usuario: "zz_qa_oper2", senha: SENHA_OPER })).status, 200, "operador 2 entra");
  eq((await admin("/restrito/api/eu")).dados.papel, "admin", "a sessão do admin diz admin");
  eq((await oper("/restrito/api/eu")).dados.papel, "operador", "a sessão do operador diz operador");

  /* Página (não-API) sem sessão manda para a tela de entrada, não devolve JSON. */
  r = await ninguem("/restrito/etiquetas");
  eq(r.status, 302, "página sem sessão: redireciona em vez de mostrar JSON");

  /* ======================================================= 2. CADASTROS == */
  console.log("  2. cadastros");
  eq((await oper("/restrito/api/clientes", "POST", { nome: "ZZ QA Intruso" })).status, 403,
     "operador NÃO cadastra cliente");
  eq((await oper("/restrito/api/clientes")).status, 200, "operador LÊ a lista de clientes");

  r = await admin("/restrito/api/clientes", "POST", { nome: "ZZ QA Cliente A" });
  eq(r.status, 201, "admin cadastra cliente");
  const cliA = r.dados.id; CRIADO.clientes.push(cliA);
  r = await admin("/restrito/api/clientes", "POST", { nome: "ZZ QA Cliente B" });
  const cliB = r.dados.id; CRIADO.clientes.push(cliB);

  eq((await admin("/restrito/api/clientes", "POST", { nome: "zz qa cliente a" })).status, 400,
     "nome repetido (mesmo com outra caixa) é recusado");

  eq((await admin("/restrito/api/desenhos", "POST", { nome: "ZZ QA D0", cliente_id: cliA, pontuacao: "0" })).status, 400,
     "desenho com pontuação zero é recusado");
  eq((await admin("/restrito/api/desenhos", "POST", { nome: "ZZ QA D0", cliente_id: cliA, pontuacao: "" })).status, 400,
     "desenho com pontuação VAZIA é recusado (vazio não é zero)");

  r = await admin("/restrito/api/desenhos", "POST", { nome: "ZZ QA DES A1", cliente_id: cliA, pontuacao: "9484" });
  eq(r.status, 201, "desenho do cliente A"); const desA1 = r.dados.id; CRIADO.desenhos.push(desA1);
  r = await admin("/restrito/api/desenhos", "POST", { nome: "ZZ QA DES A2", cliente_id: cliA, pontuacao: "34422" });
  const desA2 = r.dados.id; CRIADO.desenhos.push(desA2);
  r = await admin("/restrito/api/desenhos", "POST", { nome: "ZZ QA DES B1", cliente_id: cliB, pontuacao: "1000" });
  const desB1 = r.dados.id; CRIADO.desenhos.push(desB1);

  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Preta" });
  const corPreta = r.dados.id; CRIADO.cores.push(corPreta);
  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Branca" });
  const corBranca = r.dados.id; CRIADO.cores.push(corBranca);
  r = await admin("/restrito/api/mercadorias", "POST", { nome: "ZZ QA Camisa" });
  const merc = r.dados.id; CRIADO.mercadorias.push(merc);

  r = await admin("/restrito/api/maquinas", "POST", { nome: "ZZ QA MAQ", cabecas: "6" });
  eq(r.status, 201, "admin cadastra máquina"); const maq = r.dados.id; CRIADO.maquinas.push(maq);

  /* O token não pode vir da tela: se viesse, dois adesivos poderiam nascer
     iguais e a produção de uma máquina cairia na outra. */
  r = await admin("/restrito/api/maquinas", "POST", { nome: "ZZ QA MAQ 2", token: "escolhido-por-mim" });
  if (!eq(r.status, 201, "cadastra a segunda máquina", JSON.stringify(r.dados)))
    throw new Error("não deu para criar a 2ª máquina: " + r.status + " " + JSON.stringify(r.dados));
  CRIADO.maquinas.push(r.dados.id);
  let linha = await Q.get("SELECT token FROM maquinas WHERE id = ?", r.dados.id);
  ok(linha.token !== "escolhido-por-mim", "token de máquina mandado pelo cliente é IGNORADO");

  const listaMaq = await admin("/restrito/api/maquinas");
  ok(!("token" in (listaMaq.dados.itens[0] || {})), "a listagem de máquinas não devolve o token");

  /* =================================================== 3. QR DA MÁQUINA == */
  console.log("  3. QR da máquina");
  const tokenMaq = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  r = await oper("/restrito/api/maquina-do-qr?m=" + encodeURIComponent(tokenMaq));
  eq(r.status, 200, "operador resolve o QR"); eq(r.dados.nome, "ZZ QA MAQ", "o QR devolve o nome certo");
  eq((await oper("/restrito/api/maquina-do-qr?m=inventado")).status, 404, "QR inventado: 404");

  r = await admin("/restrito/etiquetas?maquina=" + maq);
  eq(r.status, 200, "folha de etiquetas responde");
  ok(r.tipo.includes("text/html"), "a folha sai como HTML, não JSON");
  ok(r.texto.includes("<svg"), "a folha traz o QR desenhado");
  ok(r.texto.includes(tokenMaq), "a folha traz o token da máquina");
  eq((await oper("/restrito/etiquetas")).status, 403, "operador não imprime etiquetas");

  /* ======================================================== 4. JORNADA == */
  console.log("  4. jornada");
  r = await oper("/restrito/api/jornadas", "POST");
  eq(r.status, 201, "início de produção"); const jor = r.dados.id; CRIADO.jornadas.push(jor);
  r = await oper("/restrito/api/jornadas", "POST");
  eq(r.status, 200, "clicar de novo NÃO dá erro"); eq(r.dados.jaEstavaAberta, true, "devolve a mesma jornada");
  eq(r.dados.id, jor, "mesmo id — não abriu uma segunda");

  const abertas = await Q.get("SELECT COUNT(*) c FROM jornadas WHERE usuario_id = ? AND fim IS NULL", idOper);
  eq(Number(abertas.c), 1, "só existe UMA jornada aberta por operador");

  /* ========================================================== 5. FICHA == */
  console.log("  5. ficha");
  eq((await oper("/restrito/api/fichas", "POST", { desenho_id: desA1 })).status, 400, "ficha sem cliente é recusada");
  eq((await oper("/restrito/api/fichas", "POST", { cliente_id: cliA })).status, 400, "ficha sem desenho é recusada");

  /* A PONTUAÇÃO VEM DO DESENHO. Este é o teste que impede a tela de mandar o
     número que quiser — e é o número que multiplica a nota. */
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliA, desenho_id: desA1, pontuacao: 1, maquina_token: tokenMaq });
  eq(r.status, 201, "abre ficha pelo QR"); const f1 = r.dados.id; CRIADO.fichas.push(f1);
  eq(r.dados.pontuacao, 9484, "a pontuação é a do DESENHO, não a mandada no corpo");
  linha = await Q.get("SELECT pontuacao, maquina_id, jornada_id FROM fichas WHERE id = ?", f1);
  eq(Number(linha.pontuacao), 9484, "e é isso que ficou gravado");
  eq(Number(linha.maquina_id), maq, "o QR ligou a ficha à máquina certa");
  eq(Number(linha.jornada_id), jor, "a ficha entrou na jornada aberta");

  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliA, desenho_id: desA2 });
  eq(r.status, 409, "duas fichas abertas ao mesmo tempo: recusado");

  r = await oper("/restrito/api/jornadas/" + jor + "/encerrar", "PUT");
  eq(r.status, 409, "encerrar a produção com ficha aberta: recusado");

  eq((await oper("/restrito/api/fichas/" + f1 + "/fechar", "PUT", {})).status, 400, "fechar sem quantidade: recusado");
  eq((await oper("/restrito/api/fichas/" + f1 + "/fechar", "PUT", { quantidade: "0" })).status, 400, "fechar com zero: recusado");
  eq((await oper("/restrito/api/fichas/" + f1 + "/fechar", "PUT", { quantidade: "abc" })).status, 400, "fechar com texto: recusado");

  r = await oper("/restrito/api/fichas/" + f1 + "/fechar", "PUT",
    { quantidade: "58", mercadoria_id: merc, cor_id: corBranca });
  eq(r.status, 200, "fecha com 58 peças");
  eq(Number(r.dados.ficha.total_pontos), 550072, "58 × 9.484 = 550.072, calculado pelo BANCO");

  eq((await oper("/restrito/api/fichas/" + f1 + "/fechar", "PUT", { quantidade: "10" })).status, 409,
     "fechar duas vezes: recusado");

  /* O total é coluna gerada: nem por SQL direto dá para escrever um valor
     divergente. É o que garante que ninguém "ajuste" a nota por baixo. */
  let escreveuTotal = false;
  try { await Q.run("UPDATE fichas SET total_pontos = 1 WHERE id = ?", f1); escreveuTotal = true; } catch {}
  ok(!escreveuTotal, "o total NÃO pode ser escrito à mão, nem por SQL");

  /* Ficha do outro operador é intocável. */
  eq((await oper2("/restrito/api/fichas/" + f1 + "/cancelar", "PUT")).status, 403,
     "operador não mexe na ficha de outro");

  /* Segunda e terceira fichas, para a amálgama ter o que juntar. */
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliA, desenho_id: desA1 });
  const f2 = r.dados.id; CRIADO.fichas.push(f2);
  await oper("/restrito/api/fichas/" + f2 + "/fechar", "PUT", { quantidade: "42", mercadoria_id: merc, cor_id: corPreta });

  r = await oper2("/restrito/api/fichas", "POST", { cliente_id: cliA, desenho_id: desA2 });
  const f3 = r.dados.id; CRIADO.fichas.push(f3);
  CRIADO.jornadas.push((await Q.get("SELECT id FROM jornadas WHERE usuario_id = ? AND fim IS NULL", idOper2)).id);
  await oper2("/restrito/api/fichas/" + f3 + "/fechar", "PUT", { quantidade: "20", mercadoria_id: merc, cor_id: corPreta });

  /* Ficha de OUTRO cliente — a intrusa da amálgama. */
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliB, desenho_id: desB1 });
  const fB = r.dados.id; CRIADO.fichas.push(fB);
  await oper("/restrito/api/fichas/" + fB + "/fechar", "PUT", { quantidade: "5" });

  /* Uma que fica ABERTA — a amálgama também tem de recusar. */
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliA, desenho_id: desA1 });
  const fAberta = r.dados.id; CRIADO.fichas.push(fAberta);

  r = await oper("/restrito/api/meu-dia");
  eq(r.status, 200, "meu-dia responde");
  eq(Number(r.dados.soma.pecas), 105, "soma do dia do operador: 58 + 42 + 5 = 105 peças");
  eq(r.dados.ficha.id, fAberta, "meu-dia mostra a ficha ainda aberta");

  await oper("/restrito/api/fichas/" + fAberta + "/cancelar", "PUT");
  linha = await Q.get("SELECT situacao FROM fichas WHERE id = ?", fAberta);
  eq(linha.situacao, "cancelada", "ficha cancelada muda de situação, não some");

  r = await oper("/restrito/api/jornadas/" + jor + "/encerrar", "PUT");
  eq(r.status, 200, "sem ficha aberta, a produção encerra");

  /* ================================================== 6. ADMINISTRATIVO == */
  console.log("  6. administrativo");
  for (const [m, u] of [["GET", "/restrito/api/producao"], ["GET", "/restrito/api/lotes"],
                        ["GET", "/restrito/api/usuarios"], ["POST", "/restrito/api/lotes"]]) {
    eq((await oper(u, m, m === "GET" ? undefined : {})).status, 403, `operador barrado em ${m} ${u}`);
  }
  eq((await oper("/restrito/api/fichas/" + f1, "PUT", { quantidade: 999 })).status, 403,
     "operador não corrige ficha fechada");

  r = await admin("/restrito/api/producao?soltas=1&cliente=" + cliA);
  eq(r.status, 200, "produção responde");
  eq(r.dados.fichas.length, 3, "3 fichas soltas do cliente A");
  eq(Number(r.dados.soma.pecas), 120, "58 + 42 + 20 = 120 peças");
  eq(Number(r.dados.soma.pontos), 1636840, "e 1.636.840 pontos");
  eq(Object.keys(r.dados.porOperador).length, 2, "a produção sai quebrada por operador");

  /* ========================================================= 7. LOTES == */
  console.log("  7. lotes e amálgama");
  eq((await admin("/restrito/api/lotes", "POST", { descricao: "sem cliente" })).status, 400,
     "lote sem cliente é recusado");

  r = await admin("/restrito/api/lotes", "POST",
    { cliente_id: cliA, descricao: "ZZ QA 150 camisas", quantidade_prevista: "150" });
  eq(r.status, 201, "cria lote"); const lote = r.dados.id; CRIADO.lotes.push(lote);
  ok(/^LOTE-\d{4}-\d{4}$/.test(r.dados.codigo), "o código do lote é gerado pelo servidor", r.dados.codigo);

  r = await admin("/restrito/api/lotes", "POST", { cliente_id: cliB });
  const lote2 = r.dados.id; CRIADO.lotes.push(lote2);
  ok(r.dados.codigo !== (await Q.get("SELECT codigo FROM lotes WHERE id = ?", lote)).codigo,
     "dois lotes seguidos recebem códigos diferentes");

  /* A AMÁLGAMA. Manda tudo: as 3 do cliente A, a do cliente B, a cancelada e
     um id que não existe. Só as 3 legítimas podem entrar. */
  r = await admin("/restrito/api/lotes/" + lote + "/fichas", "PUT",
    { fichas: [f1, f2, f3, fB, fAberta, 99999999] });
  eq(r.status, 200, "amálgama responde");
  eq(r.dados.anexadas, 3, "só as 3 fichas fechadas do cliente A entraram");
  eq(r.dados.pedidas, 6, "e o servidor DIZ quantas foram pedidas, para a tela avisar");

  linha = await Q.get("SELECT lote_id FROM fichas WHERE id = ?", fB);
  eq(linha.lote_id, null, "a ficha do outro cliente ficou de fora");

  r = await admin("/restrito/api/lotes/" + lote);
  eq(Number(r.dados.pecas), 120, "o lote soma 120 peças");
  eq(Number(r.dados.pontos), 1636840, "e 1.636.840 pontos");
  eq(Number(r.dados.falta), 30, "faltam 30 das 150 combinadas");
  eq(r.dados.porCor.length, 2, "quebra por cor: duas cores");
  eq(r.dados.porCor.find((c) => c.nome === "ZZ QA Branca").pecas, 58, "58 brancas");
  eq(r.dados.porCor.find((c) => c.nome === "ZZ QA Preta").pecas, 62, "62 pretas (42 + 20)");
  eq(r.dados.porOperador.length, 2, "quebra por operador: dois operadores");

  /* Idempotência: mandar a MESMA lista de novo não duplica nem some nada. */
  r = await admin("/restrito/api/lotes/" + lote + "/fichas", "PUT", { fichas: [f1, f2, f3] });
  eq(r.dados.anexadas, 3, "repetir a amálgama dá o mesmo resultado");
  eq(Number((await admin("/restrito/api/lotes/" + lote)).dados.pecas), 120, "e as peças continuam 120");

  /* Tirar uma ficha do lote a devolve para as soltas. */
  await admin("/restrito/api/lotes/" + lote + "/fichas", "PUT", { fichas: [f1, f2] });
  eq(Number((await admin("/restrito/api/lotes/" + lote)).dados.pecas), 100, "sem a f3, sobram 100 peças");
  r = await admin("/restrito/api/producao?soltas=1&cliente=" + cliA);
  ok(r.dados.fichas.some((f) => f.id === f3), "a ficha retirada voltou para a lista de soltas");
  await admin("/restrito/api/lotes/" + lote + "/fichas", "PUT", { fichas: [f1, f2, f3] });

  /* ===================================================== 8. FATURAMENTO == */
  console.log("  8. faturamento");
  eq((await admin("/restrito/api/lotes/" + lote, "PUT", { situacao: "faturado" })).status, 400,
     "faturar sem número de nota: recusado");
  eq((await admin("/restrito/api/lotes/" + lote, "PUT", { situacao: "inventada" })).status, 400,
     "situação inventada: recusada");

  eq((await admin("/restrito/api/lotes/" + lote, "PUT", { situacao: "faturado", nota: "ZZQA-1" })).status, 200,
     "faturar com nota: aceito");
  eq((await admin("/restrito/api/lotes/" + lote + "/fichas", "PUT", { fichas: [f1] })).status, 409,
     "lote faturado não aceita mexer nas fichas");
  eq((await admin("/restrito/api/lotes/" + lote, "DELETE")).status, 409,
     "lote faturado não pode ser apagado");
  eq(Number((await admin("/restrito/api/lotes/" + lote)).dados.pecas), 120,
     "e depois das tentativas o lote continua com 120 peças");

  /* Lote com ficha dentro NÃO é apagado. Antes ele soltava as fichas sozinho e
     se apagava — conveniente e errado: quem clica em "apagar" num lote cheio
     está pensando no lote, não no que tem dentro dele. */
  await admin("/restrito/api/lotes/" + lote2 + "/fichas", "PUT", { fichas: [fB] });
  eq(Number((await admin("/restrito/api/lotes/" + lote2)).dados.pecas), 5, "lote 2 com a ficha do cliente B");
  eq((await admin("/restrito/api/lotes/" + lote2, "DELETE")).status, 409, "lote 2 com ficha: recusado");
  linha = await Q.get("SELECT id, lote_id FROM fichas WHERE id = ?", fB);
  ok(linha && Number(linha.lote_id) === lote2, "e a ficha continua no lote, intocada");

  await admin("/restrito/api/lotes/" + lote2 + "/fichas", "PUT", { fichas: [] });
  eq((await admin("/restrito/api/lotes/" + lote2, "DELETE")).status, 200, "esvaziado, o lote 2 sai");
  linha = await Q.get("SELECT id, lote_id FROM fichas WHERE id = ?", fB);
  ok(linha, "a ficha CONTINUA existindo — ela é a produção que aconteceu");
  eq(linha.lote_id, null, "e voltou a ficar solta");
  CRIADO.lotes = CRIADO.lotes.filter((x) => x !== lote2);

  /* ======================================================= 9. CORREÇÃO == */
  console.log("  9. correção de ficha");
  r = await admin("/restrito/api/fichas/" + f1, "PUT", { quantidade: "60" });
  eq(r.status, 200, "admin corrige a quantidade");
  linha = await Q.get("SELECT quantidade, total_pontos FROM fichas WHERE id = ?", f1);
  eq(Number(linha.total_pontos), 60 * 9484, "o total foi RECALCULADO sozinho pelo banco");
  eq((await admin("/restrito/api/fichas/" + f1, "PUT", { pontuacao: "0" })).status, 400,
     "corrigir para pontuação zero: recusado");
  await admin("/restrito/api/fichas/" + f1, "PUT", { quantidade: "58" });

  /* ======================================================= 10. USUÁRIOS == */
  console.log("  10. usuários e senha");
  r = await admin("/restrito/api/usuarios");
  ok(!r.dados.itens.some((u) => "senha_hash" in u), "a lista de usuários NÃO devolve o hash da senha");

  eq((await admin("/restrito/api/usuarios/" + idOper, "PUT", { papel: "chefe" })).status, 400,
     "papel inventado: recusado");
  eq((await admin("/restrito/api/usuarios/" + idOper, "PUT", { papel: "admin" })).status, 200,
     "promover operador a admin");
  await admin("/restrito/api/usuarios/" + idOper, "PUT", { papel: "operador" });

  eq((await oper("/restrito/api/eu/senha", "PUT", { atual: "errada", nova: "outra-senha-1" })).status, 401,
     "trocar senha com a atual errada: recusado");
  eq((await oper("/restrito/api/eu/senha", "PUT", { atual: SENHA_OPER, nova: "abc" })).status, 400,
     "senha nova curta demais: recusada");

  /* Trocar a senha derruba as OUTRAS sessões da mesma conta. */
  const oper1b = criarNavegador();
  await oper1b("/restrito/api/entrar", "POST", { usuario: "zz_qa_oper", senha: SENHA_OPER });
  eq((await oper1b("/restrito/api/eu")).status, 200, "segunda sessão do mesmo operador abre");
  eq((await oper("/restrito/api/eu/senha", "PUT", { atual: SENHA_OPER, nova: "zz-qa-nova-2026" })).status, 200,
     "operador troca a própria senha");
  eq((await oper1b("/restrito/api/eu")).status, 401, "a OUTRA sessão dessa conta caiu");
  eq((await oper("/restrito/api/eu")).status, 200, "a sessão de quem trocou continua");

  /* ==================================================== 11. INJEÇÃO/HTML == */
  console.log("  11. texto malicioso");
  r = await admin("/restrito/api/clientes", "POST",
    { nome: "ZZ QA Script", observacao: '<script>alert(1)</script><b>ok</b><img src=x onerror=alert(1)>' });
  const cliMau = r.dados.id; CRIADO.clientes.push(cliMau);
  linha = await Q.get("SELECT observacao FROM clientes WHERE id = ?", cliMau);
  ok(!/<script/i.test(linha.observacao), "o <script> foi removido na GRAVAÇÃO", linha.observacao);
  ok(!/onerror/i.test(linha.observacao), "o onerror foi removido", linha.observacao);
  ok(/<b>ok<\/b>/.test(linha.observacao), "a formatação legítima sobreviveu", linha.observacao);

  const tudo = await Q.all("SELECT id FROM clientes");
  r = await admin("/restrito/api/clientes", "POST", { nome: "ZZ QA'; DROP TABLE fichas; --" });
  CRIADO.clientes.push(r.dados.id);
  const depois = await Q.all("SELECT id FROM clientes");
  eq(depois.length, tudo.length + 1, "nome com SQL dentro entrou como TEXTO, sem executar nada");
  ok(await Q.get("SELECT 1 x FROM fichas LIMIT 1"), "a tabela fichas continua de pé");

  /* ==================================================== 12. DESATIVAÇÃO == */
  console.log("  12. desativar não apaga");
  eq((await admin(`/restrito/api/clientes/${cliA}/ativo`, "PUT", { ativo: false })).status, 200,
     "desativa o cliente A");
  linha = await Q.get("SELECT ativo FROM clientes WHERE id = ?", cliA);
  eq(linha.ativo, false, "ele continua no banco, apenas inativo");
  r = await admin("/restrito/api/clientes");
  ok(!r.dados.itens.some((c) => c.id === cliA), "sumiu da lista de escolha");
  r = await admin("/restrito/api/clientes?todos=1");
  ok(r.dados.itens.some((c) => c.id === cliA), "mas aparece em ?todos=1, para reativar");
  r = await admin("/restrito/api/lotes/" + lote);
  eq(Number(r.dados.pecas), 120, "e a produção já registrada NÃO mudou");
  await admin("/restrito/api/clientes/" + cliA, "PUT", { ativo: true });

  /* =========================================== 12b. LISTA PAGINADA ====== */
  console.log("  12b. lista paginada e busca");
  const criados = [];
  for (let i = 1; i <= 12; i++) {
    r = await admin("/restrito/api/clientes", "POST",
      { nome: `ZZ QA Pag ${String(i).padStart(2, "0")}`, cidade: i % 2 ? "Caruaru" : "Toritama",
        telefone: `(81) 9${i}000-0000`, documento: `1122233300018${i % 10}` });
    criados.push(r.dados.id); CRIADO.clientes.push(r.dados.id);
  }

  r = await admin("/restrito/api/clientes?pagina=1&por=5&busca=ZZ QA Pag");
  eq(r.status, 200, "lista paginada responde");
  eq(r.dados.itens.length, 5, "a página traz 5");
  eq(r.dados.total, 12, "e o total conta os 12, não os 5 devolvidos");
  eq(r.dados.paginas, 3, "12 em páginas de 5 dá 3 páginas");
  const p1 = r.dados.itens.map((c) => c.nome);

  r = await admin("/restrito/api/clientes?pagina=3&por=5&busca=ZZ QA Pag");
  eq(r.dados.itens.length, 2, "a última página traz o resto");
  ok(!r.dados.itens.some((c) => p1.includes(c.nome)), "e nenhum nome se repete entre as páginas");

  r = await admin("/restrito/api/clientes?pagina=9&por=5&busca=ZZ QA Pag");
  eq(r.dados.itens.length, 0, "página além do fim vem vazia, sem erro");

  /* A busca varre mais de um campo: quem digita o telefone acha, quem digita
     a cidade acha, e não precisa de duas caixas na tela. */
  r = await admin("/restrito/api/clientes?pagina=1&por=50&busca=Toritama");
  eq(r.dados.total, 6, "busca por cidade acha os 6 de Toritama");
  r = await admin("/restrito/api/clientes?pagina=1&por=50&busca=(81) 93000");
  eq(r.dados.total, 1, "busca por telefone acha um só");
  r = await admin("/restrito/api/clientes?pagina=1&por=50&busca=zz qa pag 01");
  eq(r.dados.total, 1, "a busca não diferencia maiúscula de minúscula");
  r = await admin("/restrito/api/clientes?pagina=1&por=50&busca=nao-existe-nada-assim");
  eq(r.dados.total, 0, "busca sem resultado devolve zero, não a lista toda");

  /* A rota SEM `pagina` continua devolvendo tudo — é o que as caixas de
     seleção da tela do operador consomem. Paginar isso as deixaria com metade
     das opções, e ninguém perceberia até faltar um cliente. */
  r = await admin("/restrito/api/clientes");
  ok(!("total" in r.dados), "sem ?pagina, a resposta não é paginada");
  ok(r.dados.itens.length >= 13, "e traz a lista inteira", String(r.dados.itens.length));

  /* Campos novos do cliente: são os que vão para a nota. */
  r = await admin("/restrito/api/clientes/" + criados[0]);
  eq(r.dados.cidade, "Caruaru", "a cidade do cliente foi gravada");
  ok(r.dados.resumo && Number(r.dados.resumo.desenhos) === 0, "o cliente vem com o resumo de produção");

  /* ================================================ 12c. TOM DA COR ===== */
  console.log("  12c. tom da cor");
  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Tom", hex: "#E8D9B5" });
  eq(r.status, 201, "cor com tom"); CRIADO.cores.push(r.dados.id);
  eq((await admin("/restrito/api/cores/" + r.dados.id)).dados.hex, "#e8d9b5",
     "o tom é normalizado para minúsculo antes do banco");

  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Tom Curto", hex: "abc" });
  eq(r.status, 201, "tom de três dígitos é aceito"); CRIADO.cores.push(r.dados.id);
  eq((await admin("/restrito/api/cores/" + r.dados.id)).dados.hex, "#aabbcc", "e vira o de seis");

  eq((await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Tom Ruim", hex: "vermelho" })).status, 400,
     "tom que não é código é recusado com mensagem, não com erro de banco");
  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Sem Tom", hex: "" });
  eq(r.status, 201, "cor sem tom continua valendo"); CRIADO.cores.push(r.dados.id);

  /* ================================================ 12d. FOTO DO DESENHO  */
  console.log("  12d. fotos do desenho");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const png = (nome) => ({ nome, dados: "data:image/png;base64," + PNG });

  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", png("Frente ZZ.PNG"));
  eq(r.status, 201, "envia a foto do desenho");
  const arq1 = r.dados.arquivo; CRIADO.arquivos.push(arq1);
  ok(/^frente-zz-[0-9a-f]{10}\.png$/.test(arq1), "o nome do arquivo é RECONSTRUÍDO, não o que veio", arq1);

  /* O nome vem do cliente, então é a primeira coisa a atacar. */
  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", png("../../../.env.png"));
  eq(r.status, 201, "nome com ../ é aceito…");
  ok(!r.dados.arquivo.includes("/") && !r.dados.arquivo.includes(".."),
     "…mas sai sem barra e sem ..", r.dados.arquivo);
  const arq2 = r.dados.arquivo; CRIADO.arquivos.push(arq2);

  /* Extensão não é prova de nada: o que vale é a assinatura do arquivo. */
  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST",
    { nome: "falsa.png", dados: "data:image/png;base64," + Buffer.from("<html><script>alert(1)</script>").toString("base64") })).status,
    400, "HTML renomeado para .png é recusado");
  /* A EXTENSÃO NÃO MANDA MAIS — QUEM MANDA É A ASSINATURA.

     Antes, o nome decidia a extensão gravada, e um PNG chamado `.jpg` era
     servido como jpeg pela rota da foto (que escolhe o tipo pela extensão).
     Agora o formato verdadeiro é lido dos primeiros bytes e o arquivo é
     batizado com ele. Duas consequências, e as duas são testadas aqui:
     conteúdo que não é imagem continua recusado, e nome errado deixa de ser
     motivo de recusa — passa a ser corrigido. */
  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST",
    { nome: "x.exe", dados: "data:;base64," + PNG });
  eq(r.status, 201, "nome com extensão errada é ACEITO…");
  ok(String(r.dados.arquivo).endsWith(".png"),
     "…e gravado com a extensão do formato de verdade", r.dados.arquivo);
  CRIADO.arquivos.push(r.dados.arquivo);

  /* Imagem COLADA não tem nome nenhum — é o caso do Ctrl+V. Exigir extensão
     obrigaria a tela a inventar um nome só para passar na validação. */
  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", { nome: "", dados: "data:;base64," + PNG });
  eq(r.status, 201, "imagem SEM nome (colada) é aceita");
  ok(String(r.dados.arquivo).startsWith("colado-"), "e recebe nome próprio", r.dados.arquivo);
  CRIADO.arquivos.push(r.dados.arquivo);

  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", { nome: "vazia.png", dados: "" })).status,
    400, "arquivo vazio é recusado");

  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`);
  eq(r.dados.itens.length, 4, "o desenho tem quatro fotos");
  eq(r.dados.itens[0].arquivo, arq1, "a primeira enviada é a primeira da lista (é a capa)");
  const foto1 = r.dados.itens[0].id, foto2 = r.dados.itens[1].id;

  r = await admin("/restrito/api/desenhos?pagina=1&por=50&todos=1&busca=ZZ QA DES A1");
  eq(r.dados.itens[0].capa, arq1, "a listagem já traz a capa, sem consulta extra");
  eq(Number(r.dados.itens[0].fotos), 4, "e a contagem de fotos");

  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos/${foto1}`, "PUT", { legenda: "frente da camisa" })).status, 200,
     "grava a legenda");
  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`);
  eq(r.dados.itens[0].legenda, "frente da camisa", "e ela volta na listagem");

  /* A foto sai por rota com sessão, não de dentro de `assets/`. O desenho é
     propriedade do cliente: em `assets/` bastaria acertar o nome para baixar
     o bordado de qualquer um, sem login. */
  r = await admin("/restrito/foto/" + arq1);
  eq(r.status, 200, "com sessão, a foto é servida");
  ok(r.tipo.includes("image/png"), "como imagem", r.tipo);
  r = await ninguem("/restrito/foto/" + arq1);
  eq(r.status, 302, "SEM sessão, a foto NÃO sai — manda para a entrada");
  eq((await oper("/restrito/foto/" + arq1)).status, 200, "o operador vê a foto (ele precisa dela na máquina)");
  /* O OPERADOR ACRESCENTA FOTO, mas não mexe nas que existem.

     Acompanha a regra de cadastrar desenho: a arte chega junto com o serviço,
     fora do horário do escritório. Apagar e reetiquetar continuam do
     administrador — apagar foto é apagar propriedade do cliente. */
  r = await oper(`/restrito/api/desenhos/${desA1}/fotos`, "POST", png("a.png"));
  eq(r.status, 201, "o operador ACRESCENTA foto");
  CRIADO.arquivos.push(r.dados.arquivo);
  const fotoDoOper = r.dados.id;
  eq((await oper(`/restrito/api/desenhos/${desA1}/fotos/${fotoDoOper}`, "DELETE")).status, 403,
     "mas NÃO apaga foto");
  eq((await oper(`/restrito/api/desenhos/${desA1}/fotos/${fotoDoOper}`, "PUT", { legenda: "x" })).status, 403,
     "nem troca a legenda");
  await admin(`/restrito/api/desenhos/${desA1}/fotos/${fotoDoOper}`, "DELETE");

  eq((await admin("/restrito/foto/..%2F..%2F.env")).status, 404, "travessia de caminho na rota da foto: 404");
  eq((await admin("/restrito/foto/nao-existe.png")).status, 404, "foto inexistente: 404");

  const fsTeste = require("node:fs"), pathTeste = require("node:path");
  const noDisco = (a) => fsTeste.existsSync(pathTeste.join(__dirname, "data", "desenhos", a));
  ok(noDisco(arq1), "o arquivo está em data/desenhos/");
  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos/${foto2}`, "DELETE")).status, 200, "apaga a segunda foto");
  ok(!noDisco(arq2), "e o ARQUIVO sai do disco junto com a linha");
  ok(noDisco(arq1), "sem levar a outra foto junto");
  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos/${foto2}`, "DELETE")).status, 404,
     "apagar de novo: 404, não erro de servidor");
  await admin(`/restrito/api/desenhos/${desA1}/fotos/${foto1}`, "DELETE");
  ok(!noDisco(arq1), "e o disco fica limpo no fim");

  /* ============================================ 12e. USUÁRIO NO PAINEL == */
  console.log("  12e. usuário criado pelo painel");
  eq((await oper("/restrito/api/usuarios", "POST", { usuario: "zz_qa_intruso" })).status, 403,
     "operador não cria usuário");

  r = await admin("/restrito/api/usuarios", "POST", { usuario: "zz_qa_novo", nome: "ZZ QA Novo", papel: "operador" });
  eq(r.status, 201, "admin cria usuário pelo painel");
  CRIADO.usuarios.push(r.dados.id);
  const senhaNova = r.dados.senha;
  ok(/^[0-9]{6}$/.test(senhaNova),
     "a senha é gerada com seis dígitos — dita-se por telefone sem soletrar", senhaNova);

  /* A senha mostrada na tela precisa REALMENTE entrar — senão o cadastro
     produz uma conta que ninguém consegue usar, e só se descobre no dia
     seguinte, com o operador parado na máquina. */
  const novo = criarNavegador("novo");
  eq((await novo("/restrito/api/entrar", "POST", { usuario: "zz_qa_novo", senha: senhaNova })).status, 200,
     "a senha mostrada uma vez é a que entra");
  eq((await novo("/restrito/api/eu")).dados.papel, "operador", "e o papel escolhido foi respeitado");

  eq((await admin("/restrito/api/usuarios", "POST", { usuario: "zz_qa_novo" })).status, 409,
     "login repetido é recusado");
  eq((await admin("/restrito/api/usuarios", "POST", { usuario: "ab" })).status, 400, "login curto demais");
  eq((await admin("/restrito/api/usuarios", "POST", { usuario: "1joao" })).status, 400, "login começando com número");
  eq((await admin("/restrito/api/usuarios", "POST", { usuario: "joão silva" })).status, 400, "login com acento e espaço");
  eq((await admin("/restrito/api/usuarios", "POST", { usuario: "zz_qa_x", papel: "chefe" })).status, 400,
     "papel inventado na criação");

  r = await admin("/restrito/api/usuarios");
  ok(!r.dados.itens.some((u) => "senha" in u || "senha_hash" in u),
     "a listagem não devolve senha nem hash");

  /* Redefinir: senha nova vale, senha velha não vale mais, sessão cai. */
  const idNovo = CRIADO.usuarios[CRIADO.usuarios.length - 1];
  r = await admin("/restrito/api/usuarios/" + idNovo + "/senha", "POST");
  eq(r.status, 200, "admin redefine a senha");
  const senha2 = r.dados.senha;
  ok(senha2 !== senhaNova, "e ela é diferente da anterior");
  eq((await novo("/restrito/api/eu")).status, 401, "a sessão de quem teve a senha trocada CAIU");

  const novo2 = criarNavegador("novo2");
  eq((await novo2("/restrito/api/entrar", "POST", { usuario: "zz_qa_novo", senha: senha2 })).status, 200,
     "a senha nova entra");
  eq((await admin("/restrito/api/usuarios/99999999/senha", "POST")).status, 404,
     "redefinir senha de quem não existe: 404");

  /* ========================================= 12g. SENHA PROVISÓRIA ======= */
  /* A senha gerada passa pelas mãos de quem cadastrou e é ditada por telefone.
     Ela abre a porta UMA vez; o sistema não deixa fazer mais nada antes da
     troca. Sem essa trava, "troque na primeira vez" seria um pedido — e pedido,
     numa fábrica em dia de correria, é o que ninguém faz. */
  console.log("  12g. senha provisória");

  r = await admin("/restrito/api/usuarios", "POST", { usuario: "zz_qa_prov", nome: "ZZ QA Provisória" });
  eq(r.status, 201, "cria o usuário");
  const idProv = r.dados.id; CRIADO.usuarios.push(idProv);
  const provisoria = r.dados.senha;
  ok(/^[0-9]{6}$/.test(provisoria), "a senha gerada tem SEIS DÍGITOS", provisoria);

  const prov = criarNavegador("prov");
  r = await prov("/restrito/api/entrar", "POST", { usuario: "zz_qa_prov", senha: provisoria });
  eq(r.status, 200, "entra com a provisória");
  eq(r.dados.trocarSenha, true, "e a resposta do login já avisa que precisa trocar");
  eq((await prov("/restrito/api/eu")).dados.trocarSenha, true, "e o /eu também");

  /* A trava é no SERVIDOR. Uma trava que morasse só no JavaScript da tela cai
     por terra assim que alguém chama a rota direto. */
  for (const [m, u] of [["GET", "/restrito/api/meu-dia"], ["GET", "/restrito/api/clientes"],
                        ["POST", "/restrito/api/jornadas"], ["GET", "/restrito/api/desenhos"]]) {
    r = await prov(u, m, m === "GET" ? undefined : {});
    eq(r.status, 403, `com senha provisória, ${m} ${u} é barrado`);
    eq(r.dados.trocarSenha, true, "e a resposta diz por quê");
  }

  eq((await prov("/restrito/api/eu/senha", "PUT", { nova: "12345" })).status, 400, "senha nova curta demais");
  eq((await prov("/restrito/api/eu/senha", "PUT", { nova: "111111" })).status, 400, "mesmo caractere repetido");
  eq((await prov("/restrito/api/eu/senha", "PUT", { nova: "123456" })).status, 400, "sequência 123456");
  eq((await prov("/restrito/api/eu/senha", "PUT", { nova: "654321" })).status, 400, "e a sequência invertida");
  eq((await prov("/restrito/api/eu/senha", "PUT", { nova: "abcdef" })).status, 400, "sequência de letras também");
  r = await prov("/restrito/api/eu/senha", "PUT", { nova: provisoria, atual: provisoria });
  eq(r.status, 400, "repetir a provisória não é trocar");

  /* Barrado é barrado: nenhuma das tentativas recusadas pode ter destravado. */
  eq((await prov("/restrito/api/meu-dia")).status, 403, "depois das recusas, a trava continua de pé");

  /* NA PRIMEIRA TROCA não se pede a senha atual — a pessoa acabou de digitá-la
     para entrar, e a tela está presa nesta operação desde então. */
  r = await prov("/restrito/api/eu/senha", "PUT", { nova: "bordado7" });
  eq(r.status, 200, "troca sem precisar repetir a atual");

  eq((await prov("/restrito/api/meu-dia")).status, 200, "e a MESMA sessão destrava, sem entrar de novo");
  eq((await prov("/restrito/api/eu")).dados.trocarSenha, false, "o /eu não pede mais a troca");

  const prov2 = criarNavegador("prov2");
  eq((await prov2("/restrito/api/entrar", "POST", { usuario: "zz_qa_prov", senha: provisoria })).status, 401,
     "a provisória não vale mais");
  r = await prov2("/restrito/api/entrar", "POST", { usuario: "zz_qa_prov", senha: "bordado7" });
  eq(r.status, 200, "a senha escolhida vale");
  eq(r.dados.trocarSenha, false, "e não pede troca de novo");

  /* Na troca VOLUNTÁRIA a atual continua sendo exigida: ali a sessão pode estar
     aberta há horas, largada na bancada da fábrica. */
  eq((await prov2("/restrito/api/eu/senha", "PUT", { nova: "outra-senha-9" })).status, 401,
     "troca voluntária SEM a senha atual: recusada");
  eq((await prov2("/restrito/api/eu/senha", "PUT", { atual: "bordado7", nova: "bordado7" })).status, 400,
     "trocar pela mesma que já valia: recusado");
  eq((await prov2("/restrito/api/eu/senha", "PUT", { atual: "bordado7", nova: "outra-senha-9" })).status, 200,
     "com a atual, troca");

  /* Redefinir pelo painel devolve a conta ao estado provisório. */
  r = await admin("/restrito/api/usuarios/" + idProv + "/senha", "POST");
  ok(/^[0-9]{6}$/.test(r.dados.senha), "a redefinição também gera seis dígitos", r.dados.senha);
  const prov3 = criarNavegador("prov3");
  r = await prov3("/restrito/api/entrar", "POST", { usuario: "zz_qa_prov", senha: r.dados.senha });
  eq(r.dados.trocarSenha, true, "e a conta volta a exigir troca no primeiro acesso");
  eq((await prov3("/restrito/api/meu-dia")).status, 403, "travada de novo, como deve");

  /* Sair não pode ficar preso atrás da trava: quem entrou por engano na conta
     de outro precisa conseguir sair sem trocar a senha de alguém. */
  eq((await prov3("/restrito/api/sair", "POST")).status, 200, "e mesmo travado dá para SAIR");

  /* ================================================ 12f. RECIBO DO LOTE == */
  console.log("  12f. recibo do lote");
  r = await admin(`/restrito/lotes/${lote}/recibo`);
  eq(r.status, 200, "o recibo responde");
  ok(r.tipo.includes("text/html"), "sai como HTML", r.tipo);

  const recibo = r.texto;
  ok(recibo.includes("Recibo de produção"), "tem o título do documento");
  ok(recibo.includes("LOTE-"), "tem o código do lote");
  ok(recibo.includes("ZZ QA Cliente A"), "tem o nome do cliente");
  ok(/class="agua"/.test(recibo), "tem a marca d'água");
  ok(/print-color-adjust: exact/.test(recibo),
     "e ela é forçada a sair na impressora — o navegador tira fundo por padrão");
  ok(recibo.includes("class=\"cabeca\""), "tem cabeçalho");
  ok(recibo.includes("Declaro que recebi"), "tem a declaração de recebimento");
  eq((recibo.match(/class="risco"/g) || []).length, 2, "tem DUAS linhas de assinatura");
  ok(recibo.includes("ZZ QA Admin") || recibo.includes("zz_qa_admin"),
     "o rodapé diz quem emitiu");

  /* Os números do papel têm de ser os MESMOS da tela. Se cada um somasse por
     conta própria, o recibo que o cliente leva embora poderia discordar da
     tela em que a nota foi conferida. */
  const daTela = await admin("/restrito/api/lotes/" + lote);
  const totalNoPapel = new Intl.NumberFormat("pt-BR").format(daTela.dados.pecas);
  ok(recibo.includes(totalNoPapel), `o total do papel é o da tela (${totalNoPapel})`);
  /* O QUE O CLIENTE NÃO VÊ.
     Ponto, cor e operador medem COMO o serviço foi feito — quanto trabalho
     deu, quem bordou, em que linha. O cliente confere o que recebeu e o que
     vai pagar, e nada disso muda o valor de nada. Ficaram inteiros na tela do
     lote; aqui a checagem é NEGATIVA, porque a forma de isso voltar por
     engano é alguém reaproveitar a quebra da tela no papel.
     Antes esta seção cobrava o contrário — mudou por pedido do dono. */
  ok(!/pontos bordados/i.test(recibo), "o recibo NÃO anuncia pontos bordados");
  ok(!/Por cor|Por operador/i.test(recibo), "nem traz as quebras por cor e por operador");
  ok(!/<th class="n">Pontos<\/th>/.test(recibo), "e nem a coluna de pontos por desenho");
  for (const c of daTela.dados.porCor)
    ok(!recibo.includes(c.nome), `a cor ${c.nome} fica fora do papel do cliente`);
  /* Mas continuam na TELA, que é onde a fábrica olha — se sumissem daqui, a
     remoção teria ido longe demais e ninguém saberia mais quem bordou o quê. */
  ok(daTela.dados.porCor.length > 0 && daTela.dados.porOperador.length > 0,
     "e continuam inteiras na tela do lote");

  /* A COMPOSIÇÃO DO RECIBO É SÓ POR DESENHO — a quebra por mercadoria saiu
     em 17/08/2026, por pedido do dono. O motivo: a mercadoria já aparece
     linha a linha na tabela acima, e repeti-la agrupada não responde nenhuma
     pergunta que o cliente faça com o papel na mão. É por DESENHO que o preço
     muda, e é isso que ele confere.

     A checagem abaixo é NEGATIVA porque a forma de o card voltar por engano é
     alguém reaproveitar a quebra da tela do lote no papel — foi assim que
     cor e operador quase voltaram.

     A ficha entra por SQL, e num lote NOVO: o `lote` da seção 8 já está
     faturado e recusa mudança de composição — que é exatamente o certo, mas
     faria este teste medir nada. */
  const fSemCor = await Q.inserir(
    `INSERT INTO fichas (usuario_id, cliente_id, desenho_id, pontuacao, quantidade, situacao, fechada_em)
     VALUES (?, ?, ?, 100, 9, 'fechada', now()) RETURNING id`, idOper, cliA, desA1);
  CRIADO.fichas.push(fSemCor);
  const fComCor = await Q.inserir(
    `INSERT INTO fichas (usuario_id, cliente_id, desenho_id, pontuacao, quantidade, cor_id, situacao, fechada_em)
     VALUES (?, ?, ?, 100, 4, ?, 'fechada', now()) RETURNING id`, idOper, cliA, desA1, corPreta);
  CRIADO.fichas.push(fComCor);

  r = await admin("/restrito/api/lotes", "POST", { cliente_id: cliA, descricao: "ZZ QA sem cor" });
  const loteSemCor = r.dados.id; CRIADO.lotes.push(loteSemCor);
  r = await admin(`/restrito/api/lotes/${loteSemCor}/fichas`, "PUT", { fichas: [fSemCor, fComCor] });
  eq(r.dados.anexadas, 2, "as duas fichas entraram no lote de teste");

  const comSemCor = await admin(`/restrito/lotes/${loteSemCor}/recibo`);
  /* Procura o TÍTULO DO CARD (`<h3>`), não o texto solto: o comentário que
     explica a remoção, dentro do próprio gerador do recibo, contém a
     expressão — e um teste que casasse com ele acusaria a explicação da
     ausência como se fosse a presença. */
  ok(!/<h3>Por mercadoria<\/h3>/.test(comSemCor.texto),
     "o recibo NÃO traz mais o card por mercadoria");
  ok(/<h3>Peças por desenho<\/h3>/.test(comSemCor.texto),
     "mas continua trazendo o card por desenho — é por ele que o preço muda");

  /* A SOMA DA QUEBRA TEM DE BATER COM O TOTAL DE PEÇAS logo acima dela. Era o
     que o teste da mercadoria protegia: uma quebra que engolisse uma linha
     deixaria dois números diferentes no MESMO papel, e o cliente confere os
     dois. Por desenho o risco é menor (`desenho_id` é NOT NULL), mas o papel
     é assinado — a conferência continua. */
  const doLoteSemCor = await admin("/restrito/api/lotes/" + loteSemCor);
  const somaDesenhos = doLoteSemCor.dados.porDesenho.reduce((a, d) => a + Number(d.pecas), 0);
  eq(somaDesenhos, Number(doLoteSemCor.dados.pecas),
     "a quebra por desenho soma o mesmo que o total de peças do lote");
  ok(comSemCor.texto.includes(new Intl.NumberFormat("pt-BR").format(doLoteSemCor.dados.pecas)),
     "e esse total está impresso no papel");
  /* O quadro de totais tem UMA caixa: peças. Se alguém reintroduzir cor ou
     operador ali, este número de caixas muda e o teste avisa. */
  eq((comSemCor.texto.match(/class="total /g) || []).length, 1,
     "e o quadro de totais tem uma caixa só — peças produzidas");

  /* A ORIENTAÇÃO é o motivo de o recibo ser gerado no servidor: `@page` não
     existe sem folha de estilo, e sem ele o navegador sempre imprimiria em pé. */
  ok(/@page \{ size: A4 portrait/.test(recibo), "sem parâmetro, o papel sai em pé");
  r = await admin(`/restrito/lotes/${lote}/recibo?orientacao=paisagem`);
  ok(/@page \{ size: A4 landscape/.test(r.texto), "com ?orientacao=paisagem, sai deitado");
  ok(r.texto.includes("landscape") && !r.texto.includes("size: A4 portrait"),
     "e não sobra a regra de retrato junto");
  r = await admin(`/restrito/lotes/${lote}/recibo?orientacao=inventada`);
  ok(/@page \{ size: A4 portrait/.test(r.texto), "orientação inventada cai no retrato, sem erro");

  eq((await admin("/restrito/lotes/99999999/recibo")).status, 404, "recibo de lote que não existe: 404");
  eq((await oper(`/restrito/lotes/${lote}/recibo`)).status, 403, "operador não emite recibo");
  eq((await ninguem(`/restrito/lotes/${lote}/recibo`)).status, 302,
     "sem sessão, o recibo não sai — manda para a entrada");

  /* Texto do cliente vai para dentro do HTML do recibo: se não fosse escapado,
     um nome com `<` quebraria o documento — ou pior. */
  r = await admin("/restrito/api/clientes", "POST", { nome: 'ZZ QA <script>alert(1)</script>' });
  CRIADO.clientes.push(r.dados.id);
  r = await admin("/restrito/api/lotes", "POST", { cliente_id: r.dados.id, descricao: 'aspas " e <b>tags</b>' });
  CRIADO.lotes.push(r.dados.id);
  r = await admin(`/restrito/lotes/${r.dados.id}/recibo`);
  ok(!/<script>alert\(1\)<\/script>/.test(r.texto), "nome com script sai escapado no recibo");
  ok(r.texto.includes("&lt;script&gt;"), "…como texto visível", "");

  /* ============================ 12h. EXCLUIR × DESATIVAR ================ */
  /* Cadastro nunca usado é engano de digitação: apagar é o certo. Cadastro já
     usado está dentro de uma ficha que virou nota — esse só desativa. A regra
     precisa valer nas SETE tabelas, e é aqui que se prova uma a uma. */
  console.log("  12h. excluir × desativar");

  /* --- sem vínculo: some de verdade --- */
  const paraApagar = {};
  for (const [tab, corpo] of [
    ["clientes", { nome: "ZZ QA Apagar Cliente" }],
    ["mercadorias", { nome: "ZZ QA Apagar Mercadoria" }],
    ["cores", { nome: "ZZ QA Apagar Cor" }],
    ["maquinas", { nome: "ZZ QA Apagar Maquina" }],
  ]) {
    r = await admin("/restrito/api/" + tab, "POST", corpo);
    paraApagar[tab] = r.dados.id; CRIADO[tab].push(r.dados.id);
  }
  r = await admin("/restrito/api/desenhos", "POST",
    { nome: "ZZ QA Apagar Desenho", cliente_id: paraApagar.clientes, pontuacao: "500" });
  paraApagar.desenhos = r.dados.id; CRIADO.desenhos.push(r.dados.id);

  /* O desenho segura o cliente — é vínculo, mesmo sem produção nenhuma. */
  r = await admin("/restrito/api/clientes/" + paraApagar.clientes, "DELETE");
  eq(r.status, 409, "cliente com desenho não é excluído");
  ok(/1 desenho/.test(r.dados.error), "e a mensagem diz o que segura", r.dados.error);
  eq(r.dados.podeDesativar, true, "e oferece desativar");

  eq((await admin("/restrito/api/desenhos/" + paraApagar.desenhos, "DELETE")).status, 200,
     "desenho sem ficha é excluído");
  ok(!(await admin("/restrito/api/desenhos/" + paraApagar.desenhos)).dados.id,
     "e some do banco de verdade — não fica inativo");

  for (const tab of ["clientes", "mercadorias", "cores", "maquinas"]) {
    r = await admin("/restrito/api/" + tab + "/" + paraApagar[tab], "DELETE");
    eq(r.status, 200, `${tab}: sem vínculo, exclui`);
    eq(r.dados.excluido, true, `${tab}: e diz que EXCLUIU, não que desativou`);
    eq((await admin("/restrito/api/" + tab + "/" + paraApagar[tab])).status, 404,
       `${tab}: sumiu do banco`);
    CRIADO[tab] = CRIADO[tab].filter((x) => x !== paraApagar[tab]);
  }

  /* --- com vínculo: recusa, e desativar continua funcionando --- */
  for (const [tab, alvo, oQue] of [["clientes", cliA, "cliente"], ["desenhos", desA1, "desenho"],
                                   ["mercadorias", merc, "mercadoria"], ["cores", corPreta, "cor"],
                                   ["maquinas", maq, "máquina"]]) {
    r = await admin("/restrito/api/" + tab + "/" + alvo, "DELETE");
    eq(r.status, 409, `${oQue} em uso NÃO é excluído`);
    ok(/ficha|desenho|lote/.test(r.dados.error || ""), `${oQue}: a mensagem diz por quê`, r.dados.error);
    ok(Array.isArray(r.dados.vinculos) && r.dados.vinculos.length,
       `${oQue}: e a tela recebe a lista do que segura`);
    eq((await admin("/restrito/api/" + tab + "/" + alvo)).status, 200, `${oQue}: continua lá, intacto`);
  }

  eq((await admin(`/restrito/api/clientes/${cliA}/ativo`, "PUT", { ativo: false })).status, 200,
     "mas desativar funciona");
  eq((await admin("/restrito/api/clientes/" + cliA)).dados.ativo, false, "e ficou inativo");
  eq((await admin(`/restrito/api/lotes/${lote}`)).dados.pecas, 120,
     "sem mexer numa vírgula da produção já registrada");
  await admin(`/restrito/api/clientes/${cliA}/ativo`, "PUT", { ativo: true });

  eq((await oper(`/restrito/api/clientes/${cliA}/ativo`, "PUT", { ativo: false })).status, 403,
     "operador não desativa cadastro");
  eq((await oper("/restrito/api/cores/" + corPreta, "DELETE")).status, 403, "nem exclui");

  /* --- máquina: desativar mata o QR --- */
  const tokenAntes = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  r = await admin(`/restrito/api/maquinas/${maq}/ativo`, "PUT", { ativo: false });
  eq(r.dados.qrInvalidado, true, "desativar máquina avisa que o QR morreu");
  const tokenDepois = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  ok(tokenAntes !== tokenDepois, "e o token REALMENTE mudou");
  eq((await oper("/restrito/api/maquina-do-qr?m=" + encodeURIComponent(tokenAntes))).status, 404,
     "o adesivo antigo não é mais reconhecido");

  /* Reativar não pode ressuscitar o adesivo velho: ele passou meses fora de uso
     e pode ter ido parar em qualquer lugar. */
  await admin(`/restrito/api/maquinas/${maq}/ativo`, "PUT", { ativo: true });
  eq((await oper("/restrito/api/maquina-do-qr?m=" + encodeURIComponent(tokenAntes))).status, 404,
     "e reativar NÃO faz o adesivo antigo voltar a valer");
  eq((await oper("/restrito/api/maquina-do-qr?m=" + encodeURIComponent(tokenDepois))).status, 200,
     "só a etiqueta nova funciona");

  /* --- usuários --- */
  r = await admin("/restrito/api/usuarios", "POST", { usuario: "zz_qa_apagar", nome: "ZZ QA Apagar" });
  const idApagar = r.dados.id; CRIADO.usuarios.push(idApagar);
  r = await admin("/restrito/api/usuarios/" + idApagar, "DELETE");
  eq(r.status, 200, "usuário que nunca produziu é excluído");
  CRIADO.usuarios = CRIADO.usuarios.filter((x) => x !== idApagar);
  ok(!(await admin("/restrito/api/usuarios")).dados.itens.some((u) => u.id === idApagar),
     "e sai da lista");

  r = await admin("/restrito/api/usuarios/" + idOper, "DELETE");
  eq(r.status, 409, "operador COM produção não é excluído");
  ok(/ficha/.test(r.dados.error), "e a mensagem diz quantas fichas", r.dados.error);
  eq((await admin("/restrito/api/usuarios/" + idOper, "PUT", { ativo: false })).status, 200,
     "mas desativar funciona");
  await admin("/restrito/api/usuarios/" + idOper, "PUT", { ativo: true });

  /* Apagar a si mesmo deixaria a sessão viva apontando para um id que não
     existe — e a próxima tela quebraria sem dizer por quê. */
  const euAdmin = (await admin("/restrito/api/usuarios")).dados.itens
    .filter((u) => u.usuario === "zz_qa_admin")[0];
  eq((await admin("/restrito/api/usuarios/" + euAdmin.id, "DELETE")).status, 409,
     "ninguém exclui a própria conta");
  eq((await oper("/restrito/api/usuarios/" + idOper2, "DELETE")).status, 403, "operador não exclui usuário");

  /* --- lotes --- */
  r = await admin("/restrito/api/lotes", "POST", { cliente_id: cliA, descricao: "ZZ QA lote vazio" });
  const loteVazio = r.dados.id; CRIADO.lotes.push(loteVazio);
  r = await admin("/restrito/api/lotes/" + loteVazio, "DELETE");
  eq(r.status, 200, "lote VAZIO é apagado");
  CRIADO.lotes = CRIADO.lotes.filter((x) => x !== loteVazio);

  /* Antes ele soltava as fichas sozinho e se apagava. Conveniente e errado:
     quem clica em "apagar" num lote com 40 fichas está pensando no lote, não
     nas 40 — desfazer a composição tem de ser um ato à parte. */
  r = await admin("/restrito/api/lotes/" + loteSemCor, "DELETE");
  eq(r.status, 409, "lote COM fichas dentro não é apagado");
  ok(/2 fichas/.test(r.dados.error), "e diz quantas estão dentro", r.dados.error);
  eq((await admin("/restrito/api/lotes/" + loteSemCor)).dados.fichas.length, 2,
     "e as fichas continuam onde estavam");

  await admin(`/restrito/api/lotes/${loteSemCor}/fichas`, "PUT", { fichas: [] });
  eq((await admin("/restrito/api/lotes/" + loteSemCor, "DELETE")).status, 200,
     "esvaziado em “Juntar fichas”, aí sim sai");
  CRIADO.lotes = CRIADO.lotes.filter((x) => x !== loteSemCor);

  /* ============================== 12i. PREÇO — o que o operador não vê === */
  /* A lista de desenhos é a rota mais chamada do sistema, e quem mais a chama
     é justamente a tela que menos pode ver este campo: o operador a consulta a
     cada ficha que abre. */
  console.log("  12i. preço do desenho");

  eq((await admin("/restrito/api/desenhos/" + desA1, "PUT", { preco: "12,50" })).status, 200,
     "admin põe preço no desenho");
  eq((await admin("/restrito/api/desenhos/" + desA1)).dados.preco, 12.5,
     "o preço é gravado com os centavos certos");

  /* Dinheiro digitado por gente: o separador decimal é o último ponto ou
     vírgula com 1 ou 2 dígitos depois; o resto é milhar e some. */
  await admin("/restrito/api/desenhos/" + desA2, "PUT", { preco: "R$ 1.234,56" });
  eq((await admin("/restrito/api/desenhos/" + desA2)).dados.preco, 1234.56,
     "aceita R$ com ponto de milhar e vírgula decimal");
  await admin("/restrito/api/desenhos/" + desA2, "PUT", { preco: "8" });
  eq((await admin("/restrito/api/desenhos/" + desA2)).dados.preco, 8, "aceita número inteiro");
  eq((await admin("/restrito/api/desenhos/" + desA2, "PUT", { preco: "doze reais" })).status, 400,
     "texto que não é número é recusado");

  /* VAZIO É NULO, NÃO ZERO — "ainda não precifiquei" contra "é de graça". Sem
     a distinção, o desenho entra valendo R$ 0,00 num lote faturado. */
  await admin("/restrito/api/desenhos/" + desA2, "PUT", { preco: "" });
  eq((await admin("/restrito/api/desenhos/" + desA2)).dados.preco, null,
     "preço em branco vira NULO, não zero");

  /* O VAZAMENTO QUE ISTO IMPEDE: as consultas nasceram com `SELECT d.*`. O
     operador não veria o campo na tela — só o receberia no corpo da resposta,
     à vista de quem abrisse o navegador. */
  r = await oper("/restrito/api/desenhos?todos=1");
  const doOper = r.dados.itens.filter((d) => String(d.id) === String(desA1))[0];
  ok(doOper && !("preco" in doOper), "operador NÃO recebe o preço na LISTA de desenhos",
     JSON.stringify(doOper && doOper.preco));
  ok(!("preco" in (await oper("/restrito/api/desenhos/" + desA1)).dados), "nem no desenho aberto");
  ok("preco" in (await admin("/restrito/api/desenhos/" + desA1)).dados, "e o admin recebe");

  /* O outro lado: sem o campo na tela, mas com a rota na mão, o operador ainda
     poderia MANDAR um preço que o escritório não escolheu. */
  r = await oper("/restrito/api/desenhos", "POST",
    { nome: "ZZ QA DES OPER", cliente_id: cliA, pontuacao: "500", preco: "999,99" });
  eq(r.status, 201, "operador CADASTRA desenho (a arte chega fora do horário do escritório)");
  const desOper = r.dados.id; CRIADO.desenhos.push(desOper);
  eq(r.dados.semPreco, true, "e a resposta avisa que ele nasceu sem preço");
  eq((await admin("/restrito/api/desenhos/" + desOper)).dados.preco, null,
     "o preço que o operador mandou foi DESCARTADO");

  eq((await oper("/restrito/api/desenhos/" + desOper, "PUT", { nome: "ZZ QA OUTRO" })).status, 403,
     "mas o operador NÃO altera desenho — mudar a pontuação muda fichas abertas");
  eq((await oper("/restrito/api/desenhos/" + desOper, "DELETE")).status, 403, "nem exclui");
  eq((await oper("/restrito/api/clientes", "POST", { nome: "ZZ QA Cli Oper" })).status, 403,
     "e a exceção é SÓ para desenho — cliente continua fechado");

  r = await admin("/restrito/api/desenhos?todos=1&sem_preco=1");
  ok(r.dados.itens.some((d) => String(d.id) === String(desOper)),
     "o filtro “sem preço” acha o desenho que o operador cadastrou");
  ok(!r.dados.itens.some((d) => String(d.id) === String(desA1)), "e não traz os que já têm preço");

  /* ===================== 12j. buscar desenho pelo nome do CLIENTE ======== */
  console.log("  12j. busca de desenho por cliente");
  r = await admin("/restrito/api/desenhos?pagina=1&por=50&todos=1&busca=ZZ QA Cliente A");
  ok(r.dados.itens.length >= 2, "buscar pelo nome do CLIENTE traz os desenhos dele",
     "vieram " + r.dados.itens.length);
  ok(r.dados.itens.every((d) => String(d.cliente_id) === String(cliA)), "e só os dele");
  /* O total sai de uma consulta própria. Sem o JOIN nela, esta busca não
     devolveria zero: derrubaria a consulta inteira, e a tela ficaria sem
     paginação exatamente quando alguém busca. */
  ok(Number(r.dados.total) >= 2, "e a contagem da paginação sobrevive ao JOIN", String(r.dados.total));
  eq((await admin("/restrito/api/desenhos?pagina=1&por=50&todos=1&busca=ZZ QA DES B1")).dados.itens.length, 1,
     "buscar pelo nome do DESENHO continua funcionando");

  r = await admin("/restrito/api/desenhos?todos=1&cliente=" + cliB);
  ok(r.dados.itens.length >= 1 && r.dados.itens.every((d) => String(d.cliente_id) === String(cliB)),
     "e o filtro por cliente serve a gaveta da modal");

  /* ============================ 12k. valor da ficha e correção ========== */
  console.log("  12k. valor da ficha e correção do admin");

  await admin("/restrito/api/desenhos/" + desB1, "PUT", { preco: "10,00" });
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliB, desenho_id: desB1 });
  eq(r.status, 201, "operador abre ficha de desenho precificado");
  const fVal = r.dados.id; CRIADO.fichas.push(fVal);
  await oper("/restrito/api/fichas/" + fVal + "/fechar", "PUT", { quantidade: "7" });

  r = await admin("/restrito/api/fichas/" + fVal);
  eq(r.dados.preco_unitario, 10, "a ficha guardou o preço do desenho");
  eq(r.dados.total_valor, 70, "e o total é calculado PELO BANCO (7 × 10)");

  /* O motivo de o preço ser cópia e não join: reajuste não reescreve nota. */
  await admin("/restrito/api/desenhos/" + desB1, "PUT", { preco: "99,00" });
  eq((await admin("/restrito/api/fichas/" + fVal)).dados.total_valor, 70,
     "reajustar o desenho NÃO mexe na ficha já fechada");

  r = await admin("/restrito/api/fichas/" + fVal, "PUT",
    { aberta_em: "2026-08-01T08:00:00", fechada_em: "2026-08-01T11:30:00" });
  eq(r.status, 200, "admin corrige as horas da ficha");
  eq(new Date(r.dados.ficha.fechada_em) - new Date(r.dados.ficha.aberta_em), 3.5 * 3600e3,
     "e a duração passa a ser a corrigida");

  /* ====================================================================
     HORA SEM FUSO VALE NO FUSO DA FÁBRICA — NUNCA NO DO SERVIDOR.

     O defeito real: o operador fechou às 07:37, o administrador corrigiu um
     campo QUALQUER, e a ficha voltou 3 horas (05:23 → 02:23) — a modal
     mandava "2026-08-20T05:23" sem fuso e o servidor, rodando em UTC, o
     interpretava como UTC. Este teste crava o INSTANTE esperado com o fuso
     da fábrica por extenso: rodando a suíte com TZ=UTC (é assim que o CI
     deve rodar), uma regressão desloca o instante em 3h e cai aqui. */
  eq(new Date(r.dados.ficha.aberta_em).getTime(), new Date("2026-08-01T08:00:00-03:00").getTime(),
     "hora sem fuso é interpretada no fuso da FÁBRICA (-03), não no do servidor");
  /* E salvar o que a tela devolve NÃO desloca nada: a modal manda o instante
     completo (ISO com Z) — regravar o mesmo valor tem de ser neutro. */
  r = await admin("/restrito/api/fichas/" + fVal, "PUT",
    { aberta_em: new Date("2026-08-01T08:00:00-03:00").toISOString(),
      fechada_em: new Date("2026-08-01T11:30:00-03:00").toISOString() });
  eq(new Date(r.dados.ficha.aberta_em).getTime(), new Date("2026-08-01T08:00:00-03:00").getTime(),
     "regravar o mesmo instante (ISO com Z) não move a hora nem um minuto");

  /* Fim antes do início não quebra nada visível: a peça continua contando e o
     que fica negativo é o tempo por peça, que entra na média do dia. */
  /* DUAS CAMADAS recusam isto, e o teste precisa dizer QUAL. O banco tem o
     `ck_ficha_ordem_do_tempo`, e ele é a garantia de verdade; a conferência na
     aplicação existe para a pessoa ler uma frase em vez de um erro de driver.
     Conferindo só o status 400, desligar a checagem da aplicação não derruba
     teste nenhum — o banco recusa igual e o 400 continua vindo. Só a MENSAGEM
     separa as duas. */
  r = await admin("/restrito/api/fichas/" + fVal, "PUT", { fechada_em: "2026-07-31T06:00:00" });
  eq(r.status, 400, "fim ANTES do início é recusado — mesmo mexendo só num dos dois campos");
  eq(r.dados.error, "o fim não pode ser antes do início",
     "e quem recusou foi a APLICAÇÃO, com uma frase — não o banco, com um erro de driver");
  eq(String((await admin("/restrito/api/fichas/" + fVal)).dados.fechada_em).slice(0, 10), "2026-08-01",
     "e a hora antiga continua lá: a recusa não gravou pela metade");

  eq((await admin("/restrito/api/fichas/" + fVal, "PUT", { aberta_em: "não é data" })).status, 400,
     "data sem sentido é recusada, e não vira NULO em silêncio");

  r = await admin("/restrito/api/fichas/" + fVal, "PUT", { preco_unitario: "12,00" });
  eq(r.status, 200, "admin corrige o valor da ficha");
  eq(r.dados.ficha.total_valor, 84, "e o total recalcula sozinho (7 × 12)");
  eq((await admin("/restrito/api/desenhos/" + desB1)).dados.preco, 99,
     "sem mexer no preço do CADASTRO do desenho");

  eq((await oper("/restrito/api/fichas/" + fVal, "PUT", { quantidade: "1" })).status, 403,
     "operador não corrige ficha");

  /* ================== 12k-ter. produção: tudo por padrão, e sem mentir ==== */
  console.log("  12k-ter. produção sem filtro");

  /* SEM FILTRO A ROTA DEVOLVE TUDO. A tela abria no dia; quem chegava a ela
     para conferir a semana encontrava lista vazia sempre que ainda não houvesse
     produção naquele dia — e vazio não se distingue de quebrado. */
  r = await admin("/restrito/api/producao");
  eq(r.status, 200, "produção sem filtro responde");
  ok(Number(r.dados.total) >= 4, "e traz TODA a produção registrada", "total " + r.dados.total);

  /* MAIS RECENTE PRIMEIRO. É a ordem em que se procura o que acabou de sair da
     máquina, e a razão de a tela abrir aqui. */
  const datas = r.dados.fichas.map((f) => f.fechada_em);
  ok(datas.every((d, i) => i === 0 || String(datas[i - 1]) >= String(d)),
     "com as mais recentes no começo", JSON.stringify(datas.slice(0, 3)));

  /* ------------------------------------------------------------------
     A PÁGINA NÃO PODE MENTIR SOBRE O TOTAL

     Os totais são contados no BANCO, sobre o filtro inteiro. Antes eram
     somados sobre as linhas devolvidas — o que só nunca deu problema porque a
     tela abria no dia e a lista nunca enchia. Aberta em "tudo" e paginada, os
     números do alto passariam a ser os da PÁGINA: virar a página mudaria o
     total de peças, e o número que vai para a nota seria o que coube na tela.
     ------------------------------------------------------------------ */
  /* `>=` passaria com o total saindo do tamanho da página. Pedindo UMA por
     página com mais de uma ficha no banco, só o total do FILTRO satisfaz o
     `>`: é o que separa "contou o banco" de "contou o que devolveu". */
  const umaSo = await admin("/restrito/api/producao?por=1&pagina=1");
  eq(umaSo.dados.fichas.length, 1, "com `por=1` vem uma ficha só");
  ok(Number(umaSo.dados.total) > 1,
     "e o total continua sendo o do filtro inteiro, maior que a página",
     "total " + umaSo.dados.total);

  /* A prova que separa "somou o banco" de "somou as linhas da página": o
     total de peças tem de bater com a soma de TODAS as fichas fechadas,
     contada aqui por fora, por SQL. */
  const conferencia = await Q.get(
    "SELECT COUNT(*) c, COALESCE(SUM(quantidade),0) p, COALESCE(SUM(total_pontos),0) pt FROM fichas WHERE situacao = 'fechada'");
  eq(Number(r.dados.total), Number(conferencia.c), "o número de fichas bate com o banco");
  eq(Number(r.dados.soma.pecas), Number(conferencia.p), "as peças também");
  eq(Number(r.dados.soma.pontos), Number(conferencia.pt), "e os pontos");

  /* O mesmo vale para a quebra por operador: agrupada pelo BANCO, não pelas
     linhas que couberam. */
  const somaOp = Object.values(r.dados.porOperador).reduce((a, o) => a + Number(o.pecas), 0);
  eq(somaOp, Number(conferencia.p), "a quebra por operador soma o mesmo que o total");

  /* ------------------------------------------------------------------
     A PAGINAÇÃO EM SI

     Pedindo duas por página, a lista tem de partir — e as duas páginas juntas
     têm de dar exatamente o conjunto, sem repetir nem perder ninguém. Repetir
     é o que acontece quando o ORDER BY não é determinístico; perder é o que
     acontece quando o OFFSET é calculado com a página começando em zero.
     ------------------------------------------------------------------ */
  const pag1 = await admin("/restrito/api/producao?por=2&pagina=1");
  const pag2 = await admin("/restrito/api/producao?por=2&pagina=2");
  eq(pag1.dados.porPagina, 2, "a página respeita o `por` pedido");
  ok(pag1.dados.fichas.length <= 2, "e devolve no máximo isso", String(pag1.dados.fichas.length));
  eq(pag1.dados.paginas, Math.ceil(Number(pag1.dados.total) / 2), "o número de páginas fecha com o total");
  eq(pag1.dados.pagina, 1, "a página 1 se identifica");
  eq(pag2.dados.pagina, 2, "e a 2 também");
  eq(Number(pag2.dados.total), Number(pag1.dados.total), "o total NÃO muda de uma página para a outra");
  eq(Number(pag2.dados.soma.pecas), Number(pag1.dados.soma.pecas), "nem a soma de peças");

  const ids1 = pag1.dados.fichas.map((f) => f.id), ids2 = pag2.dados.fichas.map((f) => f.id);
  ok(!ids1.some((x) => ids2.indexOf(x) >= 0), "nenhuma ficha aparece nas duas páginas",
     JSON.stringify({ ids1, ids2 }));

  /* `?pagina=0` viraria OFFSET negativo, que o Postgres recusa — a tela
     inteira quebraria com erro de driver por causa de uma URL editada à mão. */
  /* `pagina=0` cai no `|| 1` sozinho (zero é falso em JavaScript) — quem
     produz OFFSET NEGATIVO, que o Postgres recusa com erro de driver, é o
     número negativo. É esse que a trava precisa segurar, e por isso é esse
     que se testa. */
  eq((await admin("/restrito/api/producao?por=2&pagina=0")).dados.pagina, 1, "página 0 vira 1");
  r = await admin("/restrito/api/producao?por=2&pagina=-3");
  eq(r.status, 200, "página NEGATIVA não derruba a consulta");
  eq(r.dados.pagina, 1, "e é tratada como a primeira");
  ok(r.dados.fichas.length > 0, "devolvendo conteúdo, não erro de driver");

  /* E o teto do `por`: sem ele, uma requisição pediria a tabela inteira. */
  eq((await admin("/restrito/api/producao?por=99999")).dados.porPagina, 500,
     "o `por` tem teto — ninguém pede a tabela inteira numa requisição");

  /* Filtro de data continua valendo, e é o que estreita quando o corte incomoda. */
  r = await admin("/restrito/api/producao?de=2099-01-01");
  eq(Number(r.dados.total), 0, "filtro de data que não pega nada devolve zero");
  eq(Number(r.dados.soma.pecas), 0, "com os totais zerados, e não os da consulta anterior");

  /* ============ 12k-quinquies. o que está NA MÁQUINA agora ============== */
  console.log("  12k-quinquies. fichas em produção na tela de Produção");

  /* A tela mostrava só o que já saiu da máquina. Faltava o que está nela —
     e sem isso o escritório não tinha como saber, olhando a tela, se alguém
     está produzindo agora ou se a fábrica parou.

     As três garantias abaixo são o contrato dessa lista, e cada uma existe
     porque a alternativa produz um número errado que não se apresenta como
     errado. */
  const antesDeAbrir = await admin("/restrito/api/producao");
  const pecasAntes = Number(antesDeAbrir.dados.soma.pecas);
  const fichasAntes = Number(antesDeAbrir.dados.total);
  ok(Array.isArray(antesDeAbrir.dados.abertas), "a resposta traz a lista de abertas");

  /* Abre uma ficha de verdade, pelo caminho do operador.

     O TOKEN É RELIDO DO BANCO AQUI. O da seção 5 já não vale: desativar uma
     máquina ROTACIONA o token do QR — é o que mata o adesivo antigo —, e o
     teste 12h faz exatamente isso. Reaproveitar a variável antiga devolvia
     "QR de máquina não reconhecido", e o erro parecia ser da ficha. */
  const tokenAgora = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  const abertaProva = await oper("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, maquina_token: tokenAgora });
  ok(abertaProva.status === 201, "o operador abre uma ficha", JSON.stringify(abertaProva.dados));
  const idAberta = abertaProva.dados.id;
  /* NA LISTA DE LIMPEZA NA MESMA LINHA em que nasce. Sem isto a ficha fica no
     banco e a faxina final estoura no RESTRICT do desenho — o erro aparece
     depois de tudo ter passado, e parece defeito da limpeza, não deste teste. */
  CRIADO.fichas.push(idAberta);

  r = await admin("/restrito/api/producao");
  const naLista = (r.dados.abertas || []).filter((f) => String(f.id) === String(idAberta));
  eq(naLista.length, 1, "a ficha aberta aparece em `abertas`");
  ok(naLista[0].cliente_nome && naLista[0].desenho_nome && naLista[0].operador_nome,
     "com cliente, desenho e operador — a linha da tela é montada com isso");
  ok(naLista[0].aberta_em, "e com a hora da abertura, para a tela contar o tempo");

  /* NÃO ENTRA NA LISTA DAS FECHADAS. Se entrasse, a linha apareceria duas
     vezes na tabela — e o rodapé somaria uma quantidade que não existe. */
  ok(!r.dados.fichas.some((f) => String(f.id) === String(idAberta)),
     "e NÃO aparece entre as fechadas");

  /* NÃO MEXE NOS TOTAIS. É a garantia que protege a nota: ficha aberta não
     tem quantidade, e contá-la faria o indicador de peças do período
     discordar do que a fábrica entregou. */
  eq(Number(r.dados.soma.pecas), pecasAntes, "o total de peças NÃO muda com a ficha aberta");
  eq(Number(r.dados.total), fichasAntes, "nem a contagem de fichas do período");

  /* IGNORA O FILTRO DE PERÍODO. O período pergunta sobre o passado; a ficha
     aberta é o presente. Um recorte no ano que vem não pode esconder o que
     está na máquina agora — é justamente assim que a ficha esquecida some. */
  const noFuturo = await admin("/restrito/api/producao?de=2099-01-01");
  ok((noFuturo.dados.abertas || []).some((f) => String(f.id) === String(idAberta)),
     "a ficha aberta aparece mesmo com filtro de período que não pega nada");
  eq(Number(noFuturo.dados.total), 0, "e o total do período continua zero");

  /* MAS RESPEITA QUEM/O QUÊ. Filtrar por outro cliente tem de escondê-la:
     esses filtros recortam o assunto, não o tempo. */
  const outroCliente = await admin("/restrito/api/producao?cliente=" + cliB);
  ok(!(outroCliente.dados.abertas || []).some((f) => String(f.id) === String(idAberta)),
     "filtrando por outro cliente, a ficha aberta some");

  /* DA MAIS ANTIGA PARA A MAIS NOVA: a esquecida ontem fica no topo, que é o
     problema que esta lista existe para mostrar. */
  const horas = (r.dados.abertas || []).map((f) => String(f.aberta_em));
  ok(horas.every((h, i) => i === 0 || horas[i - 1] <= h),
     "as abertas vêm da mais antiga para a mais nova", JSON.stringify(horas));

  /* Fechada, ela sai de `abertas` e entra nos totais — o ciclo fecha. */
  eq((await oper("/restrito/api/fichas/" + idAberta + "/fechar", "PUT",
     { quantidade: 3, mercadoria_id: merc, cor_id: corBranca })).status, 200,
     "o operador fecha a ficha da prova");
  r = await admin("/restrito/api/producao");
  ok(!(r.dados.abertas || []).some((f) => String(f.id) === String(idAberta)),
     "fechada, ela sai de `abertas`");
  eq(Number(r.dados.soma.pecas), pecasAntes + 3, "e as 3 peças entram no total");

  /* ====== 12k-sexies. a nota antiga: data do bordado, valor e atalhos ==== */
  console.log("  12k-sexies. data do bordado, valor da ficha e a nota do lote");

  /* O PEDIDO ATRÁS DESTA SEÇÃO

     O escritório precisa lançar serviço que JÁ FOI FEITO — nota antiga, ou
     avulsa — e emitir a nota sem sair da tela do lote. As garantias abaixo são
     o contrato disso, e cada uma existe porque a alternativa produz um número
     errado que não se apresenta como errado. */

  /* --- 1. a data do bordado é do ADMINISTRADOR ------------------------- */
  /* Se o operador pudesse mandar a data, a produção dele passaria a ser
     escolha dele: a hora por peça mediria o que a pessoa digitou. */
  const tokenSexies = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  r = await oper("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, maquina_token: tokenSexies, aberta_em: "2026-01-05T09:00" });
  eq(r.status, 403, "o operador NÃO escolhe a data do bordado");

  /* Vazio não é escolha. O campo nem é escrito na tela dele, mas um cliente
     que mande `aberta_em: ""` não pode ser barrado por isso — seria recusar
     quem não pediu nada. */
  r = await oper("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, maquina_token: tokenSexies, aberta_em: "" });
  eq(r.status, 201, "mas string vazia passa — vazio não é escolha de data");
  const fichaVazia = r.dados.id;
  CRIADO.fichas.push(fichaVazia);
  eq((await oper("/restrito/api/fichas/" + fichaVazia + "/cancelar", "PUT")).status, 200,
     "e essa ficha sai do caminho");

  /* --- 2. data no futuro é recusada ------------------------------------ */
  r = await admin("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, aberta_em: "2099-03-01T10:00" });
  eq(r.status, 400, "data no futuro é recusada");
  r = await admin("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, aberta_em: "isto não é data" });
  eq(r.status, 400, "e texto que não é data também");

  /* --- 3. a ficha retroativa CONTA NO DIA DELA ------------------------- */
  /* É a garantia que sustenta a nota antiga. Todo o relatório sai de
     `fechada_em`; fechar com `now()` jogaria a peça para o dia de hoje —
     exatamente o que escolher a data existe para evitar, e em silêncio,
     porque o início da ficha ficaria com a data certa. */
  const DIA_ANTIGO = "2026-01-05";
  r = await admin("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, aberta_em: DIA_ANTIGO + "T09:00" });
  eq(r.status, 201, "o administrador abre ficha com a data do bordado", JSON.stringify(r.dados));
  const fichaAntiga = r.dados.id;
  CRIADO.fichas.push(fichaAntiga);

  let fa = await Q.get("SELECT aberta_em, jornada_id FROM fichas WHERE id = ?", fichaAntiga);
  eq(String(fa.aberta_em.toISOString ? fa.aberta_em.toISOString() : fa.aberta_em).slice(0, 10),
     DIA_ANTIGO, "a ficha nasce com a data escolhida");
  /* Jornada é hora medida por relógio. Pendurar um bordado de meses atrás na
     jornada de hoje somaria ao dia do administrador um trabalho que não
     aconteceu agora — e o saldo de horas dele é o que se olha para pagar. */
  eq(fa.jornada_id, null, "e NÃO entra em jornada nenhuma — não é hora trabalhada hoje");

  eq((await admin("/restrito/api/fichas/" + fichaAntiga + "/fechar", "PUT",
     { quantidade: 7, mercadoria_id: merc, cor_id: corBranca })).status, 200,
     "e fecha normalmente");
  fa = await Q.get("SELECT fechada_em::date::text AS dia FROM fichas WHERE id = ?", fichaAntiga);
  eq(fa.dia, DIA_ANTIGO,
     "FECHA NO DIA DELA — e não hoje, que é de onde sai todo o relatório");

  r = await admin("/restrito/api/producao?de=" + DIA_ANTIGO + "&ate=" + DIA_ANTIGO);
  ok(r.dados.fichas.some((f) => String(f.id) === String(fichaAntiga)),
     "e aparece no relatório DAQUELE dia");

  /* A ficha do dia de hoje continua fechando na hora do relógio — é dela que
     sai o tempo por peça do chão de fábrica, e essa conta não pode mudar. */
  r = await oper("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desA1, maquina_token: tokenSexies });
  const fichaHoje = r.dados.id;
  CRIADO.fichas.push(fichaHoje);
  await oper("/restrito/api/fichas/" + fichaHoje + "/fechar", "PUT",
    { quantidade: 2, mercadoria_id: merc, cor_id: corBranca });
  const fh = await Q.get(
    "SELECT (fechada_em::date = now()::date) AS hoje FROM fichas WHERE id = ?", fichaHoje);
  ok(fh.hoje === true || fh.hoje === "t", "a ficha normal continua fechando HOJE");

  /* --- 4. o valor que o administrador preenche na hora da nota --------- */
  /* O desenho que o operador cadastra nasce SEM preço, e a ficha herda o
     nulo. `total_valor` dessa ficha é zero, e zero soma sem reclamar: a nota
     sai menor que o serviço e nada denuncia. */
  r = await oper("/restrito/api/desenhos", "POST",
    { nome: "ZZ QA Sem Preco Nota", cliente_id: cliA, pontuacao: 800 });
  eq(r.status, 201, "o operador cadastra desenho novo (sem preço)");
  const desSemPreco = r.dados.id;
  CRIADO.desenhos.push(desSemPreco);

  r = await oper("/restrito/api/fichas", "POST",
    { cliente_id: cliA, desenho_id: desSemPreco, maquina_token: tokenSexies });
  const fichaSemValor = r.dados.id;
  CRIADO.fichas.push(fichaSemValor);
  await oper("/restrito/api/fichas/" + fichaSemValor + "/fechar", "PUT",
    { quantidade: 10, mercadoria_id: merc, cor_id: corBranca });

  let fsv = await Q.get("SELECT preco_unitario, total_valor FROM fichas WHERE id = ?", fichaSemValor);
  eq(fsv.preco_unitario, null, "a ficha nasce SEM valor — nulo, e não zero");
  eq(Number(fsv.total_valor), 0, "e por isso vale zero na soma da nota");

  /* O OPERADOR NÃO PÕE VALOR. Nem na ficha dele. */
  r = await oper("/restrito/api/fichas/" + fichaSemValor, "PUT", { preco_unitario: "3,50" });
  eq(r.status, 403, "o operador NÃO coloca valor, nem na própria ficha");

  /* O administrador põe — e o total gerado pelo banco acompanha. */
  eq((await admin("/restrito/api/fichas/" + fichaSemValor, "PUT",
     { preco_unitario: "3,50" })).status, 200,
     "o administrador coloca o valor da ficha");
  fsv = await Q.get("SELECT preco_unitario, total_valor FROM fichas WHERE id = ?", fichaSemValor);
  eq(Number(fsv.preco_unitario), 3.5, "o valor por peça fica gravado");
  eq(Number(fsv.total_valor), 35, "e o total é recalculado pelo banco: 10 x 3,50");

  /* Apagar de volta devolve o "a definir" — e não grava zero, que é outra
     coisa (bordado de cortesia, amostra, retrabalho que não se cobra). */
  eq((await admin("/restrito/api/fichas/" + fichaSemValor, "PUT",
     { preco_unitario: "" })).status, 200, "e pode voltar para a definir");
  fsv = await Q.get("SELECT preco_unitario FROM fichas WHERE id = ?", fichaSemValor);
  eq(fsv.preco_unitario, null, "que é NULO, e não zero");
  await admin("/restrito/api/fichas/" + fichaSemValor, "PUT", { preco_unitario: "3,50" });

  /* --- 5. o lote vê o valor de cada ficha e o total ------------------- */
  r = await admin("/restrito/api/lotes", "POST",
    { cliente_id: cliA, descricao: "ZZ QA Lote da nota antiga" });
  const loteNota = r.dados.id;
  CRIADO.lotes.push(loteNota);
  eq((await admin("/restrito/api/lotes/" + loteNota + "/fichas", "PUT",
     { fichas: [fichaAntiga, fichaSemValor] })).status, 200, "as duas fichas entram no lote");

  r = await admin("/restrito/api/lotes/" + loteNota);
  eq(r.dados.fichas.length, 2, "a composição traz as duas");
  ok(r.dados.fichas.every((f) => "preco_unitario" in f),
     "cada linha traz o preço unitário — é o que a coluna Valor mostra");
  ok(r.dados.fichas.some((f) => Number(f.total_valor) === 35),
     "com o total da ficha que acabou de ser precificada");

  /* --- 6. a nota emitida a partir do lote ----------------------------- */
  /* É a MESMA rota do menu Financeiro. O botão novo só chega nela com o
     cliente e o lote já escolhidos — uma segunda rota seria uma segunda regra
     de "quais lotes podem entrar" para alguém esquecer de repetir. */
  r = await admin("/restrito/api/lotes?cliente=" + cliA + "&semNota=1&por=200");
  ok((r.dados.lotes || []).some((l) => String(l.id) === String(loteNota)),
     "o lote aparece entre os que ainda podem entrar numa nota");

  r = await admin("/restrito/api/notas", "POST", { cliente_id: cliA, lotes: [loteNota] });
  eq(r.status, 201, "a nota nasce com o lote dentro", JSON.stringify(r.dados));
  const notaDoLote = r.dados.id;
  CRIADO.notas.push(notaDoLote);

  /* O lote sai da lista de disponíveis — é o que impede o mesmo serviço de
     ser cobrado duas vezes, e o que a tela usa para dizer por que ele sumiu. */
  r = await admin("/restrito/api/lotes?cliente=" + cliA + "&semNota=1&por=200");
  ok(!(r.dados.lotes || []).some((l) => String(l.id) === String(loteNota)),
     "e o lote sai da lista de disponíveis para nota");

  /* ====== 12k-septies. remover ficha da composição do lote =============== */
  console.log("  12k-septies. remover ficha — as três cercas e a devolução da soma");

  /* REMOVER apaga de verdade — some da produção do operador, que é por onde
     se paga. Por isso a rota tem três cercas, e cada uma vira verificação. */

  const tokenSepties = (await Q.get("SELECT token FROM maquinas WHERE id = ?", maq)).token;
  async function fichaFechada(qtd) {
    const a = await oper("/restrito/api/fichas", "POST",
      { cliente_id: cliA, desenho_id: desA1, maquina_token: tokenSepties });
    await oper("/restrito/api/fichas/" + a.dados.id + "/fechar", "PUT",
      { quantidade: qtd, mercadoria_id: merc, cor_id: corBranca });
    CRIADO.fichas.push(a.dados.id);
    return a.dados.id;
  }

  /* --- 1. o operador não remove ---------------------------------------- */
  const fAlvo = await fichaFechada(4);
  r = await oper("/restrito/api/fichas/" + fAlvo, "DELETE");
  eq(r.status, 403, "o operador NÃO remove ficha — nem a própria");

  /* --- 2. lote faturado não perde ficha -------------------------------- */
  r = await admin("/restrito/api/lotes", "POST",
    { cliente_id: cliA, descricao: "ZZ QA Lote remover" });
  const loteRem = r.dados.id;
  CRIADO.lotes.push(loteRem);
  await admin("/restrito/api/lotes/" + loteRem + "/fichas", "PUT", { fichas: [fAlvo] });
  await admin("/restrito/api/lotes/" + loteRem, "PUT", { situacao: "faturado", nota: "ZZQA-1" });

  r = await admin("/restrito/api/fichas/" + fAlvo, "DELETE");
  eq(r.status, 409, "ficha de lote FATURADO não sai — o que está na nota não muda");

  /* Desfaturado, sai. E a composição do lote fica menor NA MESMA hora. */
  await admin("/restrito/api/lotes/" + loteRem, "PUT", { situacao: "aberto" });
  r = await admin("/restrito/api/fichas/" + fAlvo, "DELETE");
  eq(r.status, 200, "com o lote aberto, o administrador remove", JSON.stringify(r.dados));
  const sumiu = await Q.get("SELECT id FROM fichas WHERE id = ?", fAlvo);
  eq(sumiu, undefined, "a ficha saiu do banco DE VERDADE — não é cancelamento");
  r = await admin("/restrito/api/lotes/" + loteRem);
  eq(r.dados.fichas.length, 0, "e a composição do lote não a mostra mais");

  /* --- 2b. a guarda do SOMAR em lote faturado ---------------------------
     Descoberta desta rodada: a sabotagem desligou a guarda do somar por
     engano e a suíte ficou VERDE — a cerca existia sem teste nenhum. Cerca
     sem teste é a que o próximo refactor apaga sem ninguém ver. */
  const fs1 = await fichaFechada(2);
  const fs2 = await fichaFechada(2);
  await admin("/restrito/api/lotes/" + loteRem + "/fichas", "PUT", { fichas: [fs1, fs2] });
  await admin("/restrito/api/lotes/" + loteRem, "PUT", { situacao: "faturado", nota: "ZZQA-1" });
  r = await admin("/restrito/api/fichas/somar", "POST", { ids: [fs1, fs2] });
  eq(r.status, 409, "somar fichas de lote FATURADO é recusado");
  await admin("/restrito/api/lotes/" + loteRem, "PUT", { situacao: "aberto" });
  await admin("/restrito/api/lotes/" + loteRem + "/fichas", "PUT", { fichas: [] });

  /* --- 3. remover uma SOMADA devolve as parcelas ------------------------ */
  const fp1 = await fichaFechada(3);
  const fp2 = await fichaFechada(5);
  r = await admin("/restrito/api/fichas/somar", "POST", { ids: [fp1, fp2] });
  eq(r.status, 201, "duas fichas viram uma somada", JSON.stringify(r.dados));
  const fSoma = r.dados.id;
  CRIADO.fichas.push(fSoma);

  /* A parcela não sai sozinha: tirá-la deixaria a soma dizendo um total que
     as partes não sustentam. */
  r = await admin("/restrito/api/fichas/" + fp1, "DELETE");
  eq(r.status, 409, "parcela de soma não se remove sozinha");

  r = await admin("/restrito/api/fichas/" + fSoma, "DELETE");
  eq(r.status, 200, "a ficha SOMADA remove");
  eq(Number(r.dados.devolvidas), 2, "e devolve as DUAS parcelas");
  const volta1 = await Q.get("SELECT situacao, somada_em_id FROM fichas WHERE id = ?", fp1);
  eq(volta1.situacao, "fechada", "a parcela volta a ser ficha fechada");
  eq(volta1.somada_em_id, null, "sem apontar para uma soma que não existe mais");

  /* A produção do operador continua contando as 8 peças (3+5) — remover a
     soma desfez a soma, não o trabalho. */
  const pecasDeVolta = await Q.get(
    "SELECT COALESCE(SUM(quantidade),0) s FROM fichas WHERE id = ANY(?)", [fp1, fp2]);
  eq(Number(pecasDeVolta.s), 8, "as peças das parcelas continuam no histórico");

  /* ============ 12k-bis. a lista velha do navegador ===================== */
  /* ISTO ACONTECEU EM PRODUÇÃO, seis vezes nos dias 07 e 08/08/2026:

         insert or update on table "fichas" violates foreign key constraint
         "fichas_cor_id_fkey"

     A tela guarda as listas de cadastro em memória e as reusa o turno inteiro.
     Entre carregar a lista e gravar a ficha, alguém no escritório apagou a cor.
     O banco recusou — corretamente — e a pessoa recebeu "erro interno" enquanto
     FECHAVA UMA FICHA, com a peça bordada e a quantidade contada.

     Uma trava de banco fazendo o papel de mensagem é sempre isso: correta, e
     inútil para quem está na frente da tela. */
  console.log("  12k-bis. cadastro apagado com a tela aberta");

  r = await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Cor Efêmera" });
  const corSome = r.dados.id;
  eq((await admin("/restrito/api/cores/" + corSome, "DELETE")).status, 200, "a cor é apagada no escritório");

  /* O operador tem a ficha aberta e a lista velha na tela. */
  r = await oper("/restrito/api/fichas", "POST", { cliente_id: cliB, desenho_id: desB1 });
  const fVelha = r.dados.id; CRIADO.fichas.push(fVelha);

  r = await oper("/restrito/api/fichas/" + fVelha + "/fechar", "PUT",
    { quantidade: "3", cor_id: corSome });
  eq(r.status, 409, "fechar com a cor apagada NÃO estoura em 500");
  ok(/não existe mais/i.test(r.dados.error || ""), "e a resposta é uma frase, não erro de driver", r.dados.error);
  eq(r.dados.recarregar, true, "com o aviso para a tela buscar as listas de novo");

  /* E a ficha continua ABERTA: a recusa não pode deixá-la meio fechada, sem
     quantidade, fora do painel de pendências. */
  eq((await admin("/restrito/api/fichas/" + fVelha)).dados.situacao, "aberta",
     "e a ficha continua aberta — a recusa não gravou pela metade");

  /* Fechando com a cor certa, funciona. */
  eq((await oper("/restrito/api/fichas/" + fVelha + "/fechar", "PUT",
    { quantidade: "3", cor_id: corPreta })).status, 200, "com uma cor que existe, fecha normal");

  /* ZERO NÃO É ID DE NADA. `Number("0")` é 0, e um `<select>` mal preenchido
     mandaria zero — que o banco recusaria, derrubando a ficha inteira. */
  r = await admin("/restrito/api/fichas/" + fVelha, "PUT", { cor_id: "0" });
  eq(r.status, 200, "cor_id = 0 é aceito…");
  eq((await admin("/restrito/api/fichas/" + fVelha)).dados.cor_id, null, "…e vira NULO, não zero");

  r = await admin("/restrito/api/fichas/" + fVelha, "PUT", { mercadoria_id: 999999999 });
  eq(r.status, 409, "corrigir com mercadoria inexistente também é recusado com frase");

  /* O CONSERTO DE VERDADE não é a mensagem: é fechar a janela em que a lista
     velha existe. Apagar e desativar passaram a avisar as telas abertas. */
  /* A cor é criada FORA do gatilho, de propósito. Criando dentro, o evento do
     CRIAR já satisfaria a conferência e o teste passaria mesmo com o aviso do
     apagar desligado — foi o que aconteceu na primeira versão desta seção. O
     gatilho tem de conter só a operação que está sendo testada. */
  const corParaApagar = (await admin("/restrito/api/cores", "POST", { nome: "ZZ QA Cor Aviso" })).dados.id;
  const avisoApagar = await ouvirEventos(admin.cookie(), async () => {
    await admin("/restrito/api/cores/" + corParaApagar, "DELETE");
  });
  ok(avisoApagar.includes('"o":"cores"'), "APAGAR um cadastro avisa as telas abertas", avisoApagar.slice(0, 80));

  const avisoDesativar = await ouvirEventos(admin.cookie(), async () => {
    await admin("/restrito/api/cores/" + corBranca + "/ativo", "PUT", { ativo: false });
  });
  ok(avisoDesativar.includes('"o":"cores"'), "DESATIVAR também avisa", avisoDesativar.slice(0, 80));
  await admin("/restrito/api/cores/" + corBranca + "/ativo", "PUT", { ativo: true });

  /* =========================== 12l. gavetas do cliente e lote pago ====== */
  console.log("  12l. gavetas do cliente e pagamento do lote");

  r = await admin("/restrito/api/clientes/" + cliB);
  ok(r.dados.resumo && Number(r.dados.resumo.desenhos) >= 1, "o cliente traz os totais dos três botões");
  ok("lotes_a_receber" in r.dados.resumo, "inclusive quantos lotes estão a receber");

  r = await admin("/restrito/api/clientes/" + cliB + "/fichas");
  eq(r.status, 200, "a gaveta de peças do cliente responde");
  ok(r.dados.fichas.some((f) => String(f.id) === String(fVal)), "e traz a ficha dele");
  /* A soma tem de bater com as LINHAS devolvidas, e não com um número fixo:
     este cliente ganha fichas ao longo da suíte, e um valor cravado aqui
     quebraria a cada teste novo — escondendo a única coisa que importa, que é
     o total conferir com o que a tela mostra. */
  eq(r.dados.soma.valor, r.dados.fichas.reduce((a, f) => a + Number(f.total_valor || 0), 0),
     "e a soma bate com as fichas listadas");
  ok(r.dados.soma.valor >= 84, "incluindo a ficha corrigida", String(r.dados.soma.valor));

  r = await admin("/restrito/api/lotes", "POST", { cliente_id: cliB, descricao: "ZZ QA Lote Pago" });
  const lotePg = r.dados.id; CRIADO.lotes.push(lotePg);
  await admin("/restrito/api/lotes/" + lotePg + "/fichas", "PUT", { fichas: [fVal] });

  /* PAGO É UM FATO À PARTE DE FATURADO. Como quarto estado de `situacao`,
     marcar o pagamento apagaria o "faturado" — e "o que já saiu e ainda não
     entrou", que é a razão de existir da cobrança, deixaria de ter resposta. */
  eq((await admin("/restrito/api/lotes/" + lotePg, "PUT", { pago_em: "2026-08-05" })).status, 400,
     "lote AINDA ABERTO não pode ser marcado como pago");
  await admin("/restrito/api/lotes/" + lotePg, "PUT", { situacao: "fechado" });
  eq((await admin("/restrito/api/lotes/" + lotePg, "PUT", { pago_em: "2026-08-05" })).status, 200,
     "lote fechado, aí sim");

  r = await admin("/restrito/api/lotes/" + lotePg);
  eq(r.dados.lote.situacao, "fechado", "e o pagamento NÃO apagou a situação");
  ok(r.dados.lote.pago_em, "o pagamento ficou gravado");
  eq(r.dados.valor, 84, "o lote soma o valor das fichas dele");

  ok((await admin("/restrito/api/lotes?pago=1")).dados.lotes.some((l) => String(l.id) === String(lotePg)),
     "o filtro “pago” acha o lote");
  r = await admin("/restrito/api/lotes?pago=0");
  ok(!r.dados.lotes.some((l) => String(l.id) === String(lotePg)),
     "e o filtro “a receber” não o traz mais — é a lista de cobrança");
  ok(r.dados.conta && "a_receber" in r.dados.conta, "a lista de lotes traz o caixa junto");

  r = await admin("/restrito/api/clientes/" + cliB + "/lotes");
  eq(r.status, 200, "a gaveta de lotes do cliente responde");
  eq(r.dados.conta.recebido, 84, "com o recebido separado do a receber");

  eq((await oper("/restrito/api/clientes/" + cliB + "/lotes")).status, 403,
     "e o operador não entra na gaveta financeira");

  /* ==================== 12k-quater. paginação das outras listas ========= */
  console.log("  12k-quater. paginação de lotes e cadastros");

  /* LOTES paginam no servidor, como a produção: a lista cresce com o tempo e
     o caixa do topo tem de contar TODOS, não a página. */
  r = await admin("/restrito/api/lotes?por=1&pagina=1");
  eq(r.status, 200, "lotes aceita paginação");
  ok(r.dados.lotes.length <= 1, "e devolve o tamanho pedido", String(r.dados.lotes.length));
  ok(Number(r.dados.total) >= r.dados.lotes.length, "com o total do filtro inteiro");
  eq(r.dados.paginas, Math.ceil(Number(r.dados.total) / 1), "e o número de páginas fecha");

  /* O caixa NÃO pode mudar quando se vira a página — ele é o que ainda tem de
     entrar no total, não o que aparece na tela. */
  /* Para a conferência ter valor, as duas páginas precisam ter conteúdo
     DIFERENTE: com dois lotes vazios, somar a página e somar o banco dariam
     zero nos dois casos e o teste aprovaria a soma errada. Um dos lotes tem
     ficha com valor; o outro, nada. */
  r = await admin("/restrito/api/lotes", "POST", { cliente_id: cliB, descricao: "ZZ QA Lote Sem Ficha" });
  const loteSemFicha = r.dados.id; CRIADO.lotes.push(loteSemFicha);

  const cx1 = (await admin("/restrito/api/lotes?por=1&pagina=1")).dados.conta;
  const cx2 = (await admin("/restrito/api/lotes?por=1&pagina=2")).dados.conta;
  ok(cx1.total > 0, "há valor em lote para a conferência valer", String(cx1.total));
  eq(cx2.total, cx1.total, "o caixa é o mesmo em qualquer página — soma o filtro, não a página");
  eq(cx2.a_receber, cx1.a_receber, "o a receber também");
  eq(cx2.pagos + cx2.abertos, cx1.pagos + cx1.abertos, "e a contagem de lotes também");

  /* Os CADASTROS já paginavam; o que mudou foi passarem pelo mesmo cortador.
     Sem `?pagina=`, continuam devolvendo a lista inteira — é o que as caixas
     de seleção da tela do operador consomem, e paginá-las deixaria o operador
     sem metade dos clientes sem nada avisando. */
  r = await admin("/restrito/api/clientes?todos=1");
  ok(!("paginas" in r.dados), "sem `pagina=`, o cadastro devolve tudo, sem envelope");
  r = await admin("/restrito/api/clientes?todos=1&pagina=1&por=2");
  eq(r.dados.porPagina, 2, "com `pagina=`, pagina");
  ok(r.dados.itens.length <= 2, "e respeita o tamanho");
  ok(Number(r.dados.total) >= r.dados.itens.length, "com o total de todos");

  /* ==================================== 12m. tempo real (SSE) =========== */
  console.log("  12m. tempo real");
  eq((await ninguem("/restrito/api/eventos")).status, 401, "o canal de eventos exige sessão");

  const fluxo = await ouvirEventos(admin.cookie(), async () => {
    const x = await admin("/restrito/api/mercadorias", "POST", { nome: "ZZ QA Aviso" });
    if (x.dados && x.dados.id) CRIADO.mercadorias.push(x.dados.id);
  });
  ok(fluxo.includes("event: mudou"), "gravar um cadastro avisa quem está ouvindo", fluxo.slice(0, 90));
  ok(fluxo.includes('"o":"mercadorias"'), "e o aviso diz QUAL assunto mudou");
  /* O aviso leva só o assunto. Se levasse a linha do desenho, o PREÇO chegaria
     a todos os navegadores da fábrica — inclusive aos que a API se dá ao
     trabalho de filtrar. */
  ok(!/preco|pontuacao|senha/.test(fluxo), "e NÃO carrega dado nenhum junto", fluxo.slice(0, 90));

  /* ======================================= 12n. a conta de DONO ========= */
  console.log("  12n. conta de dono");

  /* Esta seção só roda se NÃO houver dono no banco. Num servidor de verdade,
     o dono é a conta de manutenção do cliente: apontar para ela um teste de
     "redefinir senha" — ainda que a rota deva recusar — é o tipo de risco que
     só se descobre quando a proteção estiver quebrada, que é exatamente
     quando o teste roda. Um teste de segurança não pode ser a coisa que causa
     o estrago que ele procura. */
  const donoExistente = await Q.get("SELECT id, usuario FROM usuarios WHERE papel = 'dono'");
  if (donoExistente) {
    console.log(`     ⚠ pulada: já existe a conta de dono "${donoExistente.usuario}".`);
    console.log("       Esta suíte não mexe nela. Para rodar a seção, use um banco de teste.");
  } else {
    const SENHA_DONO = "zz-qa-dono-2026";
    const idDono = await Q.inserir(
      `INSERT INTO usuarios (usuario, nome, senha_hash, papel, senha_provisoria)
       VALUES (?,?,?,'dono',FALSE) RETURNING id`,
      "zz_qa_dono", "ZZ QA Dono", gerarHash(SENHA_DONO));
    CRIADO.usuarios.push(idDono);

    /* SÓ UMA. A garantia é do banco, não da aplicação: duas execuções do CLI
       ao mesmo tempo passariam por qualquer conferência em JavaScript. */
    let segundo = null;
    try {
      segundo = await Q.inserir(
        "INSERT INTO usuarios (usuario, nome, senha_hash, papel) VALUES (?,?,?,'dono') RETURNING id",
        "zz_qa_dono2", "ZZ QA Dono 2", gerarHash("x"));
      CRIADO.usuarios.push(segundo);
    } catch (e) { /* esperado */ }
    ok(segundo === null, "o BANCO recusa uma segunda conta de dono");

    const dono = criarNavegador("dono");
    eq((await dono("/restrito/api/entrar", "POST", { usuario: "zz_qa_dono", senha: SENHA_DONO })).status, 200,
       "o dono entra");

    /* O ponto que quebraria tudo em silêncio: antes destes ajustes o código
       comparava `papel === "admin"` em oito lugares. Cada uma que sobrevivesse
       trancaria o dono para fora da tela que ele existe para consertar. */
    r = await dono("/restrito/api/eu");
    eq(r.dados.admin, true, "a sessão do dono diz que ele PODE o que o admin pode");
    eq(r.dados.dono, true, "e que ele é o dono");
    eq((await dono("/restrito/api/producao")).status, 200, "o dono entra na área do administrador");
    eq((await dono("/restrito/api/lotes")).status, 200, "vê os lotes");
    r = await dono("/restrito/api/clientes", "POST", { nome: "ZZ QA Cliente Dono" });
    eq(r.status, 201, "e mexe nos cadastros");
    CRIADO.clientes.push(r.dados.id);
    ok("preco" in (await dono("/restrito/api/desenhos/" + desA1)).dados, "o dono vê o preço");

    /* INVISÍVEL na lista — e é a parte fácil. */
    r = await admin("/restrito/api/usuarios");
    ok(!r.dados.itens.some((u) => String(u.id) === String(idDono)),
       "a conta de dono NÃO aparece na lista de usuários");
    ok(!r.dados.itens.some((u) => u.papel === "dono"), "nem por papel");

    /* INTOCÁVEL — e é a parte que importa. Esconder sem proteger é pior que
       não esconder: `DELETE /usuarios/1` é o primeiro palpite de qualquer um,
       e ninguém veria o estrago até precisar da conta. */
    eq((await admin("/restrito/api/usuarios/" + idDono, "DELETE")).status, 404,
       "o admin não APAGA a conta de dono");
    eq((await admin("/restrito/api/usuarios/" + idDono, "PUT", { ativo: false })).status, 404,
       "não a DESATIVA");
    eq((await admin("/restrito/api/usuarios/" + idDono, "PUT", { papel: "operador" })).status, 404,
       "não a REBAIXA");
    eq((await admin("/restrito/api/usuarios/" + idDono + "/senha", "POST")).status, 404,
       "e não redefine a senha dela");
    ok(!!(await Q.get("SELECT id FROM usuarios WHERE id = ? AND papel = 'dono' AND ativo", idDono)),
       "depois das quatro tentativas, a conta continua lá, dona e ativa");

    /* 404 e não 403: para quem está de fora, a conta não existe. Um 403
       confirmaria o id dela a quem estivesse procurando. */
    eq((await admin("/restrito/api/usuarios/" + idDono, "DELETE")).dados.error, "usuário não encontrado",
       "e a recusa não confirma que ela existe");

    /* Promoção pela rota: sem esta trava, um admin viraria dono mandando o
       papel no corpo — e sumiria da própria lista de usuários. */
    const idComum = CRIADO.usuarios[1];
    eq((await admin("/restrito/api/usuarios/" + idComum, "PUT", { papel: "dono" })).status, 400,
       "ninguém se promove a dono pela rota");
    eq((await admin("/restrito/api/usuarios", "POST",
      { usuario: "zz_qa_novodono", nome: "x", papel: "dono" })).status, 400,
       "nem cria um dono pelo painel");

    /* A SENHA SÓ TROCA PELO TERMINAL. Sessão esquecida aberta numa máquina da
       fábrica bastaria para alguém ficar com a conta que pode tudo — e trocar
       a própria senha é operação legítima, que não deixa rastro. */
    r = await dono("/restrito/api/eu/senha", "PUT", { atual: SENHA_DONO, nova: "outra-senha-boa-9" });
    eq(r.status, 403, "o dono NÃO troca a própria senha pela tela");
    ok(/terminal/i.test(r.dados.error || ""), "e a mensagem diz onde se troca", r.dados.error);
    eq((await dono("/restrito/api/entrar", "POST", { usuario: "zz_qa_dono", senha: SENHA_DONO })).status, 200,
       "a senha antiga continua valendo — a recusa não trocou nada");

    /* O admin comum continua trocando a dele: a trava é do dono, não geral. */
    eq((await admin("/restrito/api/eu/senha", "PUT",
      { atual: SENHA_ADMIN, nova: SENHA_ADMIN })).status, 400,
       "e o admin comum segue com a rota de senha funcionando (repetir a mesma é recusado)");

    await dono("/restrito/api/sair", "POST");
  }

  /* ==================================================== 13. SAIR ========= */
  console.log("  13. sair");
  eq((await admin("/restrito/api/sair", "POST")).status, 200, "sair responde");
  eq((await admin("/restrito/api/eu")).status, 401, "e a sessão morreu de verdade");

  /* =============================================== 14. FORÇA BRUTA ======= */
  /* Por último de propósito: esta seção BLOQUEIA o IP, e a partir daqui nenhum
     login funciona por 15 minutos. Como a trava usa o arquivo de teste, o
     bloqueio morre junto com o arquivo, no fim da suíte. */
  console.log("  14. trava de força bruta");
  const atacante = criarNavegador("atacante");

  r = await atacante("/restrito/api/entrar", "POST", { usuario: "zz_qa_admin", senha: "chute-1" });
  eq(r.status, 401, "senha errada: 401");
  eq(r.dados.error, "Usuário ou senha incorretos", "senha errada dá a mensagem genérica");
  r = await atacante("/restrito/api/entrar", "POST", { usuario: "zz_qa_nem_existe", senha: "chute" });
  ok(r.status === 401 || r.status === 429, "usuário inexistente não é tratado diferente", "status " + r.status);
  if (r.status === 401)
    eq(r.dados.error, "Usuário ou senha incorretos",
       "usuário inexistente e senha errada dão a MESMA mensagem — não dá para descobrir quem existe");

  /* Insiste até a trava fechar. Se ela nunca fechar, o teste falha — que é o
     ponto: sem isso, um erro no limitador passaria despercebido. */
  let travou = false;
  for (let i = 0; i < 12 && !travou; i++) {
    r = await atacante("/restrito/api/entrar", "POST", { usuario: "zz_qa_admin", senha: "chute-" + i });
    if (r.status === 429) travou = true;
  }
  ok(travou, "depois de algumas tentativas seguidas, a trava fecha (429)");
  ok(travou && r.dados.error, "e a trava explica o que houve", JSON.stringify(r.dados));

  /* A trava vale até para quem sabe a senha: é isso que a torna uma trava. */
  r = await atacante("/restrito/api/entrar", "POST", { usuario: "zz_qa_admin", senha: SENHA_ADMIN });
  eq(r.status, 429, "com o IP travado, nem a senha certa entra");

  /* ======================================================== RESULTADO ==== */
  await limpar();
  if (servidor) servidor.kill();
  try { require("node:fs").unlinkSync(ARQ_LIMITES); } catch {}

  const total = passou + falhou;
  console.log("\n  " + "─".repeat(58));
  if (falhou) {
    console.log(`\n  ✖ ${falhou} de ${total} falharam:\n`);
    for (const f of falhas) console.log("    · " + f);
    console.log("");
    process.exitCode = 1;
  } else {
    console.log(`\n  ✔ ${passou}/${total} — o /restrito está de pé\n`);
  }
  process.exit(process.exitCode || 0);
})().catch(async (e) => {
  console.error("\n  ✖ a suíte quebrou: " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n"));
  /* As falhas já colhidas são impressas MESMO quando a suíte morre no meio.
     Sem isto, o primeiro estouro esconde tudo que já tinha sido detectado — e
     a causa costuma estar na lista, não no estouro. */
  if (falhas.length) {
    console.error(`\n  ${falhas.length} falha(s) já detectada(s) antes do estouro:\n`);
    for (const f of falhas) console.error("    · " + f);
    console.error("");
  }
  try { await limpar(); } catch {}
  if (servidor) servidor.kill();
  process.exit(1);
});
