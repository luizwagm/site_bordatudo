/* ==========================================================================
   SUÍTE DO DINHEIRO — Borda Tudo

       node testar-financeiro.cjs

   Cobre o caminho que termina em papel assinado: somar fichas, montar a nota
   a partir dos lotes, receber em parcelas, estornar, e fechar o caixa da
   fábrica. É a parte do sistema em que um erro não dá tela branca — dá conta
   errada, e ninguém percebe até o cliente conferir.

   Também confere ESTATICAMENTE a tela: uma função de modal que nunca foi
   escrita passa por qualquer teste de servidor e só aparece no clique do dono.

   SOBRE OS DADOS: tudo que esta suíte cria leva o prefixo `ZZ QA` e é APAGADO
   POR ID no fim — nunca por `LIKE`, nunca por nome. E no fim ela CONTA as
   linhas de cada tabela: se sobrou uma, a suíte reprova.
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { Q, carregarAmbiente } = require("./pg.js");

carregarAmbiente(__dirname);

/* Porta própria: 5199 é da suíte do /restrito e 5198 é da do site. Se esta
   subisse numa delas e um processo antigo tivesse ficado de pé, a suíte
   conversaria com ELE — e passaria, provando o servidor errado. */
const PORTA = Number(process.env.PORTA_TESTE_FIN) || 5197;
const BASE = `http://127.0.0.1:${PORTA}`;

async function portaOcupada(porta) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 800);
    await fetch(`http://127.0.0.1:${porta}/favicon.ico`, { signal: c.signal });
    clearTimeout(t);
    return true;
  } catch { return false; }
}

let passou = 0, falhou = 0;
const falhas = [];
const ok = (c, titulo, detalhe) => {
  if (c) { passou++; return true; }
  falhou++; falhas.push(titulo + (detalhe !== undefined ? "  → " + detalhe : ""));
  return false;
};
const secao = (t) => console.log("\n  " + t);

/* Um navegador de mentira: guarda o cookie de sessão entre as chamadas. */
function nav() {
  let cookie = "";
  return async (p, m, b) => {
    const r = await fetch(BASE + p, {
      method: m || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {}),
      body: b ? JSON.stringify(b) : undefined });
    const s = r.headers.get("set-cookie"); if (s) cookie = s.split(";")[0];
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, dados: ct.includes("json")
      ? await r.json().catch(() => null) : await r.text().catch(() => "") };
  };
}

/* ==========================================================================
   PARTE 1 — a tela, sem subir servidor nenhum

   Lê o app.html, apaga comentários e literais, e pergunta duas coisas: toda
   função chamada foi escrita? todo botão tem tratador? As duas respostas são
   "sim" ou o dono descobre no clique.
   ========================================================================== */
function conferirTela() {
  secao("0. a tela é consistente consigo mesma");
  const s = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
  const js = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

  /* UMA passada, na ordem dos caracteres. Uma sequência de `replace` não
     serve: o passo das aspas duplas casaria o `"num"` dentro de
     `'<td class="num">'` e dessincronizaria o resto do arquivo. */
  let codigo = "", i = 0;
  const branco = (t) => t.replace(/[^\n]/g, " ");
  while (i < js.length) {
    const c = js[i], d = js[i + 1];
    if (c === "/" && d === "*") {
      const f = js.indexOf("*/", i + 2), fim = f < 0 ? js.length : f + 2;
      codigo += branco(js.slice(i, fim)); i = fim;
    } else if (c === "/" && d === "/") {
      const f = js.indexOf("\n", i), fim = f < 0 ? js.length : f;
      codigo += branco(js.slice(i, fim)); i = fim;
    } else if (c === "/" && /[(,=:[!&|?{};+\-*%~^]\s*$/.test(codigo.slice(-40) || " ")) {
      /* Literal de expressão regular. Sem tratá-lo, um `/'/g` abre uma aspa
         que nunca fecha e o arquivo inteiro vira "string". */
      let j = i + 1, classe = false;
      while (j < js.length) {
        if (js[j] === "\\") { j += 2; continue; }
        if (js[j] === "[") classe = true;
        else if (js[j] === "]") classe = false;
        else if ((js[j] === "/" && !classe) || js[j] === "\n") break;
        j++;
      }
      codigo += branco(js.slice(i, j + 1)); i = j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < js.length && js[j] !== c) { if (js[j] === "\\") j++; j++; }
      codigo += c + branco(js.slice(i + 1, j)) + (js[j] === c ? c : ""); i = j + 1;
    } else { codigo += c; i++; }
  }

  const dec = new Set();
  for (const m of codigo.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) dec.add(m[1]);
  for (const m of codigo.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) dec.add(m[1]);
  for (const m of codigo.matchAll(/(?:^|[({,])\s*([A-Za-z_$][\w$]*)\s*(?:,|\))?\s*=>/gm)) dec.add(m[1]);

  const NATIVOS = new Set(("if for while switch catch return typeof function new delete void do else " +
    "await async Number String Boolean Array Object JSON Math Date Promise Set Map WeakMap fetch alert " +
    "confirm prompt parseInt parseFloat isNaN isFinite setTimeout setInterval clearTimeout clearInterval " +
    "encodeURIComponent decodeURIComponent requestAnimationFrame print open close RegExp Error TypeError " +
    "Intl EventSource FormData URLSearchParams URL btoa atob structuredClone queueMicrotask Symbol " +
    "matchMedia getComputedStyle scrollTo focus blur reload require").split(" "));

  const chamadas = new Set();
  for (const m of codigo.matchAll(/(?:^|[^.\w$])([a-z_$][\w$]*)\s*\(/gm)) chamadas.add(m[1]);
  const semDono = [...chamadas].filter((f) => !dec.has(f) && !NATIVOS.has(f));
  ok(!semDono.length, "toda função chamada na tela foi escrita", semDono.join(", "));

  const acoes = new Set();
  for (const m of js.matchAll(/data-acao=\\?["']([a-z0-9-]+)\\?["']/g)) acoes.add(m[1]);
  const tratadas = new Set();
  for (const m of js.matchAll(/[^u]acao === "([a-z0-9-]+)"/g)) tratadas.add(m[1]);
  const orfas = [...acoes].filter((a) => !tratadas.has(a) && !["trocar-senha", "sair"].includes(a));
  ok(!orfas.length, `os ${acoes.size} botões da tela têm tratador`, orfas.join(", "));

  /* A lição do `--laranja`: uma variável CSS usada e nunca definida some sem
     erro nenhum — o hover simplesmente não acontece. */
  const usadas = new Set([...s.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
  const definidas = new Set([...s.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const semCor = [...usadas].filter((v) => !definidas.has(v));
  ok(!semCor.length, `as ${usadas.size} variáveis de cor usadas existem`, semCor.join(", "));
}

/* ========================================================================== */
(async () => {
  console.log("\n  ══ SUÍTE DO DINHEIRO — Borda Tudo ══");
  conferirTela();

  const { gerarHash } = require("./restrito.js");
  const TABELAS = ["usuarios", "clientes", "desenhos", "fichas", "lotes", "notas",
                   "nota_lotes", "lancamentos"];
  const contar = async () => {
    const o = {};
    for (const t of TABELAS) { try { o[t] = Number((await Q.get(`SELECT COUNT(*) c FROM ${t}`)).c); } catch { o[t] = "—"; } }
    return o;
  };
  const antes = await contar();

  if (await portaOcupada(PORTA)) {
    console.error(`\n  ✖ a porta ${PORTA} já está ocupada por outro processo.\n` +
      "    A suíte rodaria contra ELE, não contra o servidor de teste.\n" +
      `    Feche o que está usando a porta, ou rode com PORTA_TESTE_FIN=<outra>.\n`);
    process.exit(1);
  }

  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORTA), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"] });
  let saida = ""; srv.stdout.on("data", (d) => { saida += d; }); srv.stderr.on("data", (d) => { saida += d; });

  const CRIADO = { lancamentos: [], notas: [], fichas: [], lotes: [], desenhos: [], clientes: [], usuarios: [] };
  try {
    for (let t = 0; t < 40; t++) {
      try { await fetch(BASE + "/restrito"); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
    }

    const SENHA = "ZzQaFin!" + process.pid;
    const adm = await Q.inserir(
      "INSERT INTO usuarios (usuario, nome, papel, ativo, senha_hash, senha_provisoria) " +
      "VALUES (?,?,'admin',TRUE,?,FALSE) RETURNING id", "zzqa.fin", "ZZ QA Financeiro", gerarHash(SENHA));
    const op1 = await Q.inserir(
      "INSERT INTO usuarios (usuario, nome, papel, ativo, senha_hash, senha_provisoria) " +
      "VALUES (?,?,'operador',TRUE,?,FALSE) RETURNING id", "zzqa.fin.op", "ZZ QA Maria", gerarHash(SENHA));
    const op2 = await Q.inserir(
      "INSERT INTO usuarios (usuario, nome, papel, ativo, senha_hash, senha_provisoria) " +
      "VALUES (?,?,'operador',TRUE,?,FALSE) RETURNING id", "zzqa.fin.op2", "ZZ QA José", gerarHash(SENHA));
    CRIADO.usuarios.push(adm, op1, op2);

    const a = nav();
    const entrou = await a("/restrito/api/entrar", "POST", { usuario: "zzqa.fin", senha: SENHA });
    if (entrou.status !== 200) throw new Error("não consegui entrar: " + JSON.stringify(entrou.dados));

    const cli = await Q.inserir("INSERT INTO clientes (nome) VALUES (?) RETURNING id", "ZZ QA Cliente Nota");
    const cli2 = await Q.inserir("INSERT INTO clientes (nome) VALUES (?) RETURNING id", "ZZ QA Outro Nota");
    CRIADO.clientes.push(cli, cli2);
    const d1 = await Q.inserir(
      "INSERT INTO desenhos (cliente_id, nome, pontuacao, preco) VALUES (?,?,?,?) RETURNING id",
      cli, "ZZ QA Jacaré Azul", 1000, 10.00);
    const d2 = await Q.inserir(
      "INSERT INTO desenhos (cliente_id, nome, pontuacao, preco) VALUES (?,?,?,?) RETURNING id",
      cli, "ZZ QA Jacaré Amarelo", 500, 4.00);
    const dx = await Q.inserir(
      "INSERT INTO desenhos (cliente_id, nome, pontuacao, preco) VALUES (?,?,?,?) RETURNING id",
      cli2, "ZZ QA Desenho Alheio", 1000, 10.00);
    CRIADO.desenhos.push(d1, d2, dx);

    const novoLote = async (clienteId, codigo) => {
      const l = await Q.inserir(
        "INSERT INTO lotes (cliente_id, codigo, situacao) VALUES (?,?, 'aberto') RETURNING id", clienteId, codigo);
      CRIADO.lotes.push(l); return l;
    };
    const novaFicha = async (uid, clienteId, desId, pont, preco, qtd, loteId) => {
      const f = await Q.inserir(
        "INSERT INTO fichas (usuario_id, cliente_id, desenho_id, pontuacao, preco_unitario, quantidade, " +
        "situacao, fechada_em, lote_id) VALUES (?,?,?,?,?,?, 'fechada', now(), ?) RETURNING id",
        uid, clienteId, desId, pont, preco, qtd, loteId);
      CRIADO.fichas.push(f); return f;
    };

    /* ------------------------------------------------------------------ */
    secao("1. somar fichas: a conta fecha e a produção não some");
    const LS = await novoLote(cli, "ZZ-SOMA-" + process.pid);
    const f1 = await novaFicha(op1, cli, d1, 1000, 10.00, 10, LS);
    const f2 = await novaFicha(op2, cli, d1, 1000, 10.00, 15, LS);
    const s1 = await a("/restrito/api/fichas/somar", "POST", { ids: [f1, f2] });
    ok(s1.status === 201, "soma duas fichas do mesmo lote", JSON.stringify(s1.dados));
    if (s1.dados && s1.dados.id) CRIADO.fichas.push(s1.dados.id);
    ok(s1.dados.pecas === 25 && s1.dados.pontos === 25000, "25 peças e 25.000 pontos, exatos");
    ok(s1.dados.diferenca_pontos === 0, "sem sobra de arredondamento", s1.dados.diferenca_pontos);
    const nv = await Q.get("SELECT * FROM fichas WHERE id = ?", s1.dados.id);
    ok(nv.operadores === "ZZ QA Maria, ZZ QA José", "os dois operadores, por vírgula", nv.operadores);
    ok(Number(nv.total_valor) === 250, "e o valor gerado pelo banco bate", nv.total_valor);
    const orig = await Q.all("SELECT situacao, lote_id, somada_em_id FROM fichas WHERE id = ANY(?::bigint[])",
      "{" + [f1, f2].join(",") + "}");
    ok(orig.length === 2 && orig.every((f) => f.situacao === "somada" && f.lote_id === null),
      "as originais saem do lote sem serem apagadas");
    ok(orig.every((f) => Number(f.somada_em_id) === Number(s1.dados.id)), "apontando para a ficha que as absorveu");

    /* Pontuações diferentes: a média tem de ser PONDERADA, ou a soma dos
       pontos muda de valor ao juntar. */
    const f3 = await novaFicha(op1, cli, d1, 1000, 10.00, 10, LS);
    const f4 = await novaFicha(op2, cli, d2, 500, 4.00, 10, LS);
    const s2 = await a("/restrito/api/fichas/somar", "POST", { ids: [f3, f4] });
    if (s2.dados && s2.dados.id) CRIADO.fichas.push(s2.dados.id);
    ok(s2.dados.pontuacao === 750, "média ponderada de 1000 e 500 é 750", s2.dados.pontuacao);
    const nv2 = await Q.get("SELECT total_pontos, total_valor FROM fichas WHERE id = ?", s2.dados.id);
    ok(Number(nv2.total_pontos) === 15000 && Number(nv2.total_valor) === 140,
      "e os totais continuam os mesmos depois de juntar", nv2.total_pontos + "/" + nv2.total_valor);

    const fx = await novaFicha(op1, cli2, dx, 1000, 10.00, 5, null);
    const f5 = await novaFicha(op1, cli, d1, 1000, 10.00, 5, LS);
    ok((await a("/restrito/api/fichas/somar", "POST", { ids: [f5, fx] })).status === 400,
      "recusa somar fichas de clientes diferentes");
    const ab = await Q.inserir(
      "INSERT INTO fichas (usuario_id, cliente_id, desenho_id, pontuacao, situacao) " +
      "VALUES (?,?,?,?, 'aberta') RETURNING id", op1, cli, d1, 1000);
    CRIADO.fichas.push(ab);
    ok((await a("/restrito/api/fichas/somar", "POST", { ids: [f5, ab] })).status === 400,
      "recusa somar ficha ainda aberta");
    let barrou = false;
    try { await Q.run("UPDATE fichas SET lote_id = ? WHERE id = ?", LS, f1); } catch { barrou = true; }
    ok(barrou, "o banco impede ficha somada de voltar a um lote");

    /* ------------------------------------------------------------------ */
    secao("2. a nota vale a soma dos lotes — nunca um número digitado");
    const L1 = await novoLote(cli, "ZZ-FIN-A-" + process.pid);
    const L2 = await novoLote(cli, "ZZ-FIN-B-" + process.pid);
    const L3 = await novoLote(cli, "ZZ-FIN-C-" + process.pid);
    const LX = await novoLote(cli2, "ZZ-FIN-X-" + process.pid);
    await novaFicha(op1, cli, d1, 1000, 10.00, 500, L1);   // 5.000
    await novaFicha(op1, cli, d1, 1000, 10.00, 300, L2);   // 3.000
    await novaFicha(op1, cli, d1, 1000, 10.00, 100, L3);   // 1.000
    await novaFicha(op1, cli2, dx, 1000, 10.00, 50, LX);

    const n1 = await a("/restrito/api/notas", "POST",
      { cliente_id: cli, lotes: [L1, L2], numero_nf: "9999", vencimento: "2020-01-01" });
    ok(n1.status === 201, "cria a nota com dois lotes", JSON.stringify(n1.dados));
    const N1 = n1.dados && n1.dados.id; if (N1) CRIADO.notas.push(N1);
    ok(/^NOTA-\d{4}-\d{4}$/.test(n1.dados.codigo || ""), "com código sequencial do ano", n1.dados.codigo);
    let v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.valor) === 8000, "vale R$ 8.000 — somado das fichas", v.valor);
    ok(Number(v.pecas) === 800, "800 peças", v.pecas);
    ok(v.quitada === false && Number(v.saldo) === 8000, "nada pago: saldo igual ao valor");
    /* A data volta do Postgres como objeto Date. `String(data).slice(0,10)`
       dá "Wed Jan 01" — que numa comparação de texto é MAIOR que "2026-08-13"
       e faz toda nota vencida parecer em dia. */
    ok(v.vencida === true, "e aparece como VENCIDA (venceu em 2020)", v.vencida);

    /* ------------------------------------------------------------------ */
    secao("3. pagamento em parcelas: 1.000 de 8.000");
    const p1 = await a("/restrito/api/lancamentos", "POST",
      { categoria: "recebimento", nota_id: N1, valor: 1000, forma: "pix" });
    ok(p1.status === 201, "registra o pagamento", JSON.stringify(p1.dados));
    if (p1.dados && p1.dados.id) CRIADO.lancamentos.push(p1.dados.id);
    ok(/^RC-\d{4}-\d{4}$/.test(p1.dados.recibo || ""), "com número de recibo", p1.dados.recibo);
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.saldo) === 7000 && Number(v.pago) === 1000, "faltam exatamente 7.000", v.saldo);

    const demais = await a("/restrito/api/lancamentos", "POST",
      { categoria: "recebimento", nota_id: N1, valor: 999999 });
    ok(demais.status === 400 && /saldo/i.test(demais.dados.error),
      "recusa receber mais que o saldo (o zero a mais na digitação)");
    ok((await a("/restrito/api/lancamentos", "POST",
      { categoria: "recebimento", nota_id: N1, valor: 0 })).status === 400, "recusa valor zero");
    ok((await a("/restrito/api/lancamentos", "POST",
      { categoria: "devolucao", nota_id: N1, valor: 5000 })).status === 400,
      "recusa devolver mais do que entrou");

    const p2 = await a("/restrito/api/lancamentos", "POST",
      { categoria: "recebimento", nota_id: N1, valor: 7000, forma: "dinheiro" });
    if (p2.dados && p2.dados.id) CRIADO.lancamentos.push(p2.dados.id);
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.saldo) === 0 && v.quitada === true, "o segundo pagamento quita", v.saldo);
    ok(v.vencida === false, "e a nota deixa de estar vencida");

    /* ------------------------------------------------------------------ */
    secao("4. estorno e cancelamento: marca, não apaga");
    const p3 = await a("/restrito/api/lancamentos", "POST",
      { categoria: "devolucao", nota_id: N1, valor: 500, descricao: "ZZ QA estorno" });
    if (p3.dados && p3.dados.id) CRIADO.lancamentos.push(p3.dados.id);
    v = (await a("/restrito/api/notas/" + N1)).dados;
    /* Devolução AUMENTA o que falta: o dinheiro voltou, o cliente deve de
       novo. Subtrair aqui é o erro que deixa a nota quitada após um estorno. */
    ok(Number(v.saldo) === 500 && v.quitada === false, "a devolução faz o saldo voltar a 500", v.saldo);

    ok((await a("/restrito/api/lancamentos/" + p3.dados.id + "/cancelar", "PUT", { motivo: "" })).status === 400,
      "cancelar exige motivo");
    ok((await a("/restrito/api/lancamentos/" + p3.dados.id + "/cancelar", "PUT",
      { motivo: "ZZ QA — lançado por engano" })).status === 200, "cancela com motivo");
    const morto = await Q.get("SELECT cancelado_em, motivo_cancelamento FROM lancamentos WHERE id = ?", p3.dados.id);
    ok(!!morto.cancelado_em && /engano/.test(morto.motivo_cancelamento), "a linha fica, com data e motivo");
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.saldo) === 0 && v.lancamentos.length === 3,
      "sai da conta mas segue na lista, para o recibo ter lastro", v.saldo + " / " + v.lancamentos.length);

    /* ------------------------------------------------------------------ */
    secao("5. um lote entra em UMA nota só");
    ok((await a("/restrito/api/notas", "POST", { cliente_id: cli, lotes: [L2, L3] })).status === 409,
      "recusa lote que já está em outra nota");
    ok((await a("/restrito/api/notas", "POST", { cliente_id: cli, lotes: [L3, LX] })).status === 400,
      "recusa lote de outro cliente");
    let travou = false;
    try { await Q.run("INSERT INTO nota_lotes (nota_id, lote_id) VALUES (?, ?)", N1, L1); } catch { travou = true; }
    ok(travou, "e o banco trava mesmo por fora da tela");

    const disp = (await a("/restrito/api/lotes?cliente=" + cli + "&semNota=1&por=200")).dados.lotes || [];
    const ids = disp.map((l) => Number(l.id));
    ok(ids.includes(Number(L3)) && !ids.includes(Number(L1)) && !ids.includes(Number(L2)),
      "semNota=1 oferece só o que ainda pode ser cobrado");
    const l3 = disp.find((l) => Number(l.id) === Number(L3));
    ok(l3 && Number(l3.valor) === 1000 && Number(l3.pecas) === 100,
      "com valor e peças, para a escolha não ser às cegas");

    /* ------------------------------------------------------------------ */
    secao("6. trocar os lotes reconcilia — clicar duas vezes não duplica");
    ok((await a("/restrito/api/notas/" + N1 + "/lotes", "PUT", { lotes: [L1, L2, L3] })).status === 200,
      "aceita acrescentar um lote");
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.valor) === 9000, "a nota passa a valer 9.000", v.valor);
    await a("/restrito/api/notas/" + N1 + "/lotes", "PUT", { lotes: [L1, L2, L3] });
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(v.lotes.length === 3, "mandar a mesma lista de novo não duplica", v.lotes.length);
    ok((await a("/restrito/api/notas/" + N1 + "/lotes", "PUT", { lotes: [] })).status === 400,
      "recusa nota sem lote nenhum");
    await a("/restrito/api/notas/" + N1 + "/lotes", "PUT", { lotes: [L1, L2] });

    secao("7. desconto e acréscimo");
    ok((await a("/restrito/api/notas/" + N1, "PUT", { desconto: 200, acrescimo: 50 })).status === 200,
      "salva o ajuste combinado com o cliente");
    v = (await a("/restrito/api/notas/" + N1)).dados;
    ok(Number(v.valor) === 7850, "8.000 − 200 + 50 = 7.850", v.valor);
    ok(Number(v.saldo) === -150, "e o saldo acompanha sozinho", v.saldo);
    await a("/restrito/api/notas/" + N1, "PUT", { desconto: 0, acrescimo: 0 });

    secao("8. cancelar e apagar a nota");
    ok((await a("/restrito/api/notas/" + N1, "PUT", { situacao: "cancelada" })).status === 409,
      "recusa cancelar nota que já recebeu dinheiro");
    ok((await a("/restrito/api/notas/" + N1, "DELETE")).status === 409,
      "recusa apagar nota com lançamento");
    const n2 = await a("/restrito/api/notas", "POST", { cliente_id: cli, lotes: [L3] });
    const N2 = n2.dados.id; CRIADO.notas.push(N2);
    ok((await a("/restrito/api/notas/" + N2, "PUT", { situacao: "cancelada" })).status === 200,
      "cancela nota sem pagamento");
    ok((await a("/restrito/api/notas/" + N2, "DELETE")).status === 200, "apaga nota sem lançamento");
    ok(Number((await Q.get("SELECT COUNT(*) c FROM nota_lotes WHERE lote_id = ?", L3)).c) === 0,
      "e o lote volta a ficar livre — apagar a nota não apaga o trabalho");
    CRIADO.notas = CRIADO.notas.filter((x) => x !== N2);

    /* ------------------------------------------------------------------ */
    secao("9. o recibo que o cliente leva embora");
    const rec = await a("/restrito/lancamentos/" + p1.dados.id + "/recibo");
    const html = String(rec.dados || "");
    ok(rec.status === 200, "o recibo abre", rec.status);
    ok(html.includes(p1.dados.recibo), "com o número do recibo");
    ok(html.includes("ZZ QA Cliente Nota"), "e o nome do cliente");
    ok(/1\.000,00/.test(html), "o valor pago");
    /* O saldo é o DAQUELE momento, não o de hoje: um papel assinado que muda
       de número depois não serve de recibo. */
    ok(/7\.000,00/.test(html), "e o saldo congelado da hora — 7.000, não o de agora");

    /* ------------------------------------------------------------------ */
    secao("10. o caixa da fábrica");
    ok((await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Energia", valor: 420.5 })).status === 400, "recusa despesa sem descrição");
    /* Sem `ocorrido_em`: quem decide "hoje" é o CURRENT_DATE do banco. A data
       do Node em UTC dataria o lançamento de amanhã depois das 21h daqui — e
       ele sumiria do caixa do dia. */
    const desp = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Energia", valor: 420.5, descricao: "ZZ QA conta de luz" });
    ok(desp.status === 201, "registra despesa sem nota", JSON.stringify(desp.dados));
    if (desp.dados && desp.dados.id) CRIADO.lancamentos.push(desp.dados.id);
    const hojeBanco = (await Q.get("SELECT CURRENT_DATE::text d")).d;
    const dataDesp = (await Q.get("SELECT ocorrido_em::text d FROM lancamentos WHERE id = ?", desp.dados.id)).d;
    ok(dataDesp === hojeBanco, "com a data do banco, não a do UTC do Node", dataDesp + " ≠ " + hojeBanco);

    const caixa = (await a("/restrito/api/caixa")).dados;
    const cats = caixa.categorias || [];
    ok(cats.some((c) => c.nome === "Energia"), "o caixa traz as categorias cadastráveis");
    /* Quem pede funcionário é a CATEGORIA, não a palavra "Salários" escrita no
       código: renomeá-la pelo cadastro não pode apagar o campo da tela. */
    ok(cats.some((c) => c.nome === "Salários" && c.pedeFuncionario === true),
      "e diz qual delas pede funcionário");
    ok(cats.filter((c) => c.pedeFuncionario).length === 1,
      "só a de salário pede, nas categorias de fábrica");
    ok(Number(caixa.resumo.entradas) >= 8000, "entradas incluem os recebimentos", caixa.resumo.entradas);
    ok(Number(caixa.resumo.saidas) >= 420.5, "saídas incluem a despesa", caixa.resumo.saidas);
    ok(Math.abs(Number(caixa.resumo.saldo) -
      (Number(caixa.resumo.entradas) - Number(caixa.resumo.saidas))) < 0.005, "e o saldo é a diferença");

    /* ------------------------------------------------------------------ */
    secao("11. salário: a despesa que tem dono");
    const semQuem = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Salários", valor: 1800, descricao: "ZZ QA salário" });
    ok(semQuem.status === 400 && /funcion/i.test(semQuem.dados.error),
      "recusa salário sem dizer a quem", JSON.stringify(semQuem.dados));

    /* E o contrário: aceitar um funcionário numa conta de luz encheria o
       relatório da folha de linhas que não são folha. */
    const quemDemais = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Energia", valor: 100, descricao: "ZZ QA luz", funcionario_id: op1 });
    ok(quemDemais.status === 400 && /não recebe funcion/i.test(quemDemais.dados.error),
      "recusa funcionário em categoria que não é folha", JSON.stringify(quemDemais.dados));

    const inventado = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Salários", valor: 1800, descricao: "ZZ QA salário",
        funcionario_id: 999999999 });
    ok(inventado.status === 404, "recusa funcionário que não existe", inventado.status);

    const sal = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Salários", valor: 1800, forma: "pix",
        descricao: "ZZ QA salário de agosto", funcionario_id: op1 });
    ok(sal.status === 201, "lança o salário com o funcionário", JSON.stringify(sal.dados));
    if (sal.dados && sal.dados.id) CRIADO.lancamentos.push(sal.dados.id);

    const sal2 = await a("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "Salários", valor: 1200, forma: "dinheiro",
        descricao: "ZZ QA salário de agosto", funcionario_id: op2 });
    if (sal2.dados && sal2.dados.id) CRIADO.lancamentos.push(sal2.dados.id);

    const folha = (await a("/restrito/api/caixa")).dados;
    ok(folha.itens.some((l) => Number(l.id) === Number(sal.dados.id) && l.funcionario_nome === "ZZ QA Maria"),
      "a lista mostra a quem o dinheiro foi");
    const pf = folha.porFuncionario || [];
    ok(pf.length >= 2, "e há quebra por funcionário", pf.length);
    const daMaria = pf.find((f) => f.nome === "ZZ QA Maria");
    ok(daMaria && Number(daMaria.valor) === 1800, "com o valor de cada um", daMaria && daMaria.valor);
    ok((folha.funcionarios || []).some((f) => f.nome === "ZZ QA José"),
      "e a lista de quem pode ser escolhido");

    const so = (await a("/restrito/api/caixa?funcionario=" + op1)).dados;
    ok(so.itens.length === 1 && Number(so.itens[0].id) === Number(sal.dados.id),
      "?funcionario= mostra a folha de um só", so.itens.length);

    /* Salário e nota na mesma linha faria a folha aparecer no extrato do
       cliente — o tipo de vazamento que ninguém procura. */
    ok(await (async () => { try {
      await Q.run("UPDATE lancamentos SET nota_id = ? WHERE id = ?", N1, sal.dados.id);
      return false;
    } catch { return true; } })(), "o banco impede salário com nota de cliente");

    secao("12. o banco recusa o estado impossível");
    const barra = async (sql, ...args) => {
      try { await Q.run(sql, ...args); return false; } catch { return true; }
    };
    ok(await barra("INSERT INTO lancamentos (tipo, categoria, valor) VALUES ('entrada','recebimento',10)"),
      "recebimento sem nota");
    ok(await barra("INSERT INTO lancamentos (tipo, categoria, nota_id, valor) VALUES ('saida','recebimento',?,10)", N1),
      "recebimento com direção invertida");
    ok(await barra("INSERT INTO lancamentos (tipo, categoria, valor) VALUES ('saida','Energia',-5)"),
      "valor negativo — o sinal vem do tipo, nunca do número");

    secao("12. o operador não vê o dinheiro");
    const o = nav();
    ok((await o("/restrito/api/entrar", "POST", { usuario: "zzqa.fin.op", senha: SENHA })).status === 200,
      "o operador entra normalmente");
    ok((await o("/restrito/api/notas")).status === 403, "mas não lista notas");
    ok((await o("/restrito/api/caixa")).status === 403, "não vê o caixa");
    ok((await o("/restrito/api/lancamentos", "POST",
      { tipo: "saida", categoria: "x", valor: 1, descricao: "x" })).status === 403, "não lança dinheiro");
    ok((await o("/restrito/api/notas", "POST", { cliente_id: cli, lotes: [L3] })).status === 403,
      "e não cria nota");

  } catch (e) {
    falhou++;
    falhas.push("a suíte quebrou: " + String((e && e.stack) || e).split("\n").slice(0, 3).join(" | "));
  } finally {
    /* Limpeza POR ID, na ordem das dependências. Nunca por LIKE. */
    for (const id of CRIADO.lancamentos) await Q.run("DELETE FROM lancamentos WHERE id = ?", id).catch(() => {});
    for (const id of CRIADO.notas) {
      await Q.run("DELETE FROM lancamentos WHERE nota_id = ?", id).catch(() => {});
      await Q.run("DELETE FROM notas WHERE id = ?", id).catch(() => {});
    }
    for (const id of CRIADO.fichas) await Q.run("DELETE FROM fichas WHERE id = ?", id).catch(() => {});
    for (const id of CRIADO.lotes) await Q.run("DELETE FROM lotes WHERE id = ?", id).catch(() => {});
    for (const id of CRIADO.desenhos) await Q.run("DELETE FROM desenhos WHERE id = ?", id).catch(() => {});
    for (const id of CRIADO.clientes) await Q.run("DELETE FROM clientes WHERE id = ?", id).catch(() => {});
    for (const id of CRIADO.usuarios) await Q.run("DELETE FROM usuarios WHERE id = ?", id).catch(() => {});

    /* A contagem é o teste da própria limpeza: se uma linha ZZ QA ficou no
       banco do cliente, a suíte tem de reprovar — e não avisar em letra
       miúda que "talvez" tenha sobrado algo. */
    const depois = await contar();
    const mudou = TABELAS.filter((t) => antes[t] !== depois[t]);
    ok(!mudou.length, "a suíte não deixou nada para trás",
      mudou.map((t) => `${t} ${antes[t]}→${depois[t]}`).join(", "));

    await Q.fechar().catch(() => {});
    srv.kill();

    const total = passou + falhou;
    console.log("\n  " + "─".repeat(58));
    if (falhou) {
      console.log(`\n  ✖ ${falhou} de ${total} falharam:\n`);
      for (const f of falhas) console.log("    · " + f);
      console.log("\n" + saida.slice(-800) + "\n");
      process.exit(1);
    }
    console.log(`\n  ✔ ${passou}/${total} — a conta do dinheiro fecha\n`);
    process.exit(0);
  }
})();
