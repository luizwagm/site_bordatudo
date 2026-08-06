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
                 lotes: [], fichas: [], jornadas: [], desenho_fotos: [], arquivos: [] };

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

function criarNavegador(quem) {
  let cookie = "";
  return async function pedir(caminho, metodo, corpo) {
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
    return { status: r.status, dados, texto, tipo: r.headers.get("content-type") || "" };
  };
}

/* ==========================================================================
   Faxina — só por id, só o que está em CRIADO.
   ========================================================================== */
async function limpar() {
  const ordem = ["desenho_fotos", "fichas", "lotes", "jornadas", "desenhos", "clientes",
                 "mercadorias", "cores", "maquinas", "usuarios"];
  for (const tabela of ordem) {
    const ids = CRIADO[tabela].filter(Boolean);
    if (!ids.length) continue;
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
  const P = "ZZ QA %";
  const usuarios = await Q.all("SELECT id FROM usuarios WHERE usuario LIKE ?", "zz_qa_%");
  const ids = usuarios.map((u) => u.id);
  if (ids.length) {
    await Q.run("DELETE FROM fichas WHERE usuario_id = ANY(?)", ids);
    await Q.run("DELETE FROM jornadas WHERE usuario_id = ANY(?)", ids);
    await Q.run("DELETE FROM usuarios WHERE id = ANY(?)", ids);
  }
  const clientes = await Q.all("SELECT id FROM clientes WHERE nome LIKE ?", P);
  if (clientes.length) {
    const cids = clientes.map((c) => c.id);
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

  /* Apagar um lote NÃO apaga a produção — solta as fichas. */
  await admin("/restrito/api/lotes/" + lote2 + "/fichas", "PUT", { fichas: [fB] });
  eq(Number((await admin("/restrito/api/lotes/" + lote2)).dados.pecas), 5, "lote 2 com a ficha do cliente B");
  eq((await admin("/restrito/api/lotes/" + lote2, "DELETE")).status, 200, "lote 2 apagado");
  linha = await Q.get("SELECT id, lote_id FROM fichas WHERE id = ?", fB);
  ok(linha, "a ficha do lote apagado CONTINUA existindo");
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
  eq((await oper("/restrito/api/eu/senha", "PUT", { atual: SENHA_OPER, nova: "curta" })).status, 400,
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
  eq((await admin("/restrito/api/clientes/" + cliA, "DELETE")).status, 200, "desativa o cliente A");
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
  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", { nome: "x.exe", dados: "data:;base64," + PNG })).status,
    400, "extensão fora da lista é recusada");
  eq((await admin(`/restrito/api/desenhos/${desA1}/fotos`, "POST", { nome: "vazia.png", dados: "" })).status,
    400, "arquivo vazio é recusado");

  r = await admin(`/restrito/api/desenhos/${desA1}/fotos`);
  eq(r.dados.itens.length, 2, "o desenho tem duas fotos");
  eq(r.dados.itens[0].arquivo, arq1, "a primeira enviada é a primeira da lista (é a capa)");
  const foto1 = r.dados.itens[0].id, foto2 = r.dados.itens[1].id;

  r = await admin("/restrito/api/desenhos?pagina=1&por=50&todos=1&busca=ZZ QA DES A1");
  eq(r.dados.itens[0].capa, arq1, "a listagem já traz a capa, sem consulta extra");
  eq(Number(r.dados.itens[0].fotos), 2, "e a contagem de fotos");

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
  eq((await oper(`/restrito/api/desenhos/${desA1}/fotos`, "POST", png("a.png"))).status, 403,
     "mas não envia nem apaga foto");

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
  ok(/^[bcdfghjkmnpqrstvwxyz2-9]{4}(-[bcdfghjkmnpqrstvwxyz2-9]{4}){3}$/.test(senhaNova),
     "a senha é gerada no formato que se dita por telefone", senhaNova);

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
