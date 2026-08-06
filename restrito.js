/* ==========================================================================
   /restrito — sistema de produção da Borda Tudo

   Vive no PostgreSQL, com login próprio, separado do /admin do site.

   POR QUE SEPARADO DO /admin
   O /admin edita o que o VISITANTE lê: textos, vitrine, dúvidas. O /restrito é
   o chão de fábrica: quem está na máquina, o que produziu, quanto o cliente
   deve receber. São públicos diferentes, riscos diferentes e horários
   diferentes — e o cookie é outro (`rid`, não `sid`), para entrar num não ser
   entrar no outro, e sair de um não derrubar o outro.

   POR QUE OUTRO BANCO
   O site vive no SQLite e é publicado como arquivo estático. A produção cresce
   todo dia, tem várias pessoas gravando ao mesmo tempo e consultas que cruzam
   tabelas. A consequência que mais importa: se o PostgreSQL cair, o SITE
   CONTINUA NO AR — só o /restrito responde que o sistema não está disponível.

   AS DUAS TELAS
   O operador vê poucos botões e nada mais: iniciar produção, abrir ficha,
   fechar ficha. Quem está na máquina não quer navegar num sistema. O
   administrativo vê tudo e junta os lotes.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { Q } = require("./pg.js");
const { sanitizarHtml } = require("./html-seguro.js");

/* A versão é UMA SÓ, a do `package.json`, mostrada no alto da tela. Dois
   números de versão (um do site, outro do /restrito) fazem com que dizer "estou
   na 1.2" pare de identificar o que a pessoa tem na frente. */

/* ==========================================================================
   1. SESSÃO

   Em memória, como no /admin: reiniciar o serviço derruba as sessões, e isso é
   aceitável — quem estava logado entra de novo. Guardar em banco custaria uma
   ida ao Postgres a cada requisição para resolver um problema que a fábrica
   não tem.
   ========================================================================== */
const SESSAO_HORAS = 12;          // um turno inteiro, com folga
const sessoes = new Map();        // rid -> { usuarioId, usuario, nome, papel, visto }

const ridDe = (req) => (/(?:^|;\s*)rid=([a-f0-9]{48})/.exec(req.headers.cookie || "") || [])[1];

function sessaoDe(req) {
  const rid = ridDe(req);
  if (!rid) return null;
  const s = sessoes.get(rid);
  if (!s) return null;
  if (Date.now() - s.visto > SESSAO_HORAS * 3600e3) { sessoes.delete(rid); return null; }
  s.visto = Date.now();           // renova por atividade
  return s;
}

function cookieRid(rid, req, apagar = false) {
  const seguro = String(req.headers["x-forwarded-proto"]) === "https" ? "; Secure" : "";
  return apagar
    ? `rid=; Path=/restrito; HttpOnly; SameSite=Strict${seguro}; Max-Age=0`
    : `rid=${rid}; Path=/restrito; HttpOnly; SameSite=Strict${seguro}; Max-Age=${SESSAO_HORAS * 3600}`;
}

/* Limpeza periódica. Sem ela o mapa cresce para sempre num serviço que fica
   meses de pé. `.unref()` para o timer não segurar o processo no encerramento. */
setInterval(() => {
  const limite = Date.now() - SESSAO_HORAS * 3600e3;
  for (const [k, v] of sessoes) if (v.visto < limite) sessoes.delete(k);
}, 30 * 60e3).unref();

/* ==========================================================================
   2. SENHA — scrypt com salt individual

   SHA-256 é rápido de propósito: uma GPU testa bilhões por segundo, e um banco
   vazado entrega as senhas em minutos. O scrypt é lento de propósito e exige
   memória por tentativa, o que inviabiliza o ataque em escala.
   ========================================================================== */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

function conferirSenha(senha, guardado) {
  if (!guardado || !String(guardado).startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, dkHex] = String(guardado).split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2,
    { N: +N, r: +r, p: +p });
  const a = Buffer.from(dkHex, "hex");
  /* `timingSafeEqual` exige o mesmo tamanho, e comparar tamanhos antes já
     vaza informação — mas de quantos bytes tem o hash, não da senha. */
  return a.length === dk.length && crypto.timingSafeEqual(a, dk);
}

/* ==========================================================================
   3. RESPOSTA E CORPO
   ========================================================================== */
function responder(res, codigo, obj, cabecalhos = {}) {
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    ...cabecalhos,
  });
  /* Texto pronto (a folha de etiquetas) sai como veio; o resto vira JSON. */
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let d = "", n = 0;
    req.on("data", (c) => {
      n += c.length;
      /* 25 MB cobre foto de desenho por upload no futuro. Sem teto, um POST
         gigante enche a memória do processo e derruba o site junto. */
      if (n > 25e6) { falha(new Error("corpo muito grande")); req.destroy(); }
      d += c;
    });
    req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { falha(new Error("JSON inválido")); } });
  });
}

/* ==========================================================================
   3b. ETIQUETAS DE MÁQUINA (QR)

   Cada máquina tem um `token`. O QR colado nela leva para
   /restrito?m=<token>, e a tela do operador entende isso como "estou nesta
   máquina" — poupando a escolha manual, que é onde se erra quando se está de
   luva e com a máquina rodando.

   O QR IDENTIFICA, NÃO AUTENTICA. Quem escaneia ainda precisa estar logado.
   Se não fosse assim, fotografar o adesivo daria acesso ao sistema — e o
   adesivo está colado numa máquina, à vista de qualquer um que entre na
   fábrica.
   ========================================================================== */
const qrcode = require("qrcode");

function enderecoBase(req) {
  /* Atrás do nginx a conexão interna é http, mas o endereço que o celular vai
     abrir é https — o QR tem de levar o endereço EXTERNO, senão o telefone
     tenta abrir um http que o HSTS recusa. */
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (req.socket.encrypted ? "https" : "http");
  const host = String(req.headers.host || "localhost");
  return `${proto}://${host}`;
}

async function folhaDeEtiquetas(maquinas, base) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const cartoes = [];
  for (const m of maquinas) {
    const url = `${base}/restrito?m=${encodeURIComponent(m.token)}`;
    /* Correção de erro ALTA: o adesivo vai viver numa máquina de bordado, com
       poeira, fiapo e óleo. Um QR nível L para de ler com um arranhão; o H
       aguenta perder um quarto da área. */
    const svg = await qrcode.toString(url, {
      type: "svg", margin: 1, errorCorrectionLevel: "H",
    });
    cartoes.push(`<div class="et">
      <div class="qr">${svg}</div>
      <div class="nome">${esc(m.nome)}</div>
      <div class="sub">${Number(m.cabecas) || 1} cabeça${(Number(m.cabecas) || 1) > 1 ? "s" : ""}</div>
      <div class="cod">${esc(m.token)}</div>
    </div>`);
  }

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Etiquetas das máquinas — Borda Tudo</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:16mm 10mm;font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#f6f6f7}
  h1{font-size:20px;margin:0 0 4px}
  p.aviso{margin:0 0 18px;color:#555;max-width:60ch}
  .folha{display:grid;grid-template-columns:repeat(auto-fill,minmax(62mm,1fr));gap:8mm}
  .et{border:1.5px dashed #999;border-radius:6px;padding:6mm 4mm;text-align:center;background:#fff;break-inside:avoid}
  .qr svg{width:44mm;height:44mm;display:block;margin:0 auto}
  .nome{font-size:20px;font-weight:800;letter-spacing:.02em;margin-top:3mm}
  .sub{font-size:12px;color:#666}
  .cod{font:11px ui-monospace,Consolas,monospace;color:#999;margin-top:2mm;word-break:break-all}
  .imprimir{position:fixed;right:16px;top:16px;padding:10px 18px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:700;cursor:pointer}
  /* A folha impressa não leva o botão nem o texto explicativo: papel colado na
     máquina só precisa do código e do nome. */
  @media print{body{background:#fff;padding:8mm}.imprimir,p.aviso,h1{display:none}}
</style></head><body>
<button class="imprimir" onclick="print()">Imprimir</button>
<h1>Etiquetas das máquinas</h1>
<p class="aviso">Imprima, recorte e cole cada etiqueta na máquina correspondente.
Ao ler o código com o celular, a tela de produção já abre com a máquina escolhida.
O código identifica a máquina — ele <strong>não</strong> dá acesso ao sistema: é preciso estar logado.</p>
<div class="folha">${cartoes.join("\n") || "<p>Nenhuma máquina ativa cadastrada.</p>"}</div>
</body></html>`;
}

/* ==========================================================================
   4. CADASTROS — uma definição, cinco telas

   As cinco tabelas de apoio (clientes, desenhos, mercadorias, cores, máquinas)
   têm a mesma vida: listar, criar, alterar, desativar. Escrever cinco vezes o
   mesmo CRUD garante que as cinco divirjam no primeiro ajuste — uma ganha
   validação, outra não, e ninguém lembra qual.

   `campos` é o que se aceita gravar. O que não está aqui é IGNORADO, e é isso
   que impede um POST de escrever `id`, `criado_em` ou `token` de máquina.
   ========================================================================== */
const CADASTROS = {
  clientes: {
    tabela: "clientes",
    campos: ["nome", "telefone", "observacao", "ativo"],
    obrigatorios: ["nome"],
    ordem: "nome",
  },
  desenhos: {
    tabela: "desenhos",
    campos: ["cliente_id", "nome", "pontuacao", "observacao", "ativo"],
    obrigatorios: ["nome", "pontuacao"],
    ordem: "nome",
  },
  mercadorias: { tabela: "mercadorias", campos: ["nome", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
  cores:       { tabela: "cores",       campos: ["nome", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
  maquinas:    { tabela: "maquinas",    campos: ["nome", "cabecas", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
};

const INTEIROS = new Set(["cliente_id", "pontuacao", "cabecas"]);

function prepararCadastro(def, corpo) {
  const dados = {};
  for (const c of def.campos) {
    if (!(c in corpo)) continue;
    let v = corpo[c];
    if (c === "ativo") v = !!v && v !== "0" && v !== "false";
    else if (INTEIROS.has(c)) {
      const s = String(v ?? "").trim();
      /* Vazio é NULO, não zero. `Number("")` é 0 em JavaScript, e foi assim
         que um desenho já entrou valendo zero ponto em outro projeto. */
      if (s === "") v = null;
      else {
        const n = Number(s.replace(/\D/g, ""));
        if (!Number.isFinite(n)) throw new Error(`${c} precisa ser um número`);
        v = n;
      }
    } else {
      v = String(v ?? "").trim().replace(/\s+/g, " ");
      /* Observação aceita formatação; nome não — nome é chave de busca e de
         índice único, e uma tag dentro dele quebraria a comparação. */
      if (c === "observacao") v = sanitizarHtml(v);
    }
    dados[c] = v;
  }
  for (const o of def.obrigatorios) {
    if (o in dados && (dados[o] === null || dados[o] === "")) throw new Error(`${o} é obrigatório`);
  }
  if ("pontuacao" in dados && dados.pontuacao !== null && dados.pontuacao <= 0)
    throw new Error("a pontuação precisa ser maior que zero");
  return dados;
}

/* Mensagem de erro que a pessoa entende. O Postgres devolve "duplicar valor da
   chave viola a restrição de unicidade ux_clientes_nome" — verdadeiro e
   inútil para quem está cadastrando. */
function erroDeBanco(e, def) {
  const m = String(e.message || "");
  if (/unicidade|unique/i.test(m)) return `Já existe um cadastro com esse nome.`;
  if (/chave estrangeira|foreign key/i.test(m)) return `Esse registro está em uso e não pode ser apagado.`;
  return m.split("\n")[0];
}

/* ==========================================================================
   5. ROTAS
   ========================================================================== */
async function rotas(req, res, caminho, limitador, ipDoCliente) {
  /* ---------------------------------------------------------- entrar ---- */
  if (caminho === "/restrito/api/entrar" && req.method === "POST") {
    const ip = ipDoCliente(req);
    const corpo = (await lerCorpo(req)) || {};
    const usuario = String(corpo.usuario || "").trim().toLowerCase();

    /* A trava tem balde por IP E por CONTA. Só por IP, um ataque distribuído
       nunca é barrado; só por conta, quem ataca tranca o dono de fora do
       próprio sistema — que é o resultado pior. */
    const pode = limitador.verificar("restrito", ip, usuario);
    if (!pode.ok) return responder(res, 429, { error: pode.mensagem }, { "Retry-After": String(pode.esperar || 60) });

    const u = await Q.get("SELECT * FROM usuarios WHERE usuario = ? AND ativo", usuario);
    /* A MESMA mensagem para usuário inexistente e senha errada. Mensagens
       diferentes contam ao atacante quais logins existem, e aí ele só precisa
       descobrir a senha de um que já sabe que existe. */
    if (!u || !conferirSenha(corpo.senha, u.senha_hash)) {
      limitador.errou("restrito", ip, usuario);
      return responder(res, 401, { error: "Usuário ou senha incorretos" });
    }
    limitador.acertou("restrito", ip, usuario);

    const rid = crypto.randomBytes(24).toString("hex");
    sessoes.set(rid, { usuarioId: u.id, usuario: u.usuario, nome: u.nome, papel: u.papel, visto: Date.now() });
    return responder(res, 200, { ok: true, usuario: u.usuario, nome: u.nome, papel: u.papel },
      { "Set-Cookie": cookieRid(rid, req) });
  }

  if (caminho === "/restrito/api/sair" && req.method === "POST") {
    const rid = ridDe(req);
    if (rid) sessoes.delete(rid);
    return responder(res, 200, { ok: true }, { "Set-Cookie": cookieRid("", req, true) });
  }

  /* ---- daqui para baixo, exige sessão ---- */
  const sessao = sessaoDe(req);
  if (!sessao) {
    /* Página (a folha de etiquetas) devolve a TELA DE ENTRADA; devolver um JSON
       "não autenticado" no navegador só mostraria texto solto a quem, na
       verdade, só precisa entrar de novo. */
    if (!caminho.startsWith("/restrito/api/")) {
      res.writeHead(302, { Location: "/restrito", "Cache-Control": "no-store" });
      return res.end();
    }
    return responder(res, 401, { error: "Não autenticado" });
  }

  if (caminho === "/restrito/api/eu") {
    return responder(res, 200, {
      usuario: sessao.usuario, nome: sessao.nome, papel: sessao.papel,
    });
  }

  /* Que máquina é esta do QR. Existe para a tela poder ESCREVER O NOME no alto:
     "máquina lida" sem dizer qual não deixa ninguém perceber que leu o adesivo
     errado — e o erro só apareceria no relatório, dias depois. */
  if (caminho === "/restrito/api/maquina-do-qr" && req.method === "GET") {
    const t = new URL(req.url, "http://localhost").searchParams.get("m") || "";
    const m = await Q.get("SELECT id, nome FROM maquinas WHERE token = ? AND ativo", t);
    if (!m) return responder(res, 404, { error: "QR de máquina não reconhecido" });
    return responder(res, 200, m);
  }

  /* Trocar a própria senha. Exige a atual: sem isso, uma tela deixada aberta no
     chão de fábrica vira troca de senha alheia em dois cliques. */
  if (caminho === "/restrito/api/eu/senha" && req.method === "PUT") {
    const corpo = (await lerCorpo(req)) || {};
    const nova = String(corpo.nova || "");
    if (nova.length < 8) return responder(res, 400, { error: "a nova senha precisa de pelo menos 8 caracteres" });
    const u = await Q.get("SELECT senha_hash FROM usuarios WHERE id = ?", sessao.usuarioId);
    if (!u || !conferirSenha(corpo.atual, u.senha_hash))
      return responder(res, 401, { error: "senha atual incorreta" });
    await Q.run("UPDATE usuarios SET senha_hash = ? WHERE id = ?", gerarHash(nova), sessao.usuarioId);

    /* Derruba as OUTRAS sessões desta conta. Quem troca a senha normalmente
       troca porque desconfia de alguém — deixar a sessão do outro viva anula
       o motivo da troca. */
    const rid = ridDe(req);
    for (const [k, s] of sessoes) if (s.usuarioId === sessao.usuarioId && k !== rid) sessoes.delete(k);
    return responder(res, 200, { ok: true });
  }

  /* ----------------------------------------------------- cadastros ------ */
  const mCad = /^\/restrito\/api\/(clientes|desenhos|mercadorias|cores|maquinas)(?:\/(\d+))?$/.exec(caminho);
  if (mCad) {
    const def = CADASTROS[mCad[1]];
    const id = mCad[2] ? Number(mCad[2]) : null;

    if (req.method === "GET" && !id) {
      const url = new URL(req.url, "http://localhost");
      /* Por padrão só os ATIVOS: a lista existe para escolher, e oferecer o
         que foi desativado desfaz a desativação na prática. `?todos=1` é para
         a tela de cadastro, onde se quer ver e reativar. */
      const todos = url.searchParams.get("todos") === "1";
      const onde = todos ? "" : "WHERE ativo";
      if (def.tabela === "desenhos") {
        /* O desenho vem com o nome do cliente: a tela mostra "RECIFE1 —
           Marcela", e sem isso ela teria de cruzar duas listas no navegador. */
        const linhas = await Q.all(
          `SELECT d.*, c.nome AS cliente_nome FROM desenhos d
             LEFT JOIN clientes c ON c.id = d.cliente_id
             ${todos ? "" : "WHERE d.ativo"} ORDER BY d.nome`);
        return responder(res, 200, { itens: linhas });
      }
      /* `maquinas` não devolve o token na listagem — ele só sai na rota do QR.
         Token é identificador de adesivo, não dado de tela. */
      const colunas = def.tabela === "maquinas" ? "id, nome, cabecas, ativo, criado_em" : "*";
      const linhas = await Q.all(`SELECT ${colunas} FROM ${def.tabela} ${onde} ORDER BY ${def.ordem}`);
      return responder(res, 200, { itens: linhas });
    }

    /* Criar e alterar são só do administrador. O operador escolhe da lista;
       se ele pudesse cadastrar, "Marcela" e "marcella" apareceriam as duas na
       correria do turno e o relatório do mês sairia partido em dois. */
    if (req.method !== "GET" && sessao.papel !== "admin")
      return responder(res, 403, { error: "só o administrador mexe nos cadastros" });

    if (req.method === "POST" && !id) {
      let dados;
      try { dados = prepararCadastro(def, (await lerCorpo(req)) || {}); }
      catch (e) { return responder(res, 400, { error: e.message }); }
      for (const o of def.obrigatorios) if (!(o in dados)) return responder(res, 400, { error: `${o} é obrigatório` });

      /* A máquina nasce com o token do QR. Aleatório e sem significado: um
         token sequencial deixaria adivinhar o das outras máquinas, e ainda que
         ele não autentique, não há motivo para facilitar. */
      if (def.tabela === "maquinas") dados.token = crypto.randomBytes(9).toString("base64url");

      const cols = Object.keys(dados);
      if (!cols.length) return responder(res, 400, { error: "nada para gravar" });
      try {
        const novo = await Q.inserir(
          `INSERT INTO ${def.tabela} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) RETURNING id`,
          ...cols.map((c) => dados[c]));
        return responder(res, 201, { ok: true, id: novo });
      } catch (e) { return responder(res, 400, { error: erroDeBanco(e, def) }); }
    }

    if (req.method === "PUT" && id) {
      let dados;
      try { dados = prepararCadastro(def, (await lerCorpo(req)) || {}); }
      catch (e) { return responder(res, 400, { error: e.message }); }
      const cols = Object.keys(dados);
      if (!cols.length) return responder(res, 400, { error: "nada para gravar" });
      try {
        await Q.run(`UPDATE ${def.tabela} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
          ...cols.map((c) => dados[c]), id);
        return responder(res, 200, { ok: true });
      } catch (e) { return responder(res, 400, { error: erroDeBanco(e, def) }); }
    }

    if (req.method === "DELETE" && id) {
      /* Não apaga: DESATIVA. Cadastro em uso numa ficha de três meses atrás
         não pode sumir — o relatório daquele mês passaria a mostrar um vazio
         onde havia um cliente. O que sai é a lista de escolha, não o passado.

         As chaves estrangeiras são RESTRICT justamente para o banco recusar
         caso alguém tente apagar por fora. */
      await Q.run(`UPDATE ${def.tabela} SET ativo = FALSE WHERE id = ?`, id);
      return responder(res, 200, { ok: true, desativado: true });
    }
  }

  /* ======================================================================
     JORNADA — o "INÍCIO DE PRODUÇÃO"

     Responde "quem esteve aqui e por quanto tempo", separado da ficha, que
     responde "o que foi bordado". A folha de papel tem um campo "Horas Extras"
     no alto justamente porque são duas perguntas.
     ====================================================================== */
  if (caminho === "/restrito/api/jornadas" && req.method === "POST") {
    const aberta = await Q.get("SELECT id FROM jornadas WHERE usuario_id = ? AND fim IS NULL", sessao.usuarioId);
    /* Já tem uma aberta: devolve a mesma em vez de erro. Dois toques no botão
       na tela da fábrica é o caso comum, não a exceção — e o banco recusaria a
       segunda com um erro de driver que não diz nada a quem está na máquina. */
    if (aberta) return responder(res, 200, { ok: true, id: aberta.id, jaEstavaAberta: true });
    const id = await Q.inserir("INSERT INTO jornadas (usuario_id) VALUES (?) RETURNING id", sessao.usuarioId);
    return responder(res, 201, { ok: true, id });
  }

  const mJornada = /^\/restrito\/api\/jornadas\/(\d+)\/encerrar$/.exec(caminho);
  if (mJornada && req.method === "PUT") {
    const id = Number(mJornada[1]);
    const j = await Q.get("SELECT * FROM jornadas WHERE id = ?", id);
    if (!j) return responder(res, 404, { error: "jornada não encontrada" });
    if (Number(j.usuario_id) !== Number(sessao.usuarioId) && sessao.papel !== "admin")
      return responder(res, 403, { error: "essa jornada não é sua" });
    if (j.fim) return responder(res, 200, { ok: true, jaEstavaFechada: true });

    /* Encerrar com ficha aberta é o erro que faz o dia sair errado: a ficha
       fica pendurada e o operador vai embora. Barra e diz o que fazer. */
    const ficha = await Q.get(
      "SELECT id FROM fichas WHERE usuario_id = ? AND situacao = 'aberta'", j.usuario_id);
    if (ficha) return responder(res, 409, {
      error: "Feche a ficha que está aberta antes de encerrar a produção.",
      fichaAberta: ficha.id,
    });

    await Q.run("UPDATE jornadas SET fim = now() WHERE id = ?", id);
    return responder(res, 200, { ok: true });
  }

  /* ======================================================================
     O DIA DO OPERADOR — tudo que a tela dele precisa, numa requisição

     A tela da fábrica é aberta e recarregada o dia inteiro, muitas vezes num
     celular preso na máquina. Três chamadas separadas para montá-la seriam
     três chances de meia-tela em rede ruim.
     ====================================================================== */
  if (caminho === "/restrito/api/meu-dia" && req.method === "GET") {
    const uid = sessao.usuarioId;
    const jornada = await Q.get(
      "SELECT id, inicio FROM jornadas WHERE usuario_id = ? AND fim IS NULL", uid);
    const ficha = await Q.get(
      `SELECT f.*, c.nome AS cliente_nome, d.nome AS desenho_nome, m.nome AS maquina_nome
         FROM fichas f
         JOIN clientes c ON c.id = f.cliente_id
         JOIN desenhos d ON d.id = f.desenho_id
         LEFT JOIN maquinas m ON m.id = f.maquina_id
        WHERE f.usuario_id = ? AND f.situacao = 'aberta'`, uid);

    /* "Hoje" é do fuso do SERVIDOR, não do navegador: dois operadores em
       máquinas com relógio diferente veriam dias diferentes. */
    const fechadas = await Q.all(
      `SELECT f.*, c.nome AS cliente_nome, d.nome AS desenho_nome,
              me.nome AS mercadoria_nome, co.nome AS cor_nome, ma.nome AS maquina_nome
         FROM fichas f
         JOIN clientes c ON c.id = f.cliente_id
         JOIN desenhos d ON d.id = f.desenho_id
         LEFT JOIN mercadorias me ON me.id = f.mercadoria_id
         LEFT JOIN cores co ON co.id = f.cor_id
         LEFT JOIN maquinas ma ON ma.id = f.maquina_id
        WHERE f.usuario_id = ? AND f.situacao = 'fechada'
          AND f.fechada_em::date = current_date
        ORDER BY f.fechada_em DESC`, uid);

    const soma = fechadas.reduce((a, f) => ({
      pecas: a.pecas + Number(f.quantidade || 0),
      pontos: a.pontos + Number(f.total_pontos || 0),
    }), { pecas: 0, pontos: 0 });

    return responder(res, 200, { jornada: jornada || null, ficha: ficha || null, fechadas, soma });
  }

  /* ======================================================================
     FICHA
     ====================================================================== */
  if (caminho === "/restrito/api/fichas" && req.method === "POST") {
    const corpo = (await lerCorpo(req)) || {};
    const clienteId = Number(corpo.cliente_id) || null;
    const desenhoId = Number(corpo.desenho_id) || null;
    if (!clienteId) return responder(res, 400, { error: "escolha o cliente" });
    if (!desenhoId) return responder(res, 400, { error: "escolha o desenho" });

    const jaAberta = await Q.get(
      "SELECT id FROM fichas WHERE usuario_id = ? AND situacao = 'aberta'", sessao.usuarioId);
    if (jaAberta) return responder(res, 409, {
      error: "Você já tem uma ficha aberta. Feche-a antes de abrir outra.", fichaAberta: jaAberta.id,
    });

    const desenho = await Q.get("SELECT id, pontuacao, cliente_id FROM desenhos WHERE id = ? AND ativo", desenhoId);
    if (!desenho) return responder(res, 400, { error: "desenho não encontrado" });

    /* A PONTUAÇÃO É COPIADA DO DESENHO, e nunca vem do corpo da requisição.
       Se viesse, a tela poderia mandar qualquer número — e o valor da nota
       passaria a depender do que estava aberto no navegador. */
    const pontuacao = Number(desenho.pontuacao);

    /* Máquina pelo TOKEN do QR, ou pelo id. O token é o caminho normal (o
       operador escaneou o adesivo); o id é o atalho de quem escolheu na lista. */
    let maquinaId = null;
    if (corpo.maquina_token) {
      const m = await Q.get("SELECT id FROM maquinas WHERE token = ? AND ativo", String(corpo.maquina_token));
      if (!m) return responder(res, 400, { error: "QR de máquina não reconhecido" });
      maquinaId = m.id;
    } else if (corpo.maquina_id) {
      maquinaId = Number(corpo.maquina_id) || null;
    }

    /* Sem jornada aberta, abre uma. O operador que esquece de bater o início e
       vai direto trabalhar não pode ficar sem registro de hora — e a jornada
       começa quando ele de fato começou, que é agora. */
    let jornada = await Q.get("SELECT id FROM jornadas WHERE usuario_id = ? AND fim IS NULL", sessao.usuarioId);
    if (!jornada) {
      const jid = await Q.inserir("INSERT INTO jornadas (usuario_id) VALUES (?) RETURNING id", sessao.usuarioId);
      jornada = { id: jid };
    }

    const id = await Q.inserir(
      `INSERT INTO fichas (usuario_id, jornada_id, maquina_id, cliente_id, desenho_id, pontuacao)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      sessao.usuarioId, jornada.id, maquinaId, clienteId, desenhoId, pontuacao);
    return responder(res, 201, { ok: true, id, pontuacao });
  }

  const mFicha = /^\/restrito\/api\/fichas\/(\d+)(?:\/(fechar|cancelar))?$/.exec(caminho);
  if (mFicha) {
    const id = Number(mFicha[1]);
    const acao = mFicha[2];
    const f = await Q.get("SELECT * FROM fichas WHERE id = ?", id);
    if (!f) return responder(res, 404, { error: "ficha não encontrada" });
    const minha = Number(f.usuario_id) === Number(sessao.usuarioId);
    if (!minha && sessao.papel !== "admin")
      return responder(res, 403, { error: "essa ficha não é sua" });

    if (acao === "fechar" && req.method === "PUT") {
      if (f.situacao !== "aberta") return responder(res, 409, { error: "essa ficha já foi fechada" });
      const corpo = (await lerCorpo(req)) || {};
      const qtd = Number(String(corpo.quantidade ?? "").replace(/\D/g, ""));
      if (!Number.isFinite(qtd) || qtd <= 0)
        return responder(res, 400, { error: "informe quantas peças foram feitas" });

      await Q.run(
        `UPDATE fichas SET quantidade = ?, mercadoria_id = ?, cor_id = ?, observacao = ?,
                situacao = 'fechada', fechada_em = now()
          WHERE id = ?`,
        qtd,
        Number(corpo.mercadoria_id) || null,
        Number(corpo.cor_id) || null,
        sanitizarHtml(String(corpo.observacao || "")),
        id);
      const r = await Q.get("SELECT quantidade, pontuacao, total_pontos, aberta_em, fechada_em FROM fichas WHERE id = ?", id);
      return responder(res, 200, { ok: true, ficha: r });
    }

    if (acao === "cancelar" && req.method === "PUT") {
      if (f.situacao === "fechada" && sessao.papel !== "admin")
        return responder(res, 403, { error: "ficha já fechada — só o administrador cancela" });
      await Q.run("UPDATE fichas SET situacao = 'cancelada' WHERE id = ?", id);
      return responder(res, 200, { ok: true });
    }

    if (!acao && req.method === "PUT") {
      /* Corrigir uma ficha já fechada é coisa de administrador: é o número que
         vai virar nota. A quantidade e a pontuação são o que se corrige; o
         resto (quem, quando) é histórico e não se mexe. */
      if (sessao.papel !== "admin") return responder(res, 403, { error: "só o administrador corrige ficha" });
      const corpo = (await lerCorpo(req)) || {};
      const campos = {}, aceita = ["quantidade", "mercadoria_id", "cor_id", "observacao", "pontuacao"];
      for (const c of aceita) {
        if (!(c in corpo)) continue;
        if (c === "observacao") campos[c] = sanitizarHtml(String(corpo[c] || ""));
        else {
          const n = Number(String(corpo[c] ?? "").replace(/\D/g, ""));
          campos[c] = Number.isFinite(n) && String(corpo[c]).trim() !== "" ? n : null;
        }
      }
      if (!Object.keys(campos).length) return responder(res, 400, { error: "nada para alterar" });
      if ("pontuacao" in campos && (!campos.pontuacao || campos.pontuacao <= 0))
        return responder(res, 400, { error: "a pontuação precisa ser maior que zero" });
      const cols = Object.keys(campos);
      await Q.run(`UPDATE fichas SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        ...cols.map((c) => campos[c]), id);
      return responder(res, 200, { ok: true });
    }

    if (req.method === "GET") return responder(res, 200, f);
  }

  /* ======================================================================
     ADMINISTRATIVO — daqui para baixo, só administrador
     ====================================================================== */
  if (sessao.papel !== "admin") return responder(res, 403, { error: "área do administrador" });

  /* Consulta das fichas. É a tela que substitui o "juntar as folhas dos
     operadores": filtra por período, operador, cliente, e mostra o que ainda
     não foi amalgamado em lote nenhum. */
  if (caminho === "/restrito/api/producao" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const de = url.searchParams.get("de") || null;
    const ate = url.searchParams.get("ate") || null;
    const usuarioId = Number(url.searchParams.get("usuario")) || null;
    const clienteId = Number(url.searchParams.get("cliente")) || null;
    const soltas = url.searchParams.get("soltas") === "1";

    const onde = ["f.situacao = 'fechada'"];
    const args = [];
    /* `::date` dos dois lados: sem isso, "até 05/08" não pega o que foi
       fechado às 14h de 05/08, porque a data pura vira meia-noite. */
    if (de)  { onde.push("f.fechada_em::date >= ?::date"); args.push(de); }
    if (ate) { onde.push("f.fechada_em::date <= ?::date"); args.push(ate); }
    if (usuarioId) { onde.push("f.usuario_id = ?"); args.push(usuarioId); }
    if (clienteId) { onde.push("f.cliente_id = ?"); args.push(clienteId); }
    if (soltas) onde.push("f.lote_id IS NULL");

    const fichas = await Q.all(
      `SELECT f.*, u.nome AS operador_nome, c.nome AS cliente_nome, d.nome AS desenho_nome,
              me.nome AS mercadoria_nome, co.nome AS cor_nome, ma.nome AS maquina_nome,
              l.codigo AS lote_codigo
         FROM fichas f
         JOIN usuarios u ON u.id = f.usuario_id
         JOIN clientes c ON c.id = f.cliente_id
         JOIN desenhos d ON d.id = f.desenho_id
         LEFT JOIN mercadorias me ON me.id = f.mercadoria_id
         LEFT JOIN cores co ON co.id = f.cor_id
         LEFT JOIN maquinas ma ON ma.id = f.maquina_id
         LEFT JOIN lotes l ON l.id = f.lote_id
        WHERE ${onde.join(" AND ")}
        ORDER BY f.fechada_em DESC LIMIT 500`, ...args);

    const soma = fichas.reduce((a, f) => ({
      pecas: a.pecas + Number(f.quantidade || 0),
      pontos: a.pontos + Number(f.total_pontos || 0),
    }), { pecas: 0, pontos: 0 });

    /* Por operador, para responder "quem produziu o quê hoje" sem a pessoa ter
       de somar a lista na cabeça — que é exatamente o trabalho que o papel dá. */
    const porOperador = {};
    for (const f of fichas) {
      const k = f.operador_nome || "?";
      porOperador[k] = porOperador[k] || { pecas: 0, pontos: 0, fichas: 0 };
      porOperador[k].pecas += Number(f.quantidade || 0);
      porOperador[k].pontos += Number(f.total_pontos || 0);
      porOperador[k].fichas++;
    }
    return responder(res, 200, { fichas, soma, porOperador });
  }

  /* ---------------------------------------------------------- lotes ----- */
  if (caminho === "/restrito/api/lotes" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const situacao = url.searchParams.get("situacao");
    const onde = [], args = [];
    if (situacao) { onde.push("l.situacao = ?"); args.push(situacao); }

    /* Os totais saem das FICHAS, por subconsulta — o lote não guarda soma.
       Guardar criaria duas verdades, e a errada seria justamente a que alguém
       leria na hora de fazer a nota. */
    const lotes = await Q.all(
      `SELECT l.*, c.nome AS cliente_nome,
              (SELECT COUNT(*) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS fichas,
              (SELECT COALESCE(SUM(f.quantidade),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pecas,
              (SELECT COALESCE(SUM(f.total_pontos),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pontos
         FROM lotes l JOIN clientes c ON c.id = l.cliente_id
        ${onde.length ? "WHERE " + onde.join(" AND ") : ""}
        ORDER BY l.criado_em DESC LIMIT 300`, ...args);
    return responder(res, 200, { lotes });
  }

  if (caminho === "/restrito/api/lotes" && req.method === "POST") {
    const corpo = (await lerCorpo(req)) || {};
    const clienteId = Number(corpo.cliente_id) || null;
    if (!clienteId) return responder(res, 400, { error: "escolha o cliente" });

    /* O código nasce do BANCO, não da tela: duas pessoas criando ao mesmo
       tempo escolheriam o mesmo número, e a UNIQUE recusaria a segunda com um
       erro de driver. */
    const ano = new Date().getFullYear();
    const r = await Q.get(
      `SELECT COALESCE(MAX(split_part(codigo, '-', 3)::int), 0) AS n
         FROM lotes WHERE codigo ~ ?`, `^LOTE-${ano}-[0-9]+$`);
    const codigo = `LOTE-${ano}-${String(Number(r?.n || 0) + 1).padStart(4, "0")}`;

    const prev = String(corpo.quantidade_prevista ?? "").replace(/\D/g, "");
    const id = await Q.inserir(
      `INSERT INTO lotes (cliente_id, codigo, descricao, quantidade_prevista, entrada_em, observacao)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      clienteId, codigo,
      String(corpo.descricao || "").trim(),
      prev === "" ? null : Number(prev),
      corpo.entrada_em || null,
      sanitizarHtml(String(corpo.observacao || "")));
    return responder(res, 201, { ok: true, id, codigo });
  }

  const mLote = /^\/restrito\/api\/lotes\/(\d+)(?:\/(fichas))?$/.exec(caminho);
  if (mLote) {
    const id = Number(mLote[1]);
    const lote = await Q.get(
      `SELECT l.*, c.nome AS cliente_nome FROM lotes l JOIN clientes c ON c.id = l.cliente_id WHERE l.id = ?`, id);
    if (!lote) return responder(res, 404, { error: "lote não encontrado" });

    if (mLote[2] === "fichas" && req.method === "PUT") {
      /* A AMÁLGAMA. Recebe a lista completa de fichas do lote e reconcilia:
         solta as que saíram, prende as que entraram. Mandar a lista inteira, e
         não "adicione esta", torna a operação idempotente — repetir o mesmo
         pedido dá o mesmo resultado, e um clique duplo não duplica nada. */
      const corpo = (await lerCorpo(req)) || {};
      const ids = (Array.isArray(corpo.fichas) ? corpo.fichas : []).map(Number).filter(Boolean);

      if (lote.situacao === "faturado")
        return responder(res, 409, { error: "lote já faturado — não dá para mexer nas fichas" });

      await Q.tx(async () => {
        await Q.run("UPDATE fichas SET lote_id = NULL WHERE lote_id = ?", id);
        if (ids.length) {
          /* Só ficha FECHADA e do MESMO cliente entra. Ficha aberta ainda não
             tem quantidade, e de outro cliente somaria peça de um no corte de
             outro — o erro que a amálgama existe para evitar. */
          await Q.run(
            `UPDATE fichas SET lote_id = ?
              WHERE id = ANY(?) AND situacao = 'fechada' AND cliente_id = ?`,
            id, ids, lote.cliente_id);
        }
      });
      const n = await Q.get("SELECT COUNT(*) c FROM fichas WHERE lote_id = ?", id);
      return responder(res, 200, { ok: true, anexadas: Number(n.c), pedidas: ids.length });
    }

    if (req.method === "GET") {
      const fichas = await Q.all(
        `SELECT f.*, u.nome AS operador_nome, d.nome AS desenho_nome,
                me.nome AS mercadoria_nome, co.nome AS cor_nome
           FROM fichas f
           JOIN usuarios u ON u.id = f.usuario_id
           JOIN desenhos d ON d.id = f.desenho_id
           LEFT JOIN mercadorias me ON me.id = f.mercadoria_id
           LEFT JOIN cores co ON co.id = f.cor_id
          WHERE f.lote_id = ? AND f.situacao = 'fechada'
          ORDER BY f.fechada_em`, id);

      const pecas = fichas.reduce((a, f) => a + Number(f.quantidade || 0), 0);
      const pontos = fichas.reduce((a, f) => a + Number(f.total_pontos || 0), 0);

      /* Quebra por COR e por MERCADORIA — é para isso que a cor é campo
         próprio. "1500 abas" fecha somando 100 pretas + 500 brancas + …, e sem
         a quebra não dá para saber o que ainda falta. */
      const agrupar = (chave, rotulo) => {
        const m = {};
        for (const f of fichas) {
          const k = f[chave] || "(não informado)";
          m[k] = (m[k] || 0) + Number(f.quantidade || 0);
        }
        return Object.entries(m).map(([nome, pecas]) => ({ nome, pecas }))
          .sort((a, b) => b.pecas - a.pecas);
      };

      const porOperador = {};
      for (const f of fichas) {
        const k = f.operador_nome || "?";
        porOperador[k] = (porOperador[k] || 0) + Number(f.quantidade || 0);
      }

      return responder(res, 200, {
        lote, fichas, pecas, pontos,
        falta: lote.quantidade_prevista === null ? null : Number(lote.quantidade_prevista) - pecas,
        porCor: agrupar("cor_nome"),
        porMercadoria: agrupar("mercadoria_nome"),
        porOperador: Object.entries(porOperador).map(([nome, pecas]) => ({ nome, pecas }))
          .sort((a, b) => b.pecas - a.pecas),
      });
    }

    if (req.method === "PUT") {
      const corpo = (await lerCorpo(req)) || {};
      const campos = {};
      for (const c of ["descricao", "quantidade_prevista", "entrada_em", "situacao", "nota", "observacao"]) {
        if (!(c in corpo)) continue;
        if (c === "quantidade_prevista") {
          const s = String(corpo[c] ?? "").replace(/\D/g, "");
          campos[c] = s === "" ? null : Number(s);
        } else if (c === "observacao") campos[c] = sanitizarHtml(String(corpo[c] || ""));
        else if (c === "entrada_em") campos[c] = corpo[c] || null;
        else campos[c] = String(corpo[c] ?? "").trim();
      }
      if (campos.situacao && !["aberto", "fechado", "faturado"].includes(campos.situacao))
        return responder(res, 400, { error: "situação inválida" });
      /* Faturar sem número da nota deixa o lote "faturado" sem como achar a
         nota depois — que é justamente o que se vai procurar meses adiante. */
      if (campos.situacao === "faturado" && !(campos.nota || lote.nota))
        return responder(res, 400, { error: "informe o número da nota antes de marcar como faturado" });
      const cols = Object.keys(campos);
      if (!cols.length) return responder(res, 400, { error: "nada para alterar" });
      await Q.run(`UPDATE lotes SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        ...cols.map((c) => campos[c]), id);
      return responder(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      if (lote.situacao === "faturado")
        return responder(res, 409, { error: "lote já faturado — não pode ser apagado" });
      /* As fichas NÃO vão junto: elas são a produção que aconteceu. Só perdem
         o vínculo e voltam para a lista de soltas, prontas para outro lote. */
      await Q.tx(async () => {
        await Q.run("UPDATE fichas SET lote_id = NULL WHERE lote_id = ?", id);
        await Q.run("DELETE FROM lotes WHERE id = ?", id);
      });
      return responder(res, 200, { ok: true });
    }
  }

  /* ------------------------------------------------------- usuários ----- */
  if (caminho === "/restrito/api/usuarios" && req.method === "GET") {
    const itens = await Q.all(
      "SELECT id, usuario, nome, papel, ativo, criado_em FROM usuarios ORDER BY nome, usuario");
    return responder(res, 200, { itens });
  }
  const mUsuario = /^\/restrito\/api\/usuarios\/(\d+)$/.exec(caminho);
  if (mUsuario && req.method === "PUT") {
    const id = Number(mUsuario[1]);
    const corpo = (await lerCorpo(req)) || {};
    const campos = {};
    if ("papel" in corpo) {
      if (!["admin", "operador"].includes(corpo.papel)) return responder(res, 400, { error: "papel inválido" });
      campos.papel = corpo.papel;
    }
    if ("ativo" in corpo) campos.ativo = !!corpo.ativo;
    if ("nome" in corpo) campos.nome = String(corpo.nome || "").trim();
    if (!Object.keys(campos).length) return responder(res, 400, { error: "nada para alterar" });

    /* Não deixa o último administrador se rebaixar nem se desativar: o sistema
       ficaria sem ninguém capaz de mexer nos cadastros, e a saída seria mexer
       no banco à mão. */
    if ((campos.papel === "operador" || campos.ativo === false)) {
      const outros = await Q.get(
        "SELECT COUNT(*) c FROM usuarios WHERE papel = 'admin' AND ativo AND id <> ?", id);
      const alvo = await Q.get("SELECT papel, ativo FROM usuarios WHERE id = ?", id);
      if (alvo && alvo.papel === "admin" && alvo.ativo && Number(outros.c) === 0)
        return responder(res, 409, { error: "este é o último administrador ativo — promova outro antes." });
    }
    const cols = Object.keys(campos);
    await Q.run(`UPDATE usuarios SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
      ...cols.map((c) => campos[c]), id);
    return responder(res, 200, { ok: true });
  }

  /* ---------------------------------------------------- QR da máquina --- */
  const mQrNovo = /^\/restrito\/api\/maquinas\/(\d+)\/qr\/trocar$/.exec(caminho);
  if (mQrNovo && req.method === "POST") {
    const token = crypto.randomBytes(9).toString("base64url");
    await Q.run("UPDATE maquinas SET token = ? WHERE id = ?", token, Number(mQrNovo[1]));
    /* Trocar o token só invalida adesivos antigos — não expulsa ninguém, porque
       o token nunca autenticou. Serve para quando um adesivo se perde ou a
       máquina muda de lugar. */
    return responder(res, 200, { ok: true, token });
  }

  /* A folha de etiquetas: uma página feita para SAIR NA IMPRESSORA e ser
     recortada e colada nas máquinas. Não é tela de consulta — por isso vem
     pronta do servidor em vez de ser montada na SPA. */
  if (caminho === "/restrito/etiquetas" && req.method === "GET") {
    /* `?maquina=<id>` imprime uma só — para quando entra máquina nova ou um
       adesivo é trocado, sem gastar a folha inteira. */
    const so = Number(new URL(req.url, "http://localhost").searchParams.get("maquina")) || null;
    const maquinas = so
      ? await Q.all("SELECT id, nome, token, cabecas FROM maquinas WHERE id = ?", so)
      : await Q.all("SELECT id, nome, token, cabecas FROM maquinas WHERE ativo ORDER BY nome");
    const html = await folhaDeEtiquetas(maquinas, enderecoBase(req));
    return responder(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
  }

  return responder(res, 404, { error: "rota não encontrada" });
}

module.exports = {
  rotas, sessaoDe, gerarHash, conferirSenha, prepararCadastro,
  CADASTROS,
};
