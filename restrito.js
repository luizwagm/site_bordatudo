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
const fs = require("node:fs");
const path = require("node:path");
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
   1b. QUEM PODE O QUÊ — e a conta de DONO

   Três papéis: `operador` (a máquina), `admin` (o escritório) e `dono` (a
   manutenção do sistema). O dono existe para consertar o que o admin não
   alcança, e por isso não aparece na lista de usuários nem é criado, alterado
   ou apagado por tela nenhuma — só pelo terminal do servidor. Só pode haver
   um, e quem garante isso é um índice único no banco, não esta linha aqui.

   `ehAdmin` É A ÚNICA PORTA. Antes destes ajustes o código comparava
   `sessao.papel !== "admin"` em oito lugares. Cada uma dessas comparações que
   sobrevivesse trancaria o dono para fora exatamente da tela que ele foi feito
   para consertar — e o sintoma seria "a conta de manutenção não tem
   permissão", que é o contrário do que se espera de uma conta com poder sobre
   tudo. Por isso nenhuma comparação literal de papel deve voltar ao arquivo.
   ========================================================================== */
const ehAdmin = (sessao) => !!sessao && (sessao.papel === "admin" || sessao.papel === "dono");
const ehDono = (sessao) => !!sessao && sessao.papel === "dono";

/* No escopo do módulo, e não dentro de `rotas`: a rota de trocar a própria
   senha usa esta frase e roda ANTES do bloco de usuários. Um `const` declarado
   lá embaixo estaria na zona morta temporal aqui em cima — e o sintoma seria a
   troca de senha estourar ReferenceError em vez de recusar com educação. */
const SO_TERMINAL = "a senha desta conta só é trocada pelo terminal do servidor";

/* ==========================================================================
   1c. TEMPO REAL — Server-Sent Events

   O problema: o Eduardo cadastra um desenho no escritório e o operador na
   máquina continua com a lista velha até apertar F5. Ele não vai apertar F5,
   e vai reclamar que o desenho "não foi salvo".

   POR QUE SSE E NÃO WEBSOCKET
   O tráfego é de mão única — servidor avisa, navegador ouve. Tudo que o
   navegador manda já vai por POST, que funciona, tem sessão e tem limitador. O
   WebSocket traria um canal de volta que ninguém usaria, e com ele: `Upgrade`
   no nginx, ping/pong na mão, reconexão na mão e um protocolo a mais para
   depurar quando algo parasse. O `EventSource` do navegador é nativo, RECONECTA
   SOZINHO quando a rede da fábrica oscila, e atravessa qualquer proxy porque é
   HTTP comum que não termina.

   O QUE VAI NO EVENTO: SÓ O ASSUNTO. Nunca o dado.

   Isso não é economia — são duas coisas ao mesmo tempo:

   1. Custo. Dez máquinas ligadas o dia inteiro recebem algumas dezenas de
      bytes por cadastro salvo. Empurrar a linha inteira multiplicaria o
      tamanho por dez a cada tecla salva, e a tela que não está aberta pagaria
      igual.

   2. SEGREDO. O desenho agora tem PREÇO, e o operador não pode ver preço. Se
      o evento carregasse a linha do desenho, o preço chegaria a todos os
      navegadores da fábrica — inclusive aos que a API se dá ao trabalho de
      filtrar. Mandando só "desenhos mudou", cada tela vai buscar pela rota
      normal e recebe o que o PAPEL dela permite. A regra de quem vê o quê
      continua num lugar só.

   LIMITE CONHECIDO: o aviso vive na memória DESTE processo. Um dia que o
   sistema rode em dois processos, cada um avisaria só os seus — e a correção
   seria o `LISTEN/NOTIFY` do próprio PostgreSQL, não um servidor a mais.
   ========================================================================== */
const ouvintes = new Set();       // { res, papel }

/* Teto da LISTA de produção. Ninguém lê dez mil linhas numa tela, e mandá-las
   pelo fio custa caro do lado do celular preso na máquina. Os TOTAIS não têm
   teto — são contados pelo banco sobre o filtro inteiro — e a resposta avisa
   quando a lista foi cortada, para a tela dizer isso em vez de deixar parecer
   que aquilo é tudo o que existe. */
/* ==========================================================================
   PAGINAÇÃO — o mesmo recorte para todas as listas do servidor

   Teto no `por` (quantas linhas por página) para uma requisição não poder
   pedir a tabela inteira e derrubar o servidor de propósito ou por engano.
   Vem do ambiente para a suíte poder baixá-lo e provar a paginação com quatro
   registros em vez de quinhentos e um: um limite que só se alcança com meio
   milhar de linhas é um limite que nunca seria testado.

   A CONTA DO TOTAL É SEMPRE SOBRE O FILTRO INTEIRO, nunca sobre a página.
   Sem isso a barra diria "página 1 de 1" com mais oito páginas de produção
   escondidas atrás — e o número grande no alto da tela, que é o que vai para
   a nota, mostraria só o que coube na tela.
   ========================================================================== */
const TETO_POR_PAGINA = Number(process.env.TETO_POR_PAGINA) || 500;

/* Lê `?pagina=` e `?por=` com os limites aplicados. `pagina` nunca é menor
   que 1: um `?pagina=0` viraria OFFSET negativo, que o Postgres recusa. */
function recorteDaPagina(url, padraoPor) {
  /* Piso 1, e não 5: `por=2` é pedido legítimo, e o `||` logo acima já trata
     texto e zero (viram o padrão). O piso serve só contra número negativo, que
     produziria LIMIT inválido. */
  const por = Math.min(TETO_POR_PAGINA, Math.max(1, Number(url.searchParams.get("por")) || padraoPor || 20));
  const pagina = Math.max(1, Number(url.searchParams.get("pagina")) || 1);
  return { por, pagina, offset: (pagina - 1) * por };
}

/* O envelope que a barra de paginação da tela espera. Um só formato para
   todas as listas — duas formas diferentes fariam a barra ter dois caminhos,
   e o que ficasse para trás mostraria "página 3 de 2". */
function envelope(total, r) {
  return { total, pagina: r.pagina, porPagina: r.por, paginas: Math.max(1, Math.ceil(total / r.por)) };
}

function assinarEventos(req, res, sessao) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    /* O nginx guarda resposta em buffer por padrão e seguraria os avisos até
       encher o buffer — que num fluxo de 30 bytes por evento nunca enche. Sem
       este cabeçalho o tempo real chega em lotes de minutos, e o sintoma é
       "às vezes funciona". */
    "X-Accel-Buffering": "no",
  });
  /* O `retry` diz ao navegador quanto esperar para reconectar. Três segundos:
     rápido o bastante para o operador não perceber a queda, lento o bastante
     para uma reinicialização do serviço não gerar uma enxurrada de conexões. */
  res.write("retry: 3000\n\n");

  const ouvinte = { res, papel: sessao.papel };
  ouvintes.add(ouvinte);
  req.on("close", () => ouvintes.delete(ouvinte));
  return true;
}

/* Batimento. Uma conexão parada é fechada por proxies e por NAT de roteador
   depois de alguns minutos de silêncio — e o `EventSource` só reconecta quando
   percebe que caiu. O comentário (`:`) é ignorado pelo padrão: serve só para
   haver tráfego. */
setInterval(() => {
  for (const o of ouvintes) { try { o.res.write(": ok\n\n"); } catch { ouvintes.delete(o); } }
}, 25e3).unref();

/* Avisa todo mundo que um assunto mudou. Nunca recebe o dado — ver acima. */
function avisar(assunto) {
  const linha = `event: mudou\ndata: ${JSON.stringify({ o: assunto })}\n\n`;
  for (const o of ouvintes) {
    try { o.res.write(linha); } catch { ouvintes.delete(o); }
  }
}

/* ==========================================================================
   2. SENHA — scrypt com salt individual

   SHA-256 é rápido de propósito: uma GPU testa bilhões por segundo, e um banco
   vazado entrega as senhas em minutos. O scrypt é lento de propósito e exige
   memória por tentativa, o que inviabiliza o ataque em escala.
   ========================================================================== */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/* SEIS DÍGITOS. É senha de uso único: serve para abrir a porta UMA VEZ, e o
   sistema não deixa a pessoa fazer mais nada antes de trocá-la.

   Seis dígitos são 1 milhão de combinações — pouco para uma senha permanente,
   e é por isso que ela não é permanente. Para o que ela É, número puro ganha
   de qualquer coisa: dita-se por telefone sem soletrar, digita-se no teclado
   numérico do celular preso na máquina, e não tem letra que se confunda.

   A trava de tentativas (5 erros por IP em 15 min) é o que impede alguém de
   varrer o milhão de combinações enquanto a senha está viva.

   Mora aqui, e não no `criar-usuario.cjs`, porque o painel também gera senha.
   Duas cópias divergiriam, e a do painel é a que vai ser usada todo dia. */
function senhaProvisoria() {
  /* `randomInt` e não `Math.random()`: a segunda é previsível a partir de umas
     poucas saídas, e aqui isso significaria adivinhar a senha do próximo. */
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/* O que a pessoa escolhe no lugar da provisória. Regras curtas de propósito:
   quem digita isto está de pé, na máquina. Barrar senha fraca demais é
   necessário; exigir maiúscula, símbolo e número faz a pessoa anotar no papel
   colado na máquina — que é pior do que a senha simples. */
function conferirSenhaNova(nova, provisoria) {
  const s = String(nova || "");
  if (s.length < 6) return "a senha nova precisa de pelo menos 6 caracteres";
  if (provisoria && s === String(provisoria)) return "escolha uma senha diferente da provisória";
  if (/^(.)\1+$/.test(s)) return "não vale repetir o mesmo caractere";

  /* Sequência direta ou invertida — 123456 e 654321 são as duas primeiras que
     qualquer um tenta, e as duas primeiras que qualquer um escolhe. */
  const seq = "01234567890";
  const abc = "abcdefghijklmnopqrstuvwxyz";
  const baixo = s.toLowerCase();
  const invertido = baixo.split("").reverse().join("");
  if (seq.includes(baixo) || seq.includes(invertido) || abc.includes(baixo) || abc.includes(invertido))
    return "essa sequência é fácil demais — escolha outra";
  return null;
}

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
   3c. FOTOS DO DESENHO

   Ficam em `data/desenhos/`, que já está fora do git e fora de `assets/`.
   O desenho é o produto do cliente: em `assets/` bastaria acertar o nome do
   arquivo para baixar o bordado de qualquer um, sem estar logado.

   Chegam em base64 dentro do JSON, como no painel do site. Multipart exigiria
   um analisador próprio ou uma dependência; base64 custa 33% a mais de tráfego
   e elimina uma superfície inteira de erros de parsing.
   ========================================================================== */
const PASTA_FOTOS = path.join(__dirname, "data", "desenhos");

/* A EXTENSÃO SAI DA ASSINATURA, NÃO DO NOME.

   Antes o nome do arquivo mandava, e isso tinha duas consequências. A pequena:
   IMAGEM COLADA NÃO TEM NOME. O que vem da área de transferência é um blob sem
   nome nenhum, e exigir `.png` obrigaria a tela a inventar um — inventar dado
   para satisfazer uma validação é sinal de que a validação está olhando para o
   lugar errado.

   A que importa: a assinatura JÁ ERA conferida logo abaixo, então o formato
   verdadeiro sempre foi conhecido. Deixar a extensão vir do nome permitia
   gravar um JPEG chamado `.png` — e a rota que serve a foto escolhe o
   `Content-Type` pela extensão. O arquivo era servido como o que ele não é.
   Navegador nenhum reclama disso hoje, e é justamente por isso que ninguém
   descobriria. */
const ASSINATURAS = [
  { ext: ".jpg",  bate: (c) => c[0] === 0xff && c[1] === 0xd8 },
  { ext: ".png",  bate: (c) => c.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".webp", bate: (c) => c.subarray(0, 4).toString() === "RIFF" && c.subarray(8, 12).toString() === "WEBP" },
  { ext: ".avif", bate: (c) => c.subarray(4, 8).toString() === "ftyp" },
];

function gravarFoto(nome, dados) {
  if (!dados) throw new Error("sem arquivo");

  const conteudo = Buffer.from(String(dados).replace(/^data:[^,]+,/, ""), "base64");
  if (!conteudo.length) throw new Error("arquivo vazio");
  if (conteudo.length > 9e6) throw new Error("imagem acima de 9 MB");

  const cabeca = conteudo.subarray(0, 12);
  const tipo = ASSINATURAS.find((a) => a.bate(cabeca));
  /* Um `.png` que na verdade é HTML seria servido como imagem — e basta um
     navegador mais velho resolver adivinhar o tipo para virar script rodando
     no domínio. */
  if (!tipo) throw new Error("isso não é uma imagem — use jpg, png, webp ou avif");

  /* A parte legível do nome, quando existe, só serve para a pessoa reconhecer
     o arquivo no disco. É RECONSTRUÍDA, não higienizada: limpar o que veio do
     cliente é jogo de gato e rato com `..`, barra, dois-pontos, nome reservado
     do Windows e caractere invisível. Aqui só o que é letra e número sobrevive,
     e a imagem colada — sem nome — cai no padrão "colado". */
  const semExt = String(nome || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const bruto = semExt
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
    || (nome ? "desenho" : "colado");

  const arquivo = `${bruto}-${crypto.randomBytes(5).toString("hex")}${tipo.ext}`;
  fs.mkdirSync(PASTA_FOTOS, { recursive: true });
  fs.writeFileSync(path.join(PASTA_FOTOS, arquivo), conteudo);
  return arquivo;
}

/* ==========================================================================
   3d. RECIBO DO LOTE

   Sai do SERVIDOR já pronto, e não montado na tela, por três motivos:

   · é papel que o cliente leva embora — precisa ser o que está no banco no
     momento da impressão, não o que estava na tela desde manhã;
   · `@page` (tamanho e orientação do papel) só existe em folha de estilo;
     não dá para escolher retrato ou paisagem sem gerar a página;
   · abre em aba própria, então o "imprimir" do navegador imprime o recibo e
     não o sistema inteiro em volta.
   ========================================================================== */
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const N_BR = new Intl.NumberFormat("pt-BR");
const nBr = (v) => N_BR.format(Number(v || 0));

/* Dinheiro no papel. `preco_unitario` e `total_valor` são NUMERIC(12,2) e
   chegam do Postgres como TEXTO ("12.50") — o driver não converte, de propósito,
   para não perder precisão em ponto flutuante. Por isso o Number() explícito.

   Valor ausente vira travessão, e não "R$ 0,00": desenho sem preço cadastrado
   é diferente de desenho de graça, e num recibo assinado essa diferença é a
   distância entre "ainda não precificamos" e "não vamos cobrar". */
const RS_BR = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2,
});
const rsBr = (v) =>
  (v === null || v === undefined || v === "") ? "—" : RS_BR.format(Number(v));

function dataBr(d) {
  if (!d) return "—";
  const x = new Date(d);
  return x.toLocaleDateString("pt-BR") + " " + x.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function soData(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pt-BR");
}

/* AAAA-MM-DD de uma data, para COMPARAR — nunca para mostrar.
   Uma coluna DATE volta do Postgres como objeto Date, e `String(data)` dá
   "Wed Jan 01 2020": cortar dez caracteres disso produz "Wed Jan 01", que numa
   comparação de texto é MAIOR que "2026-08-13" e faz toda nota vencida parecer
   em dia. O erro é silencioso, porque a mesma expressão funciona quando o valor
   já chega como texto.
   Os componentes são LOCAIS, e não `toISOString()`, porque o driver monta a
   data na meia-noite local: num servidor a leste de Greenwich o ISO devolveria
   o dia anterior. */
function emIso(d) {
  if (!d) return "";
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return "";
  return x.getFullYear() + "-" +
    String(x.getMonth() + 1).padStart(2, "0") + "-" +
    String(x.getDate()).padStart(2, "0");
}
const hojeIso = () => emIso(new Date());

/* O detalhe do lote é montado UMA vez e serve à tela e ao recibo. Se cada um
   somasse por conta própria, o papel que o cliente leva embora poderia
   discordar da tela em que a nota foi conferida — e não haveria como saber
   qual dos dois estava certo. */
async function detalheDoLote(lote) {
  const fichas = await Q.all(
    `SELECT f.*, u.nome AS operador_nome, d.nome AS desenho_nome,
            me.nome AS mercadoria_nome, co.nome AS cor_nome
       FROM fichas f
       JOIN usuarios u ON u.id = f.usuario_id
       JOIN desenhos d ON d.id = f.desenho_id
       LEFT JOIN mercadorias me ON me.id = f.mercadoria_id
       LEFT JOIN cores co ON co.id = f.cor_id
      WHERE f.lote_id = ? AND f.situacao = 'fechada'
      ORDER BY f.fechada_em`, lote.id);

  const pecas = fichas.reduce((a, f) => a + Number(f.quantidade || 0), 0);
  const pontos = fichas.reduce((a, f) => a + Number(f.total_pontos || 0), 0);
  /* O valor sai das fichas, como tudo neste lote. Cada `total_valor` é coluna
     gerada pelo banco (quantidade × preço da abertura), então este total não
     tem como divergir do que a composição mostra linha a linha. */
  const valor = fichas.reduce((a, f) => a + Number(f.total_valor || 0), 0);

  /* Quebra por COR e por MERCADORIA — é para isso que a cor é campo próprio.
     "1500 abas" fecha somando 100 pretas + 500 brancas + …, e sem a quebra não
     dá para saber o que ainda falta. */
  const agrupar = (chave) => {
    const m = {};
    for (const f of fichas) {
      const k = f[chave] || "(não informado)";
      if (!m[k]) m[k] = { pecas: 0, pontos: 0, valor: 0 };
      m[k].pecas += Number(f.quantidade || 0);
      /* Pontos e valor viajam junto com as peças. A quebra por desenho sem os
         pontos não responde a pergunta que ela existe para responder — dois
         desenhos com a mesma quantidade de peças podem ter custado trabalho
         muito diferente, e é o ponto que mede isso. */
      m[k].pontos += Number(f.total_pontos || 0);
      m[k].valor += Number(f.total_valor || 0);
    }
    return Object.entries(m)
      .map(([nome, v]) => ({ nome, pecas: v.pecas, pontos: v.pontos, valor: v.valor }))
      .sort((a, b) => b.pecas - a.pecas);
  };

  return {
    lote, fichas, pecas, pontos, valor,
    falta: lote.quantidade_prevista === null ? null : Number(lote.quantidade_prevista) - pecas,
    porCor: agrupar("cor_nome"),
    porMercadoria: agrupar("mercadoria_nome"),
    porOperador: agrupar("operador_nome"),
    porDesenho: agrupar("desenho_nome"),
  };
}

function reciboDoLote(dados, empresa, opcoes) {
  /* `pontos`, `porCor` e `porOperador` vêm no `dados` e NÃO são desestruturados
     aqui de propósito: eles alimentam a tela do lote, não este papel. Deixá-los
     no escopo do recibo seria o convite para alguém reimprimi-los sem perceber
     que o cliente não deve vê-los. */
  const { lote, fichas, pecas, valor, porMercadoria, porDesenho, cliente } = dados;
  const paisagem = opcoes.orientacao === "paisagem";
  const prev = lote.quantidade_prevista == null ? null : Number(lote.quantidade_prevista);
  const falta = prev == null ? null : prev - pecas;

  const quebra = (titulo, itens) => !itens.length ? "" : `
    <div class="quebra">
      <h3>${escH(titulo)}</h3>
      <table class="mini">
        <tbody>
        ${itens.map((i) => `<tr><td>${escH(i.nome)}</td><td class="n">${nBr(i.pecas)}</td></tr>`).join("")}
      </tbody></table>
    </div>`;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(lote.codigo)} — recibo de produção</title>
<style>
  /* A ORIENTAÇÃO é o motivo de esta página ser gerada e não estática:
     a regra @page não aceita variável de CSS nem troca por classe. */
  @page { size: A4 ${paisagem ? "landscape" : "portrait"}; margin: ${paisagem ? "12mm 14mm" : "16mm 15mm"}; }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #16161c; background: #eceaea; padding: 22px 14px 60px;
  }
  .folha {
    position: relative; overflow: hidden;
    width: ${paisagem ? "297mm" : "210mm"}; min-height: ${paisagem ? "210mm" : "297mm"};
    margin: 0 auto; padding: ${paisagem ? "12mm 14mm" : "16mm 15mm"};
    background: #fff; box-shadow: 0 6px 26px rgb(13 18 64 / .16);
    /* Na TELA a folha encolhe para caber num notebook; na impressora o
       @media print devolve o tamanho real. Sem isto, a paisagem obrigava a
       rolar para o lado só para conferir o recibo antes de mandar imprimir. */
    max-width: 100%;
  }

  /* MARCA D'ÁGUA — atrás de tudo, e com print-color-adjust: exact porque o
     navegador remove fundo na impressão por padrão e ela sumiria justamente
     no papel, que é onde ela serve para alguma coisa. */
  .agua {
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .agua span {
    font: 800 ${paisagem ? "116px" : "92px"}/1 ui-sans-serif, system-ui, sans-serif;
    letter-spacing: .06em; color: #1e275f; opacity: .055;
    transform: rotate(-32deg); white-space: nowrap; text-transform: uppercase;
  }
  .conteudo { position: relative; z-index: 1; }

  /* ------------------------------------------------------------ cabeçalho */
  .cabeca { display: flex; gap: 16px; align-items: flex-start;
    padding-bottom: 10px; border-bottom: 2.5px solid #1e275f; }
  .cabeca__marca { flex: 1; min-width: 0; }
  .cabeca__marca b { display: block; font-size: 19px; letter-spacing: -.01em; color: #1e275f; }
  .cabeca__marca span { display: block; font-size: 11.5px; color: #55555f; }
  .cabeca__doc { text-align: right; white-space: nowrap; }
  .cabeca__doc b { display: block; font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #c03b0c; }
  .cabeca__doc .cod { font: 800 22px ui-monospace, Consolas, monospace; letter-spacing: .02em; }
  .cabeca__doc .em { font-size: 11px; color: #55555f; }

  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .1em;
    color: #55555f; margin: 16px 0 6px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: #55555f; margin: 0 0 5px; }

  .campos { display: grid; grid-template-columns: repeat(${paisagem ? 4 : 3}, 1fr); gap: 8px 16px; }
  .campo b { display: block; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .06em; color: #77778a; }
  .campo span { display: block; font-size: 13px; }

  table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  th, td { padding: 5px 7px; text-align: left; border-bottom: 1px solid #e2e2ea; }
  th { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em;
    color: #55555f; background: #f2f2f6; border-bottom: 1.5px solid #c6c6d2;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.n, th.n { text-align: right; font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  tfoot td { font-weight: 800; border-top: 1.5px solid #1e275f; border-bottom: 0; }

  /* ATENÇÃO: este CSS mora dentro de um template literal — CRASE AQUI FECHA A
     STRING e o arquivo inteiro deixa de compilar. Comentário sem crase.
     auto-fit e não um número fixo de colunas: a composição tem duas caixas
     hoje e podia ter quatro amanhã, e uma grade de 3 com 2 caixas deixa um
     terço da folha em branco no meio do papel. O minmax também impede que uma
     caixa só estique de margem a margem. */
  /* Teto de largura por card. Com "1fr" e um card só — que é o caso desde que
     a quebra por mercadoria saiu — a caixa esticava pelos 21cm da folha, e a
     lista de desenhos ficava com o nome à esquerda e o número lá no outro
     canto, ilegível. O teto mantém a leitura curta e continua acomodando mais
     de um card lado a lado se um dia voltarem. */
  .quebras { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 300px));
    gap: 14px; align-items: start; justify-content: start; }
  .quebra { border: 1px solid #e2e2ea; border-radius: 3px; padding: 8px 10px; break-inside: avoid; }
  table.mini td { padding: 3px 0; border-bottom: 1px dotted #e2e2ea; font-size: 11.5px; }
  table.mini tr:last-child td { border-bottom: 0; }

  /* Sobrou uma caixa só. Com flex:1 ela esticaria de ponta a ponta da folha, e
     um número de dois dígitos perdido no meio de uma faixa azul-marinho
     inteira lê-se como cabeçalho, não como total. Largura pelo conteúdo. */
  .totais { display: flex; gap: 10px; margin-top: 12px; break-inside: avoid; }
  .total { min-width: 150px; border: 1.5px solid #1e275f; border-radius: 3px;
    padding: 8px 16px; text-align: center; }
  .total b { display: block; font: 800 20px ui-monospace, Consolas, monospace; color: #1e275f; }
  .total span { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #55555f; }
  .total--destaque { background: #1e275f; color: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .total--destaque b, .total--destaque span { color: #fff; }

  /* ----------------------------------------------------------- assinatura */
  /* break-inside: avoid no bloco inteiro: assinatura partida entre duas
     folhas é assinatura que não vale. */
  .assinaturas { margin-top: ${paisagem ? "16mm" : "22mm"}; break-inside: avoid; }
  .declaro { font-size: 11.5px; color: #33333d; margin-bottom: ${paisagem ? "12mm" : "16mm"};
    max-width: 118ch; }
  .linhas { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .linha { text-align: center; }
  .linha .risco { border-top: 1px solid #16161c; margin-bottom: 4px; }
  .linha b { display: block; font-size: 12px; }
  .linha span { display: block; font-size: 10.5px; color: #55555f; }

  .pe { margin-top: 12mm; padding-top: 6px; border-top: 1px solid #e2e2ea;
    display: flex; justify-content: space-between; gap: 12px;
    font-size: 9.5px; color: #77778a; }

  /* ------------------------------------------------------------- controles */
  .controles {
    position: fixed; top: 0; left: 0; right: 0; z-index: 9;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 9px 14px; background: #1e275f; color: #fff;
  }
  .controles a, .controles button {
    padding: 7px 13px; border: 1px solid rgb(255 255 255 / .3); border-radius: 3px;
    background: transparent; color: #fff; font: inherit; font-size: 13px; font-weight: 600;
    text-decoration: none; cursor: pointer;
  }
  .controles a:hover, .controles button:hover { background: rgb(255 255 255 / .14); }
  .controles .agora { background: #c03b0c; border-color: #c03b0c; }
  .controles .espaco { flex: 1; }
  .controles .dica { font-size: 12px; opacity: .75; }
  body { padding-top: 60px; }

  @media print {
    body { background: #fff; padding: 0; }
    .folha { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .controles { display: none; }
    /* A marca d'água acompanha a folha impressa, não a tela. */
    .agua { position: fixed; }
  }
</style></head><body>

<div class="controles">
  <button class="agora" onclick="print()">Imprimir</button>
  <a href="?orientacao=retrato">Retrato</a>
  <a href="?orientacao=paisagem">Paisagem</a>
  <span class="espaco"></span>
  <span class="dica">Orientação atual: <b>${paisagem ? "paisagem" : "retrato"}</b> — escolha a mesma na janela de impressão.</span>
</div>

<div class="folha">
  <div class="agua"><span>${escH(empresa.curto || empresa.nome)}</span></div>
  <div class="conteudo">

    <div class="cabeca">
      <div class="cabeca__marca">
        <b>${escH(empresa.nome)}</b>
        <span>${empresa.cnpj ? "CNPJ " + escH(empresa.cnpj) + " · " : ""}${escH(empresa.endereco)}</span>
        <span>${[empresa.telefone && "Tel. " + empresa.telefone, empresa.email].filter(Boolean).map(escH).join(" · ")}</span>
      </div>
      <div class="cabeca__doc">
        <b>Recibo de produção</b>
        <div class="cod">${escH(lote.codigo)}</div>
        <div class="em">emitido em ${dataBr(opcoes.agora)}</div>
      </div>
    </div>

    <h2>Cliente</h2>
    <div class="campos">
      <div class="campo"><b>Nome</b><span>${escH(lote.cliente_nome)}</span></div>
      <div class="campo"><b>CNPJ / CPF</b><span>${escH((cliente && cliente.documento) || "—")}</span></div>
      <div class="campo"><b>Telefone</b><span>${escH((cliente && cliente.telefone) || "—")}</span></div>
      <div class="campo"><b>Cidade</b><span>${escH((cliente && cliente.cidade) || "—")}</span></div>
    </div>

    <h2>Lote</h2>
    <div class="campos">
      <div class="campo"><b>Serviço</b><span>${escH(lote.descricao || "—")}</span></div>
      <div class="campo"><b>Entrada da mercadoria</b><span>${soData(lote.entrada_em)}</span></div>
      <div class="campo"><b>Combinado</b><span>${prev == null ? "—" : nBr(prev) + " peças"}</span></div>
      <div class="campo"><b>Situação</b><span>${escH(lote.situacao)}</span></div>
      <div class="campo"><b>Nota fiscal</b><span>${escH(lote.nota || "—")}</span></div>
      <div class="campo"><b>${falta != null && falta < 0 ? "Excedente" : "Falta"}</b><span>${
        falta == null ? "—" : nBr(Math.abs(falta)) + " peças"}</span></div>
    </div>

    <!-- A TABELA É A CONTA, NÃO O RELATÓRIO.
         Saíram operador, cor e os dois campos de ponto; entraram valor unitário
         e valor total. O motivo é o que o cliente faz com este papel: ele
         confere o que vai pagar, linha a linha. Operador, cor e ponto não mudam
         o valor de nada — respondem "como foi produzido", que é pergunta da
         fábrica e está inteira na tela do lote. -->
    <h2>Produção — ${fichas.length} ficha${fichas.length === 1 ? "" : "s"}</h2>
    <table>
      <!-- A ORDEM DAS TRÊS COLUNAS DE NÚMERO É A DA CONTA:
           peças × valor unitário = valor total. Lida da esquerda para a
           direita, a linha se confere sozinha com a calculadora na mão — que é
           exatamente o que o cliente faz com este papel. Com o unitário na
           frente, ele precisa pular para trás para achar a quantidade. -->
      <thead><tr>
        <th>Data</th><th>Desenho</th><th>Mercadoria</th>
        <th class="n">Peças</th><th class="n">Valor unitário</th><th class="n">Valor total</th>
      </tr></thead>
      <tbody>${fichas.map((f) => `<tr>
        <td>${soData(f.fechada_em)}</td>
        <td>${escH(f.desenho_nome)}</td>
        <td>${escH(f.mercadoria_nome || "—")}</td>
        <td class="n">${nBr(f.quantidade)}</td>
        <td class="n">${rsBr(f.preco_unitario)}</td>
        <td class="n">${rsBr(f.total_valor)}</td>
      </tr>`).join("") || '<tr><td colspan="6">Nenhuma ficha neste lote.</td></tr>'}</tbody>
      <!-- O rodapé NÃO soma a coluna do unitário: somar preço por peça de
           desenhos diferentes dá um número que não significa nada. -->
      <tfoot><tr><td colspan="3">Total</td>
        <td class="n">${nBr(pecas)}</td>
        <td class="n"></td>
        <td class="n">${valor ? rsBr(valor) : "—"}</td></tr></tfoot>
    </table>

    <!-- O RECIBO É DO CLIENTE, NÃO DA FÁBRICA.
         Ponto, cor e operador saíram daqui: são as medidas de COMO o serviço
         foi feito — quanto trabalho deu, quem bordou, em que linha. O cliente
         confere o que recebeu e o que vai pagar, e nada disso muda o valor de
         nada. Continuam inteiros na tela do lote, que é onde a fábrica olha. -->
    <div class="totais">
      <div class="total total--destaque"><b>${nBr(pecas)}</b><span>peças produzidas</span></div>
    </div>

    <!-- SÓ A QUEBRA POR DESENHO.
         O card por mercadoria saiu: a mercadoria já aparece linha a linha na
         tabela acima, e repeti-la agrupada não responde nenhuma pergunta que o
         cliente faça com o papel na mão. Ele quer conferir quanto de cada
         desenho recebeu — é por desenho que o preço muda. A quebra por
         mercadoria continua inteira na tela do lote, que é onde a fábrica
         olha para separar a entrega. -->
    <h2>Composição</h2>
    <div class="quebras">
      ${quebra("Peças por desenho", porDesenho)}
    </div>

    <div class="assinaturas">
      <p class="declaro">Declaro que recebi as peças relacionadas neste recibo, no total de
      <b>${nBr(pecas)} peça${pecas === 1 ? "" : "s"}</b>, conferidas e nas condições descritas acima.</p>
      <div class="linhas">
        <div class="linha">
          <div class="risco"></div>
          <b>${escH(empresa.nome)}</b>
          <span>${empresa.cnpj ? "CNPJ " + escH(empresa.cnpj) : "quem entregou"}</span>
        </div>
        <div class="linha">
          <div class="risco"></div>
          <b>${escH(lote.cliente_nome)}</b>
          <span>${(cliente && cliente.documento) ? escH(cliente.documento) : "nome legível, documento e data"}</span>
        </div>
      </div>
    </div>

    <div class="pe">
      <span>${escH(lote.codigo)} · emitido por ${escH(opcoes.porQuem)} em ${dataBr(opcoes.agora)}</span>
      <span>${escH(empresa.curto || empresa.nome)}${empresa.versao ? " · sistema v" + escH(empresa.versao) : ""}</span>
    </div>

  </div>
</div>
</body></html>`;
}

/* ==========================================================================
   RECIBO DE PAGAMENTO

   Papel pequeno, uma coisa só: "recebemos X, ainda faltam Y". A folha é A5
   porque um recibo de meia página gasta metade do papel e cabe na mão — o
   recibo de produção é A4 porque lá há uma tabela para conferir.

   O SALDO IMPRESSO É O DAQUELE MOMENTO. Uma reimpressão feita mês que vem tem
   de dizer exatamente o mesmo que o papel que o cliente guardou; se mostrasse
   o saldo de hoje, os dois discordariam e não haveria como saber qual vale.
   ========================================================================== */
function reciboDePagamento(dados, empresa, opcoes) {
  const { lancamento: l, nota, conta, pagoAte, faltavaDepois } = dados;
  const ehDevolucao = l.tipo === "saida";
  const FORMAS = {
    pix: "PIX", dinheiro: "Dinheiro", cartao: "Cartão", boleto: "Boleto",
    transferencia: "Transferência", cheque: "Cheque",
  };

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(l.recibo)} — recibo de ${ehDevolucao ? "devolução" : "pagamento"}</title>
<style>
  @page { size: A5 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 12px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1f; background: #eceef5; }
  .folha { background: #fff; max-width: 200mm; margin: 14px auto; padding: 14mm 14mm 10mm;
    position: relative; box-shadow: 0 2px 18px rgb(0 0 0 / .12); }
  @media print { body { background: #fff; } .folha { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
  .cabeca { display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #1e275f; padding-bottom: 9px; margin-bottom: 14px; }
  .cabeca b { font-size: 15px; color: #1e275f; display: block; }
  .cabeca span { display: block; font-size: 10.5px; color: #55555f; }
  .doc { text-align: right; }
  .doc b { font-size: 12.5px; }
  .doc .cod { font: 800 17px ui-monospace, Consolas, monospace; color: #d9440e; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .valorao { font: 800 30px ui-monospace, Consolas, monospace; color: ${ehDevolucao ? "#b3261e" : "#157a4a"};
    margin: 6px 0 2px; }
  .extenso { font-size: 11px; color: #55555f; margin-bottom: 14px; }
  .campos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 14px; margin-bottom: 14px; }
  .campo b { display: block; font-size: 9px; letter-spacing: .07em; text-transform: uppercase; color: #8a8a99; }
  .campo span { font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11.5px; }
  th, td { padding: 5px 7px; border-bottom: 1px solid #e6e8f0; text-align: left; }
  th { background: #f4f5f9; font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: #55555f; }
  .n { text-align: right; font-family: ui-monospace, Consolas, monospace; }
  .saldo { display: flex; gap: 10px; margin-bottom: 14px; }
  .saldo > div { flex: 1; padding: 9px 11px; border: 1px solid #dfe2ec; border-radius: 5px; }
  .saldo b { display: block; font: 800 16px ui-monospace, Consolas, monospace; }
  .saldo span { font-size: 9px; letter-spacing: .07em; text-transform: uppercase; color: #8a8a99; }
  .falta b { color: ${faltavaDepois > 0.004 ? "#b3261e" : "#157a4a"}; }
  .assina { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
  .assina div { border-top: 1px solid #1a1a1f; padding-top: 5px; font-size: 10px; text-align: center; }
  .pe { margin-top: 14px; font-size: 9.5px; color: #8a8a99; display: flex; justify-content: space-between; }
</style></head><body>
<div class="folha">
  <div class="cabeca">
    <div>
      <b>${escH(empresa.nome)}</b>
      <span>${empresa.cnpj ? "CNPJ " + escH(empresa.cnpj) + " · " : ""}${escH(empresa.endereco)}</span>
      <span>${[empresa.telefone && "Tel. " + empresa.telefone, empresa.email].filter(Boolean).map(escH).join(" · ")}</span>
    </div>
    <div class="doc">
      <b>Recibo de ${ehDevolucao ? "devolução" : "pagamento"}</b>
      <div class="cod">${escH(l.recibo)}</div>
      <span style="font-size:10px;color:#55555f">${soData(l.ocorrido_em)}</span>
    </div>
  </div>

  <h1>${ehDevolucao ? "Devolvemos a" : "Recebemos de"} ${escH(l.cliente_nome)}</h1>
  <div class="valorao">${rsBr(l.valor)}</div>
  <div class="extenso">referente à nota <b>${escH(nota.codigo)}</b>${
    nota.numero_nf ? " · NF " + escH(nota.numero_nf) : ""}${
    l.descricao ? " — " + escH(l.descricao) : ""}</div>

  <div class="campos">
    <div class="campo"><b>CNPJ / CPF</b><span>${escH(l.documento || "—")}</span></div>
    <div class="campo"><b>Telefone</b><span>${escH(l.telefone || "—")}</span></div>
    <div class="campo"><b>Forma</b><span>${escH(FORMAS[l.forma] || l.forma)}</span></div>
    <div class="campo"><b>Emitido em</b><span>${soData(opcoes.agora)}</span></div>
  </div>

  <table>
    <thead><tr><th>Lotes desta nota</th><th class="n">Peças</th><th class="n">Valor</th></tr></thead>
    <tbody>${conta.lotes.map((x) => `<tr>
      <td>${escH(x.codigo)}${x.descricao ? " — " + escH(x.descricao) : ""}</td>
      <td class="n">${nBr(x.pecas)}</td><td class="n">${rsBr(x.valor)}</td></tr>`).join("") ||
      '<tr><td colspan="3">—</td></tr>'}
    </tbody>
  </table>

  <div class="saldo">
    <div><span>Valor da nota</span><b>${rsBr(conta.valor)}</b></div>
    <div><span>${ehDevolucao ? "Já havia entrado" : "Pago até aqui"}</span><b>${rsBr(pagoAte)}</b></div>
    <div class="falta"><span>${faltavaDepois > 0.004 ? "Ficou faltando" : "Situação"}</span>
      <b>${faltavaDepois > 0.004 ? rsBr(faltavaDepois) : "QUITADA"}</b></div>
  </div>

  <div class="assina">
    <div>${escH(empresa.nome)}</div>
    <div>${escH(l.cliente_nome)}</div>
  </div>

  <div class="pe">
    <span>Emitido por ${escH(opcoes.porQuem || "—")}${
      empresa.versao ? " · sistema v" + escH(empresa.versao) : ""}</span>
    <span>${escH(l.recibo)}</span>
  </div>
</div>
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
    campos: ["nome", "documento", "telefone", "email", "cidade", "observacao", "ativo"],
    obrigatorios: ["nome"],
    ordem: "nome",
    /* A lista de clientes cresce para sempre e é onde se procura por nome. */
    paginavel: true,
    busca: ["nome", "documento", "telefone", "email", "cidade"],
  },
  desenhos: {
    tabela: "desenhos",
    campos: ["cliente_id", "nome", "pontuacao", "preco", "observacao", "ativo"],
    obrigatorios: ["nome", "pontuacao"],
    ordem: "nome",
    paginavel: true,
    /* Com o prefixo da tabela escrito à mão. Procurar desenho pelo nome do
       CLIENTE é o jeito como se procura de verdade — "o que eu tenho da
       Marcela?" vem antes de "onde está o RECIFE2". Sem o prefixo explícito,
       `nome` seria ambíguo entre as duas tabelas do JOIN e o Postgres recusa
       a consulta inteira. */
    busca: ["d.nome", "c.nome"],
    /* Este cadastro é o único que tem coluna que nem todo mundo pode ver. */
    soAdmin: ["preco"],
  },
  mercadorias: { tabela: "mercadorias", campos: ["nome", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
  cores:       { tabela: "cores",       campos: ["nome", "hex", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
  maquinas:    { tabela: "maquinas",    campos: ["nome", "cabecas", "ativo"], obrigatorios: ["nome"], ordem: "nome" },
};

const INTEIROS = new Set(["cliente_id", "pontuacao", "cabecas"]);
const DINHEIRO = new Set(["preco"]);

/* ==========================================================================
   DINHEIRO DIGITADO POR GENTE

   Aceita o que uma pessoa escreve de verdade: `12,50`, `12.50`, `R$ 1.234,56`,
   `1234`. Devolve string decimal para o Postgres — nunca `Number`.

   POR QUE NÃO `Number`: o ponto flutuante do JavaScript não representa 0,1
   exatamente, e somar preços em `float` acumula centavos de erro. A coluna é
   `NUMERIC` justamente para não ter esse problema; converter para `Number` no
   meio do caminho traria o problema de volta antes de o valor chegar lá.

   A regra do separador: o ÚLTIMO ponto ou vírgula que tiver 1 ou 2 dígitos
   depois dele é o decimal; todo o resto é separador de milhar e some. É o que
   faz `1.234,56` e `1,234.56` chegarem os dois em 1234.56, sem precisar
   adivinhar a região de quem digitou.

   VAZIO É NULO, não zero — a distinção que separa "ainda não precifiquei"
   de "é de graça". Um `Number("")` valendo 0 é exatamente como um desenho
   entraria valendo R$ 0,00 dentro de um lote faturado.
   ========================================================================== */
function dinheiro(v, rotulo) {
  let s = String(v ?? "").trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (s === "") return null;
  if (!/^[0-9.,]+$/.test(s)) throw new Error(`${rotulo} precisa ser um valor como 12,50`);

  const ultimo = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  let inteiro = s, decimais = "";
  if (ultimo >= 0 && s.length - ultimo - 1 <= 2 && s.length - ultimo - 1 >= 1) {
    inteiro = s.slice(0, ultimo);
    decimais = s.slice(ultimo + 1);
  }
  inteiro = inteiro.replace(/[.,]/g, "");
  if (inteiro === "") inteiro = "0";
  if (!/^\d+$/.test(inteiro) || (decimais && !/^\d{1,2}$/.test(decimais)))
    throw new Error(`${rotulo} precisa ser um valor como 12,50`);
  if (inteiro.length > 10) throw new Error(`${rotulo} é grande demais`);
  return decimais ? `${inteiro}.${decimais.padEnd(2, "0")}` : `${inteiro}.00`;
}

function prepararCadastro(def, corpo) {
  const dados = {};
  for (const c of def.campos) {
    if (!(c in corpo)) continue;
    let v = corpo[c];
    if (c === "ativo") v = !!v && v !== "0" && v !== "false";
    else if (DINHEIRO.has(c)) v = dinheiro(v, c === "preco" ? "o preço" : c);
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
    } else if (c === "hex") {
      /* O tom da cor. Normaliza para `#rrggbb` minúsculo ANTES do banco: o
         CHECK só aceita esse formato, e um `#FFF` vindo da tela viraria erro
         de driver em vez de mensagem que alguém entende. */
      const s = String(v ?? "").trim().toLowerCase();
      if (s === "") v = "";
      else {
        const curto = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
        const longo = /^#?([0-9a-f]{6})$/.exec(s);
        if (curto) v = `#${curto[1]}${curto[1]}${curto[2]}${curto[2]}${curto[3]}${curto[3]}`;
        else if (longo) v = `#${longo[1]}`;
        else throw new Error("o tom da cor precisa ser um código como #1e275f");
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

/* ==========================================================================
   4a-ter. A LISTA QUE O NAVEGADOR TEM PODE ESTAR VELHA

   A tela guarda as listas de cadastro em memória (`LISTAS`) e as reusa o turno
   inteiro — é o que a deixa rápida na máquina. O preço disso: entre carregar a
   lista e gravar a ficha, alguém no escritório pode ter apagado aquela cor.

   Sem esta conferência o resultado era um 500. Aconteceu em produção nos dias
   07 e 08/08/2026, seis vezes:

       insert or update on table "fichas" violates foreign key constraint
       "fichas_cor_id_fkey"

   O que a pessoa via era "erro interno" — e ela estava FECHANDO UMA FICHA, com
   a peça já bordada e a quantidade contada. O trabalho não entrava no sistema e
   nada dizia por quê. Uma trava de banco fazendo o papel de mensagem é sempre
   isso: correta e inútil para quem está na frente da tela.

   Duas coisas mudam aqui. Esta função devolve UMA FRASE em vez do erro de
   driver, com `recarregar: true` para a tela buscar as listas de novo. E o
   `avisar()` passou a disparar também quando um cadastro é APAGADO ou
   DESATIVADO — o que fecha a janela em que a lista velha existe, em vez de só
   tratar o sintoma.

   ZERO É NULO AQUI. `Number("0")` é 0, e 0 não é id de nada: sem esta
   conversão, um `cor_id: "0"` vindo de um `<select>` mal preenchido seria
   gravado como zero e o banco recusaria a ficha inteira.
   ========================================================================== */
/* ==========================================================================
   EXPEDIENTE DO OPERADOR — a combinação de horas, por dia da semana

   Dois formatos, porque a fábrica combina de dois jeitos e os dois convivem:

     · "fixo"  → entra e sai em hora marcada:  {"1":{"entrada":"07:30","saida":"17:00"}}
     · "horas" → só a quantidade combinada:    {"1":{"horas":8},"6":{"horas":4}}

   Dia da semana 0=domingo … 6=sábado, o mesmo do `getDay()` e do `EXTRACT(DOW)`.
   DIA AUSENTE = NÃO TRABALHA — e essa é a informação que faz a tela de horários
   saber que a ausência de sábado não é falta.

   A validação é aqui E no banco (`ck_usuarios_expediente`). A do banco é a que
   vale; esta é a que explica em português o que está errado, em vez de devolver
   uma violação de restrição para a tela.
   ========================================================================== */
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

function lerExpediente(valor) {
  if (valor === null || valor === undefined || valor === "") return null;   // "sem expediente definido"
  if (typeof valor !== "object" || Array.isArray(valor)) throw new Error("expediente em formato inesperado");

  const tipo = String(valor.tipo || "");
  if (!["fixo", "horas"].includes(tipo)) throw new Error("escolha entre horário fixo ou horas por dia");

  const dias = {};
  const entrada = valor.dias && typeof valor.dias === "object" ? valor.dias : {};
  for (const [chave, def] of Object.entries(entrada)) {
    const dia = Number(chave);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) throw new Error("dia da semana inválido");
    if (!def || typeof def !== "object") continue;

    if (tipo === "fixo") {
      const ent = String(def.entrada || "").trim();
      const sai = String(def.saida || "").trim();
      /* Dia sem NENHUM dos dois é dia que não se trabalha: sai do objeto em vez
         de virar `{}`, que depois seria lido como "trabalha, mas sem horário". */
      if (!ent && !sai) continue;
      if (!HORA.test(ent) || !HORA.test(sai)) throw new Error("a hora precisa estar no formato 07:30");
      /* Saída antes da entrada: o turno da madrugada existe (22h → 06h), e por
         isso isto NÃO é barrado — a tela de horários mede o que foi batido, não
         o combinado. O que é barrado é a igualdade, que significa zero hora. */
      if (ent === sai) throw new Error("a entrada e a saída não podem ser a mesma hora");
      /* INTERVALO em MINUTOS, e não em hora marcada de saída e volta do almoço.
         A batida já registra QUANDO a pessoa parou; o combinado só precisa de
         QUANTO se desconta. Fixar "almoço é 12:00 às 13:00" transformaria quem
         come 12h20 em devedor de horas sem ter trabalhado um minuto a menos. */
      const int = Number(String(def.intervalo ?? "").replace(",", "."));
      const minutos = Number.isFinite(int) && int > 0 ? Math.round(int) : 0;
      if (minutos >= 24 * 60) throw new Error("o intervalo não cabe no dia");
      dias[dia] = minutos ? { entrada: ent, saida: sai, intervalo: minutos }
                          : { entrada: ent, saida: sai };
    } else {
      const h = Number(String(def.horas ?? "").replace(",", "."));
      if (!Number.isFinite(h) || h <= 0) continue;                 // dia sem horas = não trabalha
      if (h > 24) throw new Error("um dia não tem mais de 24 horas");
      dias[dia] = { horas: Math.round(h * 100) / 100 };
    }
  }

  /* Expediente sem nenhum dia é o mesmo que não ter expediente. Guardar
     `{"tipo":"fixo","dias":{}}` criaria um terceiro estado — "definido, mas
     vazio" — que a tela teria de distinguir de nulo sem nenhum ganho. */
  if (!Object.keys(dias).length) return null;
  return { tipo, dias };
}

/* Quantos segundos essa pessoa combinou trabalhar num dia da semana.
   Devolve 0 quando o dia não está no expediente — que é "não trabalha", e não
   "faltou". `null` só quando não há expediente nenhum: aí não existe combinado
   e, portanto, não existe saldo. Zero e "não sei" precisam ser coisas
   diferentes, senão quem nunca teve horário combinado apareceria devendo o
   período inteiro. */
function previstoDoDia(expediente, diaDaSemana) {
  if (!expediente || !expediente.dias) return null;
  const d = expediente.dias[String(diaDaSemana)] || expediente.dias[diaDaSemana];
  if (!d) return 0;

  if (expediente.tipo === "horas") return Math.round(Number(d.horas || 0) * 3600);

  const mins = (h) => {
    const p = HORA.exec(String(h || ""));
    return p ? Number(p[1]) * 60 + Number(p[2]) : null;
  };
  const ent = mins(d.entrada), sai = mins(d.saida);
  if (ent === null || sai === null) return 0;
  /* Saída MENOR que entrada é o turno que atravessa a meia-noite (22h → 06h).
     Sem o `+24h` ele viraria um número negativo que some dentro da soma do mês
     e puxa o total de todo mundo para baixo, sem nenhuma linha parecer errada. */
  const bruto = (sai > ent ? sai - ent : sai + 24 * 60 - ent) * 60;
  return Math.max(0, bruto - Number(d.intervalo || 0) * 60);
}

/* ==========================================================================
   SALDO DE HORAS — o que foi batido menos o que foi combinado

   Três decisões que mudam o número, e por isso ficam escritas:

   1. O DIA DE HOJE SÓ ENTRA DEPOIS DE ENCERRADO. Enquanto a jornada está
      aberta, "trabalhou 2h de 8h" é verdade e é inútil: às 9 da manhã a
      fábrica inteira apareceria devendo 6 horas, todo santo dia, e o vermelho
      deixaria de querer dizer alguma coisa. O dia de hoje entra quando o
      operador encerra — e o dia sem nenhuma batida ainda não é falta, é dia
      que não acabou.

   2. SÓ JORNADA FECHADA CONTA. Uma jornada de ontem que ficou aberta não vale
      `agora - início`: isso somaria a madrugada inteira e mais o dia seguinte.
      Ela conta ZERO e aparece no aviso de jornadas abertas — o dia fica
      vermelho, que é exatamente o que faz alguém ir corrigir a batida.

   3. AS PARES DO DIA SOMAM. Quem sai para o almoço e volta gera duas jornadas
      no mesmo dia; o combinado é do DIA, não da batida. Por isso a conta é
      agrupada por dia e só depois comparada com o expediente daquele dia da
      semana — comparar batida a batida acusaria meio dia de falta em quem
      almoçou.

   Sem período fechado não há saldo: "desde sempre" não tem quantos dias
   combinados, e um total sem divisor é um número inventado.
   ========================================================================== */
const TETO_DE_DIAS = 400;      /* filtro de anos não trava o servidor contando dia a dia */

async function saldoDoPeriodo({ de, ate, usuarioId }) {
  if (!de || !ate) return { calculado: false, motivo: "escolha um período para calcular o saldo" };

  /* "Hoje" é o do BANCO. O relógio da máquina de quem abriu a tela pode estar
     num fuso adiantado, e aí o dia de hoje entraria no saldo antes da hora. */
  const agora = await Q.get("SELECT current_date::text hoje");
  const hoje = agora.hoje;

  const cond = ["u.papel <> 'dono'", "j.inicio >= ?", "j.inicio <= ?"];
  const args = [de + " 00:00:00", ate + " 23:59:59"];
  if (usuarioId) { cond.push("j.usuario_id = ?"); args.push(usuarioId); }

  /* Uma linha por operador e por DIA — as batidas do dia já somadas aqui. */
  const porDia = await Q.all(
    `SELECT j.usuario_id, j.inicio::date::text dia,
            COALESCE(SUM(EXTRACT(EPOCH FROM (j.fim - j.inicio)))
                     FILTER (WHERE j.fim IS NOT NULL), 0)::bigint segundos,
            COUNT(*) FILTER (WHERE j.fim IS NULL)::int abertas,
            COUNT(*)::int batidas
       FROM jornadas j JOIN usuarios u ON u.id = j.usuario_id
      WHERE ${cond.join(" AND ")}
      GROUP BY j.usuario_id, j.inicio::date`, ...args);

  const pessoas = await Q.all(
    "SELECT id, nome, usuario, ativo, expediente FROM usuarios WHERE papel <> 'dono'" +
    (usuarioId ? " AND id = ?" : ""), ...(usuarioId ? [usuarioId] : []));

  const dias = new Map();       /* usuario_id -> { dia -> linha } */
  for (const l of porDia) {
    if (!dias.has(l.usuario_id)) dias.set(l.usuario_id, new Map());
    dias.get(l.usuario_id).set(l.dia, l);
  }

  /* Calendário do período em UTC de propósito: somar 86.400.000 ms sobre um
     horário local pula ou repete um dia nas viradas de horário de verão, e o
     saldo do mês sairia com um dia a mais ou a menos. */
  const emMs = (t) => { const p = t.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  const emTexto = (ms) => new Date(ms).toISOString().slice(0, 10);
  const inicio = emMs(de);
  const fim = Math.min(emMs(ate), emMs(hoje));      /* futuro não tem saldo */
  let cortado = false;
  let primeiro = inicio;
  if (fim >= inicio && (fim - inicio) / 86400000 + 1 > TETO_DE_DIAS) {
    primeiro = fim - (TETO_DE_DIAS - 1) * 86400000;
    cortado = true;
  }

  const linhas = [];
  for (const p of pessoas) {
    const meus = dias.get(p.id) || new Map();
    if (!meus.size && (!p.ativo || !p.expediente)) continue;    /* nem bateu ponto nem tem combinado */

    let trabalhado = 0, previsto = 0, diasComBatida = 0, abertas = 0, semCombinado = 0;
    for (let ms = primeiro; ms <= fim; ms += 86400000) {
      const dia = emTexto(ms);
      const l = meus.get(dia);
      const ehHoje = dia === hoje;
      /* Hoje só entra se já foi encerrado; e um dia de hoje sem batida nenhuma
         ainda não aconteceu. */
      if (ehHoje && (!l || l.abertas > 0)) { if (l) abertas += l.abertas; continue; }
      if (l) { abertas += l.abertas; if (l.batidas) diasComBatida++; trabalhado += Number(l.segundos); }
      const esperado = previstoDoDia(p.expediente, new Date(ms).getUTCDay());
      if (esperado === null) semCombinado++; else previsto += esperado;
    }

    /* Sem expediente não há saldo — e mostrar zero seria dizer "está em dia". */
    const temCombinado = !!p.expediente && semCombinado === 0;
    linhas.push({
      usuario_id: p.id, operador: p.nome || p.usuario, login: p.usuario, ativo: !!p.ativo,
      trabalhado, dias: diasComBatida, abertas,
      previsto: temCombinado ? previsto : null,
      saldo: temCombinado ? trabalhado - previsto : null,
      expediente: p.expediente || null,
    });
  }

  linhas.sort((a, b) => {
    if ((a.saldo === null) !== (b.saldo === null)) return a.saldo === null ? 1 : -1;
    if (a.saldo !== null) return a.saldo - b.saldo;          /* quem mais deve, primeiro */
    return String(a.operador).localeCompare(String(b.operador), "pt-BR");
  });

  const comSaldo = linhas.filter((l) => l.saldo !== null);
  return {
    calculado: true, de, ate, hoje, cortado,
    itens: linhas,
    geral: {
      operadores: linhas.length,
      /* O total geral soma POSITIVOS E NEGATIVOS — é o que sobra para a
         fábrica. Os dois lados vão separados junto porque um saldo geral zerado
         pode ser "todo mundo em dia" ou "um devendo 20h e outro com 20h
         extras", e essas duas fábricas não são a mesma. */
      trabalhado: linhas.reduce((s, l) => s + l.trabalhado, 0),
      previsto: comSaldo.reduce((s, l) => s + l.previsto, 0),
      saldo: comSaldo.reduce((s, l) => s + l.saldo, 0),
      positivo: comSaldo.reduce((s, l) => s + Math.max(0, l.saldo), 0),
      negativo: comSaldo.reduce((s, l) => s + Math.min(0, l.saldo), 0),
      semCombinado: linhas.length - comSaldo.length,
      abertas: linhas.reduce((s, l) => s + l.abertas, 0),
    },
  };
}

const REFERENCIAS = {
  mercadoria_id: { tabela: "mercadorias", oQue: "mercadoria" },
  cor_id:        { tabela: "cores",       oQue: "cor" },
  maquina_id:    { tabela: "maquinas",    oQue: "máquina" },
};

async function conferirReferencias(campos) {
  for (const [campo, def] of Object.entries(REFERENCIAS)) {
    if (!(campo in campos)) continue;
    const v = campos[campo];
    if (v === null || v === undefined || v === "" || Number(v) === 0) { campos[campo] = null; continue; }
    const existe = await Q.get(`SELECT id FROM ${def.tabela} WHERE id = ?`, Number(v));
    if (!existe) {
      return `Essa ${def.oQue} não existe mais — ela foi apagada enquanto esta tela estava aberta. ` +
             "A lista foi atualizada: escolha de novo.";
    }
    campos[campo] = Number(v);
  }
  return null;
}

/* ==========================================================================
   4a-bis. O QUE O OPERADOR NÃO PODE VER

   O desenho passou a ter PREÇO, e preço é do escritório. O operador escolhe o
   desenho a cada ficha — a lista de desenhos é a rota mais chamada do sistema
   pela tela que menos pode ver esse campo.

   AS DUAS FUNÇÕES ABAIXO SÃO O ÚNICO LUGAR DESSA REGRA, e é de propósito. A
   alternativa seria escrever a coluna certa em cada `SELECT`, e são cinco
   consultas diferentes que devolvem desenho (lista, item, modal do cliente,
   ficha aberta, produção). Bastaria uma delas nascer com `d.*` — como todas
   nasceram — para o preço vazar sem que nada quebrasse: a tela do operador
   não mostra o campo, ela só o RECEBE, e ninguém vê o que não é desenhado.
   Quem procura, acha: está no corpo da resposta, à vista, em qualquer
   navegador.

   Por isso a filtragem é de saída (some do objeto) e não de entrada (escolher
   colunas): uma consulta nova que alguém acrescentar amanhã passa por aqui de
   graça, sem precisar lembrar da regra.
   ========================================================================== */
function esconderSegredos(def, sessao, linhas) {
  if (!def || !def.soAdmin || ehAdmin(sessao)) return linhas;
  const lista = Array.isArray(linhas) ? linhas : [linhas];
  for (const l of lista) if (l) for (const c of def.soAdmin) delete l[c];
  return linhas;
}

/* E o outro lado: o operador tampouco GRAVA o campo. Sem isto ele não veria o
   preço na tela e ainda assim poderia mandá-lo no corpo da requisição ao
   cadastrar um desenho — pondo um preço que o escritório não escolheu num
   sistema em que ele nem deveria saber que existe. */
function tirarSegredosDoCorpo(def, sessao, corpo) {
  if (!def || !def.soAdmin || ehAdmin(sessao)) return corpo;
  for (const c of def.soAdmin) delete corpo[c];
  return corpo;
}

/* ==========================================================================
   4b. VÍNCULOS — o que impede apagar

   Cadastro que NUNCA foi usado é engano de digitação: apagar é o certo, e
   deixá-lo "inativo" para sempre só enche a lista de lixo que ninguém tem
   coragem de tirar.

   Cadastro JÁ USADO é outra coisa. Ele não está só na lista: está dentro de
   uma ficha de três meses atrás, de um lote que virou nota. Apagar faria o
   relatório daquele mês mostrar um vazio onde havia um cliente. Esse só pode
   ser DESATIVADO — sai da escolha, fica no passado.

   ATENÇÃO — A CONTA ABAIXO NÃO É SÓ UMA MENSAGEM MAIS BONITA.

   O banco protege apenas TRÊS destes vínculos com RESTRICT: cliente, desenho e
   usuário. Os outros são ON DELETE SET NULL:

       cor_id, mercadoria_id, maquina_id, lote_id  →  SET NULL

   Ou seja: sem esta verificação, apagar uma cor apagaria a cor de TODAS as
   fichas antigas — em silêncio, sem erro nenhum. A ficha sobreviveria sem
   saber mais de que cor era a peça, e a composição do lote (que é o que
   sustenta a nota) sairia errada sem ninguém perceber. Apagar um lote levaria
   junto o vínculo de todas as fichas dele.

   Provado por sabotagem: desligando esta checagem, a suíte viu cor, mercadoria
   e máquina EM USO serem apagadas com 200 e sumirem do banco.

   Para cliente, desenho e usuário, o banco também barra — e ali a conta serve
   ao segundo propósito: dizer POR QUE não dá, e quantos. "Está em 14 fichas"
   resolve; "erro de chave estrangeira" manda a pessoa perguntar a alguém.
   ========================================================================== */
const VINCULOS = {
  clientes: [
    { tabela: "desenhos", coluna: "cliente_id", um: "desenho", muitos: "desenhos" },
    { tabela: "fichas",   coluna: "cliente_id", um: "ficha de produção", muitos: "fichas de produção" },
    { tabela: "lotes",    coluna: "cliente_id", um: "lote", muitos: "lotes" },
  ],
  /* As FOTOS não entram: elas pertencem ao desenho e vão junto com ele. */
  desenhos:    [{ tabela: "fichas", coluna: "desenho_id",    um: "ficha de produção", muitos: "fichas de produção" }],
  mercadorias: [{ tabela: "fichas", coluna: "mercadoria_id", um: "ficha de produção", muitos: "fichas de produção" }],
  cores:       [{ tabela: "fichas", coluna: "cor_id",        um: "ficha de produção", muitos: "fichas de produção" }],
  maquinas:    [{ tabela: "fichas", coluna: "maquina_id",    um: "ficha de produção", muitos: "fichas de produção" }],
  usuarios: [
    { tabela: "fichas",   coluna: "usuario_id", um: "ficha de produção", muitos: "fichas de produção" },
    { tabela: "jornadas", coluna: "usuario_id", um: "jornada", muitos: "jornadas" },
  ],
  lotes: [{ tabela: "fichas", coluna: "lote_id", um: "ficha", muitos: "fichas" }],
};

async function vinculosDe(tabela, id) {
  const achados = [];
  for (const v of VINCULOS[tabela] || []) {
    const r = await Q.get(`SELECT COUNT(*) c FROM ${v.tabela} WHERE ${v.coluna} = ?`, id);
    const n = Number(r.c);
    if (n) achados.push({ quantos: n, o_que: n === 1 ? v.um : v.muitos });
  }
  return achados;
}

/* "3 fichas de produção e 1 lote" — a frase que entra na mensagem. */
function textoVinculos(vinculos) {
  const partes = vinculos.map((v) => `${v.quantos} ${v.o_que}`);
  if (partes.length <= 1) return partes[0] || "";
  return partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1];
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
async function rotas(req, res, caminho, limitador, ipDoCliente, empresa) {
  /* Sem os dados da empresa o recibo sairia com o cabeçalho em branco — e um
     recibo sem quem emitiu não é recibo. O padrão aqui é rede de segurança
     para quem chamar `rotas()` de um teste, não para produção. */
  empresa = empresa || { nome: "Borda Tudo", curto: "Borda Tudo", cnpj: "", endereco: "", telefone: "", email: "", versao: "" };

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
    sessoes.set(rid, {
      usuarioId: u.id, usuario: u.usuario, nome: u.nome, papel: u.papel,
      /* A sessão nasce TRANCADA quando a senha ainda é a provisória. A trava
         vive na sessão, e não só no banco, para não custar uma consulta por
         requisição — e é derrubada no mesmo lugar em que a senha é trocada. */
      provisoria: !!u.senha_provisoria,
      visto: Date.now(),
    });
    return responder(res, 200, {
      ok: true, usuario: u.usuario, nome: u.nome, papel: u.papel,
      trocarSenha: !!u.senha_provisoria,
    }, { "Set-Cookie": cookieRid(rid, req) });
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
      /* A TELA NÃO DECIDE PELO NOME DO PAPEL. Com a entrada do `dono`, um
         `papel === "admin"` no JavaScript esconderia do dono justamente os
         botões que ele foi criado para usar. O servidor manda a RESPOSTA
         (`admin: sim`), não a matéria-prima para a tela concluir errado. */
      admin: ehAdmin(sessao),
      dono: ehDono(sessao),
      trocarSenha: !!sessao.provisoria,
    });
  }

  /* ==========================================================================
     A TRAVA DA SENHA PROVISÓRIA

     Enquanto a senha for a de uso único, ESTA sessão não faz mais nada além de
     olhar quem é e trocar a senha. Fica no servidor, e não só na tela: uma
     trava que mora no JavaScript da página cai por terra assim que alguém
     chama a rota direto — e a senha provisória passou pelas mãos de quem
     cadastrou, então ela não pode valer como senha de verdade nem por um
     minuto de uso.
     ====================================================================== */
  /* O DONO NÃO ENTRA NESTA TRAVA — e é uma trava contra mim mesmo.

     A senha do dono só se troca pelo terminal. Se a conta dele chegasse aqui
     com `senha_provisoria`, o sistema o mandaria trocar a senha e a rota de
     trocar senha o recusaria: conta trancada para fora, sem saída pelo
     painel, justamente a conta que existe para destrancar as outras.

     O `criar-usuario.cjs` já nasce essa conta com a senha definitiva, então
     isto não deveria acontecer nunca. "Não deveria acontecer nunca" é
     exatamente a frase que precede os travamentos que ninguém consegue
     explicar depois — e o custo de escrever esta linha é uma comparação. */
  if (sessao.provisoria
      && !ehDono(sessao)
      && caminho !== "/restrito/api/eu/senha"
      && caminho !== "/restrito/api/sair") {
    return responder(res, 403, {
      error: "Troque a senha provisória antes de usar o sistema.",
      trocarSenha: true,
    });
  }

  /* ---------------------------------------------------------- eventos --- */
  /* A conexão que fica aberta. Vem DEPOIS da trava da senha provisória de
     propósito: quem ainda não trocou a senha não abre canal nenhum. */
  if (caminho === "/restrito/api/eventos" && req.method === "GET") {
    /* Esta resposta não termina — e é o único lugar do sistema assim. Sem
       zerar o tempo limite do socket, a conexão morreria calada depois de
       alguns minutos; o `EventSource` reconectaria, então nada pareceria
       quebrado, mas o servidor acumularia um ciclo de queda e reconexão por
       minuto em cada máquina da fábrica, para sempre. */
    res.setTimeout(0);
    if (res.socket) res.socket.setNoDelay(true);
    return assinarEventos(req, res, sessao);
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
    /* A SENHA DO DONO NÃO SE TROCA PELA TELA — nem a própria.

       O motivo é o mesmo que fez a conta ser invisível: ela é a chave reserva.
       Uma sessão de dono esquecida aberta numa máquina da fábrica, ou um
       navegador emprestado, bastaria para alguém trocar a senha e ficar com a
       conta que tem poder sobre tudo — sem deixar rastro, porque trocar a
       própria senha é operação legítima e silenciosa.

       Pelo terminal exige acesso ao servidor, que é outra chave inteiramente.
       Duas fechaduras diferentes na mesma porta:
       `node criar-usuario.cjs --dono <login>`. */
    if (ehDono(sessao)) return responder(res, 403, { error: SO_TERMINAL });

    const corpo = (await lerCorpo(req)) || {};
    const nova = String(corpo.nova || "");
    const u = await Q.get("SELECT senha_hash, senha_provisoria FROM usuarios WHERE id = ?", sessao.usuarioId);
    if (!u) return responder(res, 401, { error: "usuário não encontrado" });

    /* NA PRIMEIRA TROCA não se pede a senha atual: a pessoa acabou de digitá-la
       para entrar, e a tela está travada nesta operação desde então. Pedir de
       novo, na fábrica, é o empurrão que faz alguém anotar a senha num papel
       colado na máquina.

       Na troca voluntária a atual CONTINUA sendo exigida — ali a sessão pode
       estar aberta há horas, largada na bancada. */
    if (!u.senha_provisoria && !conferirSenha(corpo.atual, u.senha_hash))
      return responder(res, 401, { error: "senha atual incorreta" });

    const problema = conferirSenhaNova(nova, u.senha_provisoria ? corpo.atual : null);
    if (problema) return responder(res, 400, { error: problema });

    /* Repetir a senha que já estava valendo é "trocar" sem trocar nada — e a
       pessoa sairia da tela achando que resolveu. */
    if (conferirSenha(nova, u.senha_hash))
      return responder(res, 400, { error: "essa já é a sua senha — escolha outra" });

    await Q.run("UPDATE usuarios SET senha_hash = ?, senha_provisoria = FALSE WHERE id = ?",
      gerarHash(nova), sessao.usuarioId);

    /* Derruba as OUTRAS sessões desta conta. Quem troca a senha normalmente
       troca porque desconfia de alguém — deixar a sessão do outro viva anula
       o motivo da troca. */
    const rid = ridDe(req);
    for (const [k, s] of sessoes) if (s.usuarioId === sessao.usuarioId && k !== rid) sessoes.delete(k);

    /* E destrava ESTA sessão: a pessoa continua de onde parou, sem entrar de
       novo. Entrar duas vezes seguidas parece erro do sistema. */
    sessao.provisoria = false;
    return responder(res, 200, { ok: true });
  }

  /* Desativar e reativar. Rota SEPARADA do DELETE de propósito: "excluir" e
     "desativar" fazem coisas diferentes, e um botão que faz as duas conforme o
     caso é um botão que um dia faz a errada. */
  const mAtivar = /^\/restrito\/api\/(clientes|desenhos|mercadorias|cores|maquinas)\/(\d+)\/ativo$/.exec(caminho);
  if (mAtivar && req.method === "PUT") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador mexe nos cadastros" });
    const tabela = mAtivar[1], id = Number(mAtivar[2]);
    const ligar = !!((await lerCorpo(req)) || {}).ativo;
    await Q.run(`UPDATE ${tabela} SET ativo = ? WHERE id = ?`, ligar, id);
    /* Desativar tira o cadastro da lista de escolha. Sem o aviso, a tela do
       operador continuaria oferecendo a cor desativada até alguém recarregar. */
    avisar(tabela);

    /* MÁQUINA DESATIVADA TEM O QR INVALIDADO. Sem isto, o adesivo colado nela
       voltaria a valer no dia em que alguém reativasse a máquina — e um adesivo
       que passou meses fora de uso pode ter ido parar em qualquer lugar.
       Reativar exige imprimir etiqueta nova, e é isso que a tela avisa. */
    if (tabela === "maquinas" && !ligar) {
      await Q.run("UPDATE maquinas SET token = ? WHERE id = ?",
        crypto.randomBytes(9).toString("base64url"), id);
      return responder(res, 200, { ok: true, ativo: false, qrInvalidado: true });
    }
    return responder(res, 200, { ok: true, ativo: ligar });
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

      /* PAGINAÇÃO — só quando a tela PEDE (`?pagina=`). Sem o parâmetro, a
         resposta é a lista inteira, que é o que as caixas de seleção da tela
         do operador esperam: paginar um <select> o deixaria com metade das
         opções, e ninguém perceberia até faltar um cliente. */
      const rec = recorteDaPagina(url, 20);
      const paginando = def.paginavel && url.searchParams.has("pagina");
      const busca = String(url.searchParams.get("busca") || "").trim();

      const onde = [], args = [];
      if (!todos) onde.push(`${def.tabela === "desenhos" ? "d." : ""}ativo`);
      if (busca && def.busca) {
        /* Uma condição por campo, unidas por OU: digitar "857" acha pelo
           telefone e digitar "marc" acha pelo nome, sem duas caixas de busca.
           Em desenhos, `busca` já vem com o prefixo da tabela escrito — é o
           que permite procurar pelo nome do CLIENTE na mesma caixa. */
        onde.push("(" + def.busca.map((c) => `${c} ILIKE ?`).join(" OR ") + ")");
        for (const _ of def.busca) args.push(`%${busca}%`);
      }

      /* Desenhos de um cliente só. É o que a modal do cliente usa para listar
         "os bordados da Marcela" sem sair da tela dela. */
      const doCliente = Number(url.searchParams.get("cliente")) || null;
      if (doCliente && def.tabela === "desenhos") { onde.push("d.cliente_id = ?"); args.push(doCliente); }

      /* O que falta precificar. Só faz sentido para quem vê preço — e quem não
         vê recebe a lista inteira, sem pista de que o filtro existe. */
      if (url.searchParams.get("sem_preco") === "1" && def.tabela === "desenhos" && ehAdmin(sessao))
        onde.push("d.preco IS NULL");

      const clausula = onde.length ? "WHERE " + onde.join(" AND ") : "";
      const limite = paginando ? `LIMIT ${rec.por} OFFSET ${rec.offset}` : "";

      let linhas, total = null;
      if (def.tabela === "desenhos") {
        /* O desenho vem com o nome do cliente e a PRIMEIRA foto: a tela mostra
           "RECIFE1 — Marcela" com a miniatura, e sem isso ela teria de cruzar
           três consultas no navegador. */
        linhas = await Q.all(
          `SELECT d.*, c.nome AS cliente_nome,
                  (SELECT f.arquivo FROM desenho_fotos f
                    WHERE f.desenho_id = d.id ORDER BY f.ordem, f.id LIMIT 1) AS capa,
                  (SELECT COUNT(*) FROM desenho_fotos f WHERE f.desenho_id = d.id) AS fotos
             FROM desenhos d
             LEFT JOIN clientes c ON c.id = d.cliente_id
             ${clausula} ORDER BY d.nome ${limite}`, ...args);
      } else {
        /* `maquinas` não devolve o token na listagem — ele só sai na rota do QR.
           Token é identificador de adesivo, não dado de tela. */
        const colunas = def.tabela === "maquinas" ? "id, nome, cabecas, ativo, criado_em" : "*";
        linhas = await Q.all(
          `SELECT ${colunas} FROM ${def.tabela} ${clausula} ORDER BY ${def.ordem} ${limite}`, ...args);
      }

      /* O PREÇO SAI DAQUI se quem pediu não pode vê-lo. Ver `esconderSegredos`:
         a lista é a porta mais larga, porque a tela do operador a chama para
         montar o `<select>` de desenhos a cada ficha. */
      esconderSegredos(def, sessao, linhas);

      if (paginando) {
        /* O total sai de uma consulta própria, com os MESMOS filtros. Contar as
           linhas devolvidas daria sempre "20" e a tela mostraria uma página só.

           O JOIN precisa vir junto: desde que a busca de desenho passou a olhar
           o nome do cliente, `c.nome` aparece na cláusula — e um COUNT sem o
           JOIN não recusa por engano, recusa a consulta inteira, deixando a
           tela sem paginação no exato momento em que alguém busca. */
        const t = await Q.get(
          def.tabela === "desenhos"
            ? `SELECT COUNT(*) c FROM desenhos d LEFT JOIN clientes c ON c.id = d.cliente_id ${clausula}`
            : `SELECT COUNT(*) c FROM ${def.tabela} ${clausula}`, ...args);
        total = Number(t.c);
        return responder(res, 200, Object.assign({ itens: linhas }, envelope(total, rec)));
      }
      return responder(res, 200, { itens: linhas });
    }

    /* ------------------------------------------------------------------
       QUEM PODE GRAVAR CADASTRO

       A regra geral continua: criar e alterar é do administrador. O operador
       escolhe da lista — se ele pudesse cadastrar cliente, "Marcela" e
       "marcella" apareceriam as duas na correria do turno e o relatório do mês
       sairia partido em dois.

       DESENHO É A EXCEÇÃO, e é uma exceção estreita: CRIAR, sim; alterar e
       excluir, não.

       O motivo é o chão de fábrica. O desenho novo chega junto com o serviço,
       às vezes fora do horário do escritório, e a ficha NÃO ABRE sem desenho
       cadastrado. Sem esta porta o operador tem três saídas, e todas são
       piores: parar a máquina, ligar para o Eduardo, ou pendurar a produção
       num desenho parecido — a terceira é a que acontece de verdade, e ela
       envenena o relatório em silêncio.

       O risco do nome duplicado continua existindo, mas aqui ele é barrado
       pelo índice único (cliente + nome): o segundo "LOGO" do mesmo cliente é
       recusado pelo banco. E o desenho que o operador cria nasce SEM PREÇO —
       nulo, não zero — o que o põe automaticamente na lista de pendências do
       administrador. Ele produz hoje; o escritório precifica depois, e o
       sistema sabe dizer o que falta.

       ALTERAR continua fechado de propósito: mudar a pontuação de um desenho
       muda quanto vale toda ficha aberta com ele. Isso é decisão de escritório.
       ------------------------------------------------------------------ */
    const podeCriarDesenho = def.tabela === "desenhos" && req.method === "POST" && !id;
    if (req.method !== "GET" && !ehAdmin(sessao) && !podeCriarDesenho)
      return responder(res, 403, { error: "só o administrador mexe nos cadastros" });

    if (req.method === "POST" && !id) {
      let dados;
      try { dados = prepararCadastro(def, tirarSegredosDoCorpo(def, sessao, (await lerCorpo(req)) || {})); }
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
        /* Avisa as outras telas. É o que faz o desenho recém-cadastrado
           aparecer na máquina sem ninguém apertar F5 — e o que tira do
           operador o motivo para achar que "não salvou". */
        avisar(def.tabela);
        return responder(res, 201, { ok: true, id: novo, semPreco: !ehAdmin(sessao) });
      } catch (e) { return responder(res, 400, { error: erroDeBanco(e, def) }); }
    }

    if (req.method === "PUT" && id) {
      let dados;
      try { dados = prepararCadastro(def, tirarSegredosDoCorpo(def, sessao, (await lerCorpo(req)) || {})); }
      catch (e) { return responder(res, 400, { error: e.message }); }
      const cols = Object.keys(dados);
      if (!cols.length) return responder(res, 400, { error: "nada para gravar" });
      try {
        await Q.run(`UPDATE ${def.tabela} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
          ...cols.map((c) => dados[c]), id);
        avisar(def.tabela);
        return responder(res, 200, { ok: true });
      } catch (e) { return responder(res, 400, { error: erroDeBanco(e, def) }); }
    }

    if (req.method === "DELETE" && id) {
      /* APAGA DE VERDADE — se ninguém depender. Cadastro nunca usado é engano
         de digitação; mantê-lo inativo para sempre só enche a lista.

         Com vínculo, recusa e DIZ QUANTOS. A tela oferece desativar no lugar. */
      const vinculos = await vinculosDe(def.tabela, id);
      if (vinculos.length) {
        return responder(res, 409, {
          error: `Não dá para excluir: está em ${textoVinculos(vinculos)}. ` +
                 "Desative — some da lista de escolha e continua no que já foi produzido.",
          vinculos, podeDesativar: true,
        });
      }

      if (def.tabela === "desenhos") {
        /* As fotos são do desenho e vão junto. A linha sai por CASCADE; o
           ARQUIVO no disco não — e ficaria uma imagem que ninguém mais sabe de
           quem é, num sistema em que o desenho é propriedade do cliente. */
        const fotos = await Q.all("SELECT arquivo FROM desenho_fotos WHERE desenho_id = ?", id);
        try {
          await Q.run("DELETE FROM desenhos WHERE id = ?", id);
        } catch (e) {
          return responder(res, 409, {
            error: "Esse desenho está em uso e não pode ser excluído. Desative-o.",
            podeDesativar: true,
          });
        }
        /* Os arquivos só saem DEPOIS de a linha sair. Na ordem inversa, um
           DELETE recusado deixaria o desenho no banco apontando para fotos que
           não existem mais. */
        for (const f of fotos) {
          try { fs.unlinkSync(path.join(PASTA_FOTOS, f.arquivo)); } catch {}
        }
        avisar("desenhos");
        return responder(res, 200, { ok: true, excluido: true, fotos: fotos.length });
      }

      try {
        await Q.run(`DELETE FROM ${def.tabela} WHERE id = ?`, id);
      } catch (e) {
        /* Rede de segurança: se aparecer um vínculo que a lista acima não
           conhece, o banco barra e a pessoa recebe uma frase, não um erro de
           driver. É o que acontece quando alguém acrescenta uma tabela e
           esquece de registrar o vínculo aqui. */
        return responder(res, 409, {
          error: "Esse registro está em uso e não pode ser excluído. Desative-o.",
          podeDesativar: true,
        });
      }
      /* APAGAR É O QUE MAIS PRECISA AVISAR. É este o caminho que deixava a
         lista do operador apontando para um id que não existe mais — e a ficha
         dele quebrava com erro de chave estrangeira na hora de fechar. */
      avisar(def.tabela);
      return responder(res, 200, { ok: true, excluido: true });
    }

    /* Um cadastro só, para a tela de edição. Ela precisa do registro inteiro
       — inclusive o que a listagem esconde — e ir buscar na lista paginada
       daria "não encontrado" para quem está na página 3. */
    if (req.method === "GET" && id) {
      const item = def.tabela === "desenhos"
        ? await Q.get(`SELECT d.*, c.nome AS cliente_nome FROM desenhos d
                         LEFT JOIN clientes c ON c.id = d.cliente_id WHERE d.id = ?`, id)
        : await Q.get(`SELECT * FROM ${def.tabela} WHERE id = ?`, id);
      if (!item) return responder(res, 404, { error: "não encontrado" });
      if (def.tabela === "maquinas") delete item.token;
      if (def.tabela === "desenhos")
        item.fotos = await Q.all(
          "SELECT id, arquivo, legenda, ordem FROM desenho_fotos WHERE desenho_id = ? ORDER BY ordem, id", id);
      if (def.tabela === "clientes") {
        /* Quanto este cliente já rendeu. É a primeira pergunta que se faz ao
           abrir a ficha de um cliente, e sem isso ela cairia em outra tela.

           Os três números são os que viram BOTÃO na modal: cada um abre a
           lista por trás dele sem sair da tela do cliente. Contar aqui, e não
           em três chamadas separadas, é o que deixa a modal abrir de uma vez —
           os totais aparecem antes de qualquer aba ser aberta. */
        item.resumo = await Q.get(
          `SELECT (SELECT COUNT(*) FROM desenhos WHERE cliente_id = $1) desenhos,
                  (SELECT COUNT(*) FROM lotes    WHERE cliente_id = $1) lotes,
                  (SELECT COUNT(*) FROM lotes    WHERE cliente_id = $1 AND pago_em IS NULL) lotes_a_receber,
                  (SELECT COALESCE(SUM(quantidade),0) FROM fichas
                    WHERE cliente_id = $1 AND situacao = 'fechada') pecas`.replace(/\$1/g, "?"),
          id, id, id, id);
      }
      esconderSegredos(def, sessao, item);
      return responder(res, 200, item);
    }
  }

  /* ==================================================== FOTOS DO DESENHO ==
     As fotos ficam em `data/desenhos/`, FORA de `assets/`, e saem por uma rota
     que exige sessão. O desenho é propriedade do cliente: em `assets/` bastaria
     acertar o nome do arquivo para baixar o bordado de qualquer um, sem login.
     ====================================================================== */
  const mFoto = /^\/restrito\/api\/desenhos\/(\d+)\/fotos(?:\/(\d+))?$/.exec(caminho);
  if (mFoto) {
    /* ACRESCENTAR foto acompanha a regra de criar desenho: o operador pode.
       O desenho novo chega com a arte junto — quase sempre uma imagem colada
       de uma conversa — e um desenho sem imagem obriga quem for produzir
       depois a adivinhar qual é. Alterar legenda e APAGAR continuam do
       administrador: apagar foto é apagar propriedade do cliente. */
    const acrescentandoFoto = req.method === "POST" && !mFoto[2];
    if (!ehAdmin(sessao) && !acrescentandoFoto)
      return responder(res, 403, { error: "só o administrador mexe nas fotos" });
    const desenhoId = Number(mFoto[1]);
    const fotoId = mFoto[2] ? Number(mFoto[2]) : null;

    const desenho = await Q.get("SELECT id FROM desenhos WHERE id = ?", desenhoId);
    if (!desenho) return responder(res, 404, { error: "desenho não encontrado" });

    if (req.method === "GET" && !fotoId) {
      return responder(res, 200, {
        itens: await Q.all(
          "SELECT id, arquivo, legenda, ordem FROM desenho_fotos WHERE desenho_id = ? ORDER BY ordem, id", desenhoId),
      });
    }

    if (req.method === "POST" && !fotoId) {
      const corpo = (await lerCorpo(req)) || {};
      let gravado;
      try { gravado = gravarFoto(corpo.nome, corpo.dados); }
      catch (e) { return responder(res, 400, { error: e.message }); }

      /* A nova entra no FIM. A primeira foto é a capa da lista, e uma foto
         acrescentada depois não deve tomar esse lugar sem alguém pedir. */
      const ultima = await Q.get("SELECT COALESCE(MAX(ordem), -1) o FROM desenho_fotos WHERE desenho_id = ?", desenhoId);
      const id = await Q.inserir(
        "INSERT INTO desenho_fotos (desenho_id, arquivo, legenda, ordem) VALUES (?,?,?,?) RETURNING id",
        desenhoId, gravado, sanitizarHtml(String(corpo.legenda || "")), Number(ultima.o) + 1);
      return responder(res, 201, { ok: true, id, arquivo: gravado });
    }

    if (fotoId && (req.method === "DELETE" || req.method === "PUT")) {
      const foto = await Q.get("SELECT * FROM desenho_fotos WHERE id = ? AND desenho_id = ?", fotoId, desenhoId);
      if (!foto) return responder(res, 404, { error: "foto não encontrada" });

      if (req.method === "DELETE") {
        await Q.run("DELETE FROM desenho_fotos WHERE id = ?", fotoId);
        /* O arquivo sai junto com a linha. Guardar o arquivo de uma foto que
           ninguém mais vê só enche o disco com imagem que ninguém sabe de quem
           é — e, se for de um cliente que pediu para apagar, é pior que isso. */
        try { fs.unlinkSync(path.join(PASTA_FOTOS, foto.arquivo)); } catch {}
        return responder(res, 200, { ok: true });
      }

      const corpo = (await lerCorpo(req)) || {};
      const campos = {};
      if ("legenda" in corpo) campos.legenda = sanitizarHtml(String(corpo.legenda || ""));
      if ("ordem" in corpo) campos.ordem = Number(corpo.ordem) || 0;
      const cols = Object.keys(campos);
      if (!cols.length) return responder(res, 400, { error: "nada para alterar" });
      await Q.run(`UPDATE desenho_fotos SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        ...cols.map((c) => campos[c]), fotoId);
      return responder(res, 200, { ok: true });
    }
  }

  /* A foto em si. Exige sessão — é o motivo de ela não morar em `assets/`. */
  const mArquivo = /^\/restrito\/foto\/([A-Za-z0-9._-]+)$/.exec(caminho);
  if (mArquivo && req.method === "GET") {
    /* O nome vem da expressão acima, que não deixa passar `/` nem `..`; ainda
       assim o caminho é conferido depois de resolvido. Duas travas porque uma
       leitura de arquivo arbitrária vale o servidor inteiro. */
    const alvo = path.join(PASTA_FOTOS, mArquivo[1]);
    if (!path.resolve(alvo).startsWith(path.resolve(PASTA_FOTOS) + path.sep) || !fs.existsSync(alvo))
      return responder(res, 404, { error: "foto não encontrada" });
    const ext = path.extname(alvo).toLowerCase();
    res.writeHead(200, {
      "Content-Type": { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                        ".webp": "image/webp", ".avif": "image/avif" }[ext] || "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": "inline",
    });
    return res.end(fs.readFileSync(alvo));
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
    avisar("horarios");           /* alguém começou: a tela do escritório mostra na hora */
    return responder(res, 201, { ok: true, id });
  }

  const mJornada = /^\/restrito\/api\/jornadas\/(\d+)\/encerrar$/.exec(caminho);
  if (mJornada && req.method === "PUT") {
    const id = Number(mJornada[1]);
    const j = await Q.get("SELECT * FROM jornadas WHERE id = ?", id);
    if (!j) return responder(res, 404, { error: "jornada não encontrada" });
    if (Number(j.usuario_id) !== Number(sessao.usuarioId) && !ehAdmin(sessao))
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
    /* A tela de Horários do escritório fica aberta o dia inteiro. Sem este
       aviso, ela mostraria "em aberto" para quem já foi embora — e é
       justamente esse número que faz alguém ir atrás da pessoa. */
    avisar("horarios");
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

    /* As BATIDAS DE HOJE — o operador sai para o almoço, volta e bate de novo,
       e o dia dele vira dois ou três pares. Sem esta lista a tela mostraria
       "desde 13h20" e a manhã inteira sumiria da vista de quem trabalhou. */
    const periodos = await Q.all(
      `SELECT id, inicio, fim,
              EXTRACT(EPOCH FROM (COALESCE(fim, now()) - inicio))::bigint segundos
         FROM jornadas
        WHERE usuario_id = ? AND inicio::date = current_date
        ORDER BY inicio`, uid);
    const trabalhado = periodos.reduce(
      (s, p) => s + (p.fim ? Number(p.segundos) : 0), 0);

    return responder(res, 200, {
      jornada: jornada || null, ficha: ficha || null, fechadas, soma, periodos, trabalhado });
  }

  /* ======================================================================
     O MÊS DO OPERADOR — o calendário das próprias horas

     Ele vê SÓ AS DELE, e isso não é configuração: o `usuario_id` vem da SESSÃO,
     nunca da URL. Se viesse por parâmetro, trocar um número na barra de
     endereços mostraria a folha de ponto do colega — e horário de trabalho é
     dado de pessoa, não do sistema.

     A conta é a MESMA da tela do escritório, e de propósito: se o operador
     somasse de um jeito e o administrador de outro, a primeira divergência
     viraria discussão sobre quem está certo em vez de sobre a hora que faltou.
     Por isso o dia de hoje aqui também só entra depois de encerrado, e jornada
     aberta também vale zero.

     O mês vem INTEIRO, inclusive os dias sem batida: um calendário com buracos
     nos dias vazios não deixa ver que faltou justamente ali.
     ====================================================================== */
  if (caminho === "/restrito/api/meu-mes" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const pedido = String(url.searchParams.get("mes") || "").trim();
    const agora = await Q.get("SELECT current_date::text hoje, to_char(current_date, 'YYYY-MM') mes");
    /* Mês fora do formato vira o mês corrente em vez de erro: quem digita na
       barra de endereços erra, e uma tela em branco não ensina nada. */
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(pedido) ? pedido : agora.mes;

    const ano = Number(mes.slice(0, 4)), num = Number(mes.slice(5, 7));
    /* Dia 0 do mês SEGUINTE é o último deste — poupa a tabela de 30/31 e o
       fevereiro bissexto, que é onde essa conta costuma errar. */
    const ultimoDia = new Date(Date.UTC(ano, num, 0)).getUTCDate();
    const primeiro = mes + "-01";
    const ultimo = mes + "-" + String(ultimoDia).padStart(2, "0");

    const u = await Q.get("SELECT nome, usuario, expediente FROM usuarios WHERE id = ?", sessao.usuarioId);
    const batidas = await Q.all(
      `SELECT id, inicio, fim, inicio::date::text dia,
              EXTRACT(EPOCH FROM (COALESCE(fim, now()) - inicio))::bigint segundos,
              (fim IS NULL) aberta
         FROM jornadas
        WHERE usuario_id = ? AND inicio::date BETWEEN ?::date AND ?::date
        ORDER BY inicio`, sessao.usuarioId, primeiro, ultimo);

    const porDia = new Map();
    for (const b of batidas) {
      if (!porDia.has(b.dia)) porDia.set(b.dia, []);
      porDia.get(b.dia).push(b);
    }

    const dias = [];
    for (let d = 1; d <= ultimoDia; d++) {
      const dia = mes + "-" + String(d).padStart(2, "0");
      const minhas = porDia.get(dia) || [];
      const aberta = minhas.some((b) => b.aberta);
      const futuro = dia > agora.hoje;
      const ehHoje = dia === agora.hoje;
      /* Fechado só conta quando fechou. O resto da regra está no comentário de
         `saldoDoPeriodo` — aqui ela é aplicada dia a dia. */
      const trabalhado = minhas.reduce((s, b) => s + (b.fim ? Number(b.segundos) : 0), 0);
      const conta = !futuro && !(ehHoje && (!minhas.length || aberta));
      const previsto = conta ? previstoDoDia(u.expediente, new Date(dia + "T00:00:00Z").getUTCDay()) : null;
      dias.push({
        dia, futuro, hoje: ehHoje, aberta, conta,
        /* Dois números, e não um: `trabalhado` é o que o dia mostra — as horas
           existem mesmo no dia que ainda não fechou. `contado` é o que entra no
           saldo. Um número só obrigaria a escolher entre esconder a hora do dia
           de hoje ou contá-la antes do tempo. */
        trabalhado,
        contado: conta ? trabalhado : 0,
        previsto,
        saldo: conta && previsto !== null ? trabalhado - previsto : null,
        batidas: minhas.map((b) => ({
          id: b.id, inicio: b.inicio, fim: b.fim,
          segundos: Number(b.segundos), aberta: b.aberta,
        })),
      });
    }

    const comSaldo = dias.filter((x) => x.saldo !== null);
    return responder(res, 200, {
      mes, hoje: agora.hoje,
      operador: u.nome || u.usuario,
      expediente: u.expediente || null,
      dias,
      total: {
        trabalhado: dias.reduce((s, x) => s + x.contado, 0),
        previsto: comSaldo.reduce((s, x) => s + x.previsto, 0),
        saldo: comSaldo.length ? comSaldo.reduce((s, x) => s + x.saldo, 0) : null,
        diasComBatida: dias.filter((x) => x.batidas.length).length,
        abertas: dias.filter((x) => x.aberta).length,
      },
    });
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

    const desenho = await Q.get("SELECT id, pontuacao, preco, cliente_id FROM desenhos WHERE id = ? AND ativo", desenhoId);
    if (!desenho) return responder(res, 400, { error: "desenho não encontrado" });

    /* ------------------------------------------------------------------
       A DATA DO BORDADO — só o administrador, e só para trás

       A ficha nasce com a hora do relógio, e é assim que ela mede a produção
       de quem está na máquina agora. Mas o escritório também lança bordado
       que JÁ FOI FEITO: a nota antiga que ninguém registrou, o serviço avulso
       que veio por fora. Sem escolher a data, essa peça entra no relatório de
       HOJE — e o mês fechado passa a divergir do que foi produzido nele.

       SÓ PARA TRÁS, e a razão é de contabilidade: ficha no futuro apareceria
       num relatório antes de a peça existir, e não há caso legítimo para isso
       — só engano de digitação (2027 no lugar de 2026).

       O OPERADOR NÃO MANDA ESTE CAMPO. Se pudesse, a data da produção dele
       passaria a ser escolha dele, e a hora por peça — que é o indicador do
       chão de fábrica — mediria o que a pessoa digitou, não o que trabalhou.
       ------------------------------------------------------------------ */
    let abertaEm = null;
    let retroativa = false;
    if (corpo.aberta_em !== undefined && corpo.aberta_em !== null && String(corpo.aberta_em).trim() !== "") {
      if (!ehAdmin(sessao))
        return responder(res, 403, { error: "só o administrador escolhe a data do bordado" });
      const d = new Date(String(corpo.aberta_em));
      if (Number.isNaN(d.getTime()))
        return responder(res, 400, { error: "a data do bordado não é válida" });
      /* Uma folga de um dia porque a tela manda a hora local e o servidor
         compara em UTC: sem ela, lançar às 22h de hoje em Caruaru seria
         recusado como "futuro" por causa das três horas de diferença. */
      if (d.getTime() > Date.now() + 864e5)
        return responder(res, 400, { error: "a data do bordado não pode ser no futuro" });
      abertaEm = d.toISOString();
      retroativa = d.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10);
    }

    /* A PONTUAÇÃO É COPIADA DO DESENHO, e nunca vem do corpo da requisição.
       Se viesse, a tela poderia mandar qualquer número — e o valor da nota
       passaria a depender do que estava aberto no navegador. */
    const pontuacao = Number(desenho.pontuacao);

    /* O PREÇO SEGUE A MESMA REGRA, e por um motivo mais forte ainda: reajuste.
       Cópia na abertura significa que corrigir o preço de um desenho hoje não
       mexe em nada que já foi produzido. Se o valor viesse por join na hora de
       mostrar, o relatório do mês passado se reescreveria a cada reajuste —
       depois de a nota já ter sido emitida com o outro número.

       Nulo aqui é o desenho que ainda não foi precificado (tipicamente o que o
       próprio operador acabou de cadastrar). A ficha nasce sem valor e o
       administrador preenche na correção, junto com a precificação do desenho.
       O operador não vê nem manda este campo em momento nenhum. */
    const precoUnitario = desenho.preco === null || desenho.preco === undefined ? null : desenho.preco;

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
    /* FICHA RETROATIVA NÃO ABRE JORNADA e não entra em nenhuma.

       Jornada é hora de trabalho medida por relógio. Pendurar o lançamento de
       um bordado de três semanas atrás na jornada de hoje somaria ao dia do
       administrador um trabalho que não aconteceu agora — e o saldo de horas
       dele, que é o que se olha para pagar, passaria a contar digitação. */
    let jornada = null;
    if (!retroativa) {
      jornada = await Q.get("SELECT id FROM jornadas WHERE usuario_id = ? AND fim IS NULL", sessao.usuarioId);
      if (!jornada) {
        const jid = await Q.inserir("INSERT INTO jornadas (usuario_id) VALUES (?) RETURNING id", sessao.usuarioId);
        jornada = { id: jid };
      }
    }

    /* `COALESCE(?, now())` em vez de dois INSERT: sem a data escolhida o valor
       continua saindo do relógio do BANCO, que é o mesmo de sempre. Mandar
       `new Date()` do Node aqui trocaria calado a fonte da hora de todas as
       fichas do sistema. */
    const id = await Q.inserir(
      `INSERT INTO fichas (usuario_id, jornada_id, maquina_id, cliente_id, desenho_id,
                           pontuacao, preco_unitario, aberta_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?::timestamptz, now())) RETURNING id`,
      sessao.usuarioId, jornada ? jornada.id : null, maquinaId, clienteId, desenhoId,
      pontuacao, precoUnitario, abertaEm);
    /* A produção do dia mudou — a tela do escritório se atualiza sozinha. */
    avisar("fichas");
    return responder(res, 201, { ok: true, id, pontuacao });
  }

  /* ======================================================================
     SOMAR FICHAS — várias viram uma

     O caso real: o mesmo serviço foi bordado em três turnos, por três pessoas,
     e virou três fichas. Na nota, isso é UMA linha. Somar aqui é o que evita
     o cliente receber um recibo com o mesmo desenho repetido três vezes.

     A ARITMÉTICA, que é o assunto difícil desta rota
     ------------------------------------------------
     `total_pontos` e `total_valor` são colunas GERADAS pelo banco
     (quantidade × pontuação, quantidade × preço). Não existe caminho — nem por
     SQL direto — para gravar um total que não feche com a multiplicação. Foi
     uma trava posta de propósito, e ela morde aqui.

     Somando 10 peças de 1.000 pontos com 10 de 500, o total real é 15.000. Uma
     ficha de 20 peças com pontuação 1.000 daria 20.000; com 500, daria 10.000.
     Nenhuma das duas é 15.000.

     A saída é a MÉDIA PONDERADA: 15.000 ÷ 20 = 750 pontos/peça, e 20 × 750 dá
     exatamente 15.000. O número por peça deixa de ser "o ponto do desenho" e
     passa a ser "o ponto médio desta ficha somada" — que é o que ela é. Quando
     as fichas têm a mesma pontuação, a média é igual ao original e nada muda.

     Quando a divisão não é exata sobra um resto de poucos pontos (2 em 108 mil
     num caso real). A tela mostra esse resto ANTES de confirmar, e a coluna
     `soma_de` guarda o detalhe de cada parcela — sem ela, a média seria um
     número indefensável seis meses depois.

     NADA É APAGADO. As originais viram `situacao = 'somada'`, saem do lote e
     apontam para a nova. Some de todas as contas, continua no banco.
     ====================================================================== */
  if (caminho === "/restrito/api/fichas/somar" && req.method === "POST") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador soma fichas" });

    const corpo = (await lerCorpo(req)) || {};
    const ids = Array.isArray(corpo.ids)
      ? [...new Set(corpo.ids.map((x) => Number(x) | 0).filter((x) => x > 0))] : [];
    if (ids.length < 2) return responder(res, 400, { error: "escolha pelo menos duas fichas" });
    if (ids.length > 200) return responder(res, 400, { error: "no máximo 200 fichas de uma vez" });

    const fichas = await Q.all(
      `SELECT f.*, u.nome AS operador_nome, d.nome AS desenho_nome
         FROM fichas f
         JOIN usuarios u ON u.id = f.usuario_id
         JOIN desenhos d ON d.id = f.desenho_id
        WHERE f.id = ANY(?::bigint[])
        ORDER BY f.fechada_em, f.id`,
      "{" + ids.join(",") + "}");

    if (fichas.length !== ids.length) {
      return responder(res, 400, { error: "alguma ficha não existe mais. Recarregue a tela." });
    }
    /* SÓ FICHA CONCLUÍDA. Uma ficha aberta ainda não tem quantidade — somá-la
       seria somar um número que ainda não existe. */
    const naoFechada = fichas.find((f) => f.situacao !== "fechada");
    if (naoFechada) {
      return responder(res, 400, {
        error: `a ficha ${naoFechada.id} está "${naoFechada.situacao}". Só dá para somar fichas concluídas.` });
    }
    /* SÓ DO MESMO CLIENTE. São serviços diferentes, e o recibo é por cliente. */
    if (new Set(fichas.map((f) => String(f.cliente_id))).size > 1) {
      return responder(res, 400, { error: "as fichas são de clientes diferentes. Só dá para somar do mesmo cliente." });
    }
    /* E do mesmo lote: somar através de lotes moveria peças de uma nota para
       outra sem que nada na tela dissesse isso. */
    const lotes = new Set(fichas.map((f) => String(f.lote_id)));
    if (lotes.size > 1) {
      return responder(res, 400, { error: "as fichas estão em lotes diferentes." });
    }
    const loteId = fichas[0].lote_id;
    if (loteId) {
      const lote = await Q.get("SELECT situacao FROM lotes WHERE id = ?", loteId);
      if (lote && lote.situacao === "faturado") {
        return responder(res, 409, {
          error: "este lote já foi faturado e não aceita mais mudança de fichas." });
      }
    }

    const pecas = fichas.reduce((a, f) => a + Number(f.quantidade || 0), 0);
    const pontos = fichas.reduce((a, f) => a + Number(f.total_pontos || 0), 0);
    const valor = fichas.reduce((a, f) => a + Number(f.total_valor || 0), 0);
    if (pecas <= 0) return responder(res, 400, { error: "as fichas somam zero peça." });

    const pontuacao = Math.max(1, Math.round(pontos / pecas));
    /* O preço fica nulo quando NENHUMA parcela tinha preço — média de nada é
       nada, e gravar 0,00 diria "de graça" no lugar de "sem preço". */
    const temPreco = fichas.some((f) => f.preco_unitario !== null && f.preco_unitario !== undefined);
    const preco = temPreco ? Math.round((valor / pecas) * 100) / 100 : null;

    /* Campo que TODAS têm igual continua; campo que diverge vira nulo. Manter o
       valor de uma delas faria a ficha somada dizer "cor: azul" carregando as
       peças amarelas junto. */
    const mesmo = (campo) => {
      const s = new Set(fichas.map((f) => String(f[campo])));
      return s.size === 1 ? fichas[0][campo] : null;
    };
    const nomes = [...new Set(fichas.map((f) => f.operador_nome).filter(Boolean))];

    const detalhe = fichas.map((f) => ({
      id: f.id, operador: f.operador_nome, desenho: f.desenho_nome,
      pecas: Number(f.quantidade || 0), pontuacao: Number(f.pontuacao),
      preco: f.preco_unitario === null ? null : Number(f.preco_unitario),
      pontos: Number(f.total_pontos || 0), fechada_em: f.fechada_em,
    }));

    let novaId = null;
    /* TUDO NUMA TRANSAÇÃO. Sem ela, uma queda entre criar a nova e marcar as
       antigas deixaria as peças contadas DUAS vezes — na ficha nova e nas
       originais ainda fechadas. É o erro que ninguém percebe até a nota sair
       com o dobro. */
    await Q.tx(async () => {
      novaId = await Q.inserir(
        `INSERT INTO fichas
           (usuario_id, jornada_id, maquina_id, cliente_id, desenho_id, pontuacao,
            quantidade, mercadoria_id, cor_id, preco_unitario, observacao,
            aberta_em, fechada_em, situacao, lote_id, operadores, soma_de)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fechada', ?, ?, ?::jsonb)
         RETURNING id`,
        /* `jornada_id` NULO: a ficha somada é peça administrativa, não trabalho
           de uma jornada. As originais mantêm a jornada delas, então a produção
           de cada operador continua contada onde sempre esteve — e sem contar
           duas vezes, porque a tela de jornada não olha a ficha somada. */
        fichas[0].usuario_id, mesmo("maquina_id"), fichas[0].cliente_id,
        mesmo("desenho_id") || fichas[0].desenho_id, pontuacao, pecas,
        mesmo("mercadoria_id"), mesmo("cor_id"), preco,
        "Somada de " + fichas.length + " fichas: #" + fichas.map((f) => f.id).join(", #"),
        fichas[0].aberta_em, fichas[fichas.length - 1].fechada_em,
        loteId, nomes.join(", "), JSON.stringify(detalhe));

      await Q.run(
        `UPDATE fichas SET situacao = 'somada', lote_id = NULL, somada_em_id = ?
          WHERE id = ANY(?::bigint[])`,
        novaId, "{" + ids.join(",") + "}");
    });

    avisar("fichas");
    avisar("lotes");
    return responder(res, 201, {
      ok: true, id: novaId, pecas, pontos, pontuacao,
      /* A diferença de arredondamento volta para a tela poder mostrá-la. Zero
         quando a divisão fecha, que é o caso comum. */
      diferenca_pontos: pecas * pontuacao - pontos,
      absorvidas: ids.length,
    });
  }

  const mFicha = /^\/restrito\/api\/fichas\/(\d+)(?:\/(fechar|cancelar))?$/.exec(caminho);
  if (mFicha) {
    const id = Number(mFicha[1]);
    const acao = mFicha[2];
    const f = await Q.get("SELECT * FROM fichas WHERE id = ?", id);
    if (!f) return responder(res, 404, { error: "ficha não encontrada" });
    const minha = Number(f.usuario_id) === Number(sessao.usuarioId);
    if (!minha && !ehAdmin(sessao))
      return responder(res, 403, { error: "essa ficha não é sua" });

    if (acao === "fechar" && req.method === "PUT") {
      if (f.situacao !== "aberta") return responder(res, 409, { error: "essa ficha já foi fechada" });
      const corpo = (await lerCorpo(req)) || {};
      const qtd = Number(String(corpo.quantidade ?? "").replace(/\D/g, ""));
      if (!Number.isFinite(qtd) || qtd <= 0)
        return responder(res, 400, { error: "informe quantas peças foram feitas" });

      /* A ficha do operador é o pior lugar possível para um erro de driver:
         a peça já foi bordada e a quantidade já foi contada. */
      const refs = { mercadoria_id: corpo.mercadoria_id, cor_id: corpo.cor_id };
      const problemaRef = await conferirReferencias(refs);
      if (problemaRef) return responder(res, 409, { error: problemaRef, recarregar: true });

      /* ------------------------------------------------------------------
         A FICHA RETROATIVA FECHA NO DIA DELA, e não hoje.

         Toda a contagem de produção — o relatório, a quebra por período, a
         composição do lote — sai de `fechada_em` (ver `GET /api/producao`).
         Fechar com `now()` uma ficha que o administrador abriu com a data do
         mês passado jogaria a peça para o relatório de HOJE: exatamente o que
         escolher a data existe para evitar, e de um jeito silencioso, porque
         a ficha em si ficaria com a data certa no início.

         Só vale para quem começou em DIA ANTERIOR. A ficha normal, aberta e
         fechada no mesmo dia, continua fechando na hora do relógio — e é dela
         que sai o tempo por peça do chão de fábrica.
         ------------------------------------------------------------------ */
      await Q.run(
        `UPDATE fichas SET quantidade = ?, mercadoria_id = ?, cor_id = ?, observacao = ?,
                situacao = 'fechada',
                fechada_em = CASE WHEN aberta_em::date < now()::date THEN aberta_em ELSE now() END
          WHERE id = ?`,
        qtd,
        refs.mercadoria_id,
        refs.cor_id,
        sanitizarHtml(String(corpo.observacao || "")),
        id);
      const r = await Q.get("SELECT quantidade, pontuacao, total_pontos, aberta_em, fechada_em FROM fichas WHERE id = ?", id);
      avisar("fichas");
      return responder(res, 200, { ok: true, ficha: r });
    }

    if (acao === "cancelar" && req.method === "PUT") {
      if (f.situacao === "fechada" && !ehAdmin(sessao))
        return responder(res, 403, { error: "ficha já fechada — só o administrador cancela" });
      await Q.run("UPDATE fichas SET situacao = 'cancelada' WHERE id = ?", id);
      avisar("fichas");
      return responder(res, 200, { ok: true });
    }

    if (!acao && req.method === "PUT") {
      /* ------------------------------------------------------------------
         CORRIGIR A FICHA DO OPERADOR — só administrador

         É o número que vai virar nota, e a folha de papel que este sistema
         substituiu era corrigida a caneta o tempo todo. Fingir que a ficha
         digital é imutável não a torna correta: torna o conserto invisível,
         feito por fora, direto no banco.

         O QUE ENTROU AGORA: `aberta_em`, `fechada_em` e `preco_unitario`.

         A HORA é o conserto mais comum e o mais necessário. O operador
         esquece de fechar a ficha, lembra às 18h do que terminou às 14h, e o
         sistema grava quatro horas de trabalho que não existiram. Sem poder
         corrigir, o tempo por peça — que é o indicador do chão de fábrica —
         mede o esquecimento em vez da produção.

         O VALOR entra porque o desenho pode ter sido precificado DEPOIS da
         ficha: é exatamente o caso do desenho que o operador cadastrou no
         turno da noite. A ficha nasceu sem preço; o escritório precifica e
         corrige aqui.

         O DESENHO entra agora, e é a correção que o escritório mais pedia. O
         operador escolhe da lista no meio do turno e erra o vizinho — dois
         desenhos do mesmo cliente, nomes parecidos. Hoje a ficha inteira ia
         para o lixo e era refeita, perdendo a hora real de início e fim.

         TROCAR O DESENHO ARRASTA PONTUAÇÃO E PREÇO JUNTO, e isso não é
         conveniência: é o que torna a correção verdadeira. Os dois campos são
         CÓPIAS do desenho no momento da abertura (ver a rota de abrir). Trocar
         só o desenho deixaria a ficha dizendo "bordei o desenho A" enquanto
         conta os pontos e o dinheiro do desenho B — uma ficha internamente
         mentirosa, que é pior que a errada, porque parece certa.

         O administrador ainda pode mandar `pontuacao` ou `preco_unitario`
         explicitamente na mesma correção; nesse caso o que ele mandou vence.
         É o caso do desenho novo, ainda sem preço, que ele precifica na hora.

         O QUE CONTINUA FECHADO: quem bordou, em que máquina, de que cliente.
         Isso não é correção, é reescrever a história — e é o que faria a
         produção de uma pessoa virar a de outra.

         A ORDEM DO TEMPO é conferida pelo BANCO (`ck_ficha_ordem_do_tempo`),
         não só aqui. Fim antes do início não quebra nada visível: a peça
         continua contando, e o que fica negativo é a média do dia.
         ------------------------------------------------------------------ */
      if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador corrige ficha" });
      const corpo = (await lerCorpo(req)) || {};
      const campos = {};
      const inteiros = ["quantidade", "mercadoria_id", "cor_id", "pontuacao"];
      const horas = ["aberta_em", "fechada_em"];

      for (const c of inteiros) {
        if (!(c in corpo)) continue;
        const n = Number(String(corpo[c] ?? "").replace(/\D/g, ""));
        campos[c] = Number.isFinite(n) && String(corpo[c]).trim() !== "" ? n : null;
      }
      if ("observacao" in corpo) campos.observacao = sanitizarHtml(String(corpo.observacao || ""));
      if ("preco_unitario" in corpo) {
        try { campos.preco_unitario = dinheiro(corpo.preco_unitario, "o valor"); }
        catch (e) { return responder(res, 400, { error: e.message }); }
      }

      /* ------------------------------------------------------------------
         TROCA DE DESENHO — arrasta pontuação e preço do desenho NOVO.

         Os dois campos são cópias da abertura. Trocar só o desenho deixaria a
         ficha contando os pontos e o dinheiro do desenho antigo, o que é uma
         ficha internamente mentirosa — pior que a errada, porque parece certa.

         O que o administrador mandou explicitamente vence: por isso a cópia é
         feita ANTES de reaplicar `corpo`, e só nos campos que ele não enviou.

         O desenho tem de estar ATIVO. Um desenho arquivado é um que a fábrica
         tirou de circulação, e apontar uma ficha para ele agora é criar
         produção de algo que não se borda mais.
         ------------------------------------------------------------------ */
      if ("desenho_id" in corpo) {
        const novoId = Number(corpo.desenho_id) || 0;
        if (!novoId) return responder(res, 400, { error: "escolha o desenho" });
        if (novoId !== f.desenho_id) {
          const d = await Q.get("SELECT id, pontuacao, preco FROM desenhos WHERE id = ? AND ativo", novoId);
          if (!d) return responder(res, 400, { error: "desenho não encontrado ou fora de uso" });
          campos.desenho_id = d.id;
          if (!("pontuacao" in corpo)) campos.pontuacao = Number(d.pontuacao);
          if (!("preco_unitario" in corpo)) {
            campos.preco_unitario = d.preco === null || d.preco === undefined ? null : d.preco;
          }
        }
      }
      for (const c of horas) {
        if (!(c in corpo)) continue;
        const bruto = String(corpo[c] ?? "").trim();
        if (bruto === "") { campos[c] = null; continue; }
        /* `new Date` aceita quase tudo e devolve `Invalid Date` sem reclamar —
           que viraria NULL no banco e apagaria a hora em vez de corrigi-la. */
        const d = new Date(bruto);
        if (Number.isNaN(d.getTime()))
          return responder(res, 400, { error: `${c === "aberta_em" ? "o início" : "o fim"} não é uma data válida` });
        campos[c] = d.toISOString();
      }

      if (!Object.keys(campos).length) return responder(res, 400, { error: "nada para alterar" });
      if ("pontuacao" in campos && (!campos.pontuacao || campos.pontuacao <= 0))
        return responder(res, 400, { error: "a pontuação precisa ser maior que zero" });
      if ("quantidade" in campos && campos.quantidade !== null && campos.quantidade <= 0)
        return responder(res, 400, { error: "a quantidade precisa ser maior que zero" });

      /* Mesma conferência do fechar: a tela do escritório fica aberta o dia
         todo e é ainda mais provável que a lista dela esteja velha. */
      const problemaRef = await conferirReferencias(campos);
      if (problemaRef) return responder(res, 409, { error: problemaRef, recarregar: true });

      /* Conferido aqui TAMBÉM, e não só no banco, para a pessoa receber uma
         frase em vez de um erro de driver. A trava do banco é a que vale; esta
         é a que explica. Compara com o que a ficha TEM quando só um dos dois
         campos está sendo mexido — corrigir só o fim tem de bater com o
         início que já estava gravado. */
      const inicio = "aberta_em" in campos ? campos.aberta_em : f.aberta_em;
      const fim = "fechada_em" in campos ? campos.fechada_em : f.fechada_em;
      if (inicio && fim && new Date(fim) < new Date(inicio))
        return responder(res, 400, { error: "o fim não pode ser antes do início" });

      /* Ficha fechada sem hora de fim quebra a trava `ck_ficha_fechada` do
         banco. Barrar aqui evita a mensagem de driver e diz o que fazer. */
      if (f.situacao === "fechada" && "fechada_em" in campos && campos.fechada_em === null)
        return responder(res, 400, { error: "ficha fechada precisa da hora de fim — cancele-a se ela não deve contar" });

      const cols = Object.keys(campos);
      try {
        await Q.run(`UPDATE fichas SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
          ...cols.map((c) => campos[c]), id);
      } catch (e) {
        return responder(res, 400, { error: "a correção não foi aceita: confira as horas e a quantidade" });
      }
      avisar("fichas");
      return responder(res, 200, { ok: true, ficha: await Q.get("SELECT * FROM fichas WHERE id = ?", id) });
    }

    if (req.method === "GET") return responder(res, 200, f);
  }

  /* ======================================================================
     ADMINISTRATIVO — daqui para baixo, só administrador
     ====================================================================== */
  if (!ehAdmin(sessao)) return responder(res, 403, { error: "área do administrador" });

  /* ========================================================================
     AS GAVETAS DO CLIENTE

     A modal do cliente mostra três números — desenhos, lotes e peças. Cada um
     é um botão que abre a lista por trás dele SEM FECHAR A MODAL.

     Por que rotas separadas e não tudo dentro do `GET /clientes/:id`: a modal
     abre para conferir um telefone tanto quanto para investigar um ano de
     produção. Carregar as três listas sempre faria a abertura mais comum
     pagar pela mais rara — num cliente antigo, centenas de fichas de uma vez.
     Os TOTAIS vêm junto (são três contagens); as LISTAS só quando alguém pede.

     Desenhos não está aqui porque já existe: `GET /desenhos?cliente=<id>`,
     que é a mesma consulta com a mesma paginação e a mesma regra de preço.
     Uma segunda rota devolvendo desenho seria uma segunda regra de preço para
     alguém esquecer de repetir.
     ======================================================================== */
  const mGaveta = /^\/restrito\/api\/clientes\/(\d+)\/(lotes|fichas)$/.exec(caminho);
  if (mGaveta && req.method === "GET") {
    const clienteId = Number(mGaveta[1]);
    const url = new URL(req.url, "http://localhost");

    if (mGaveta[2] === "lotes") {
      /* Os totais saem das FICHAS, como em toda consulta de lote deste
         sistema — o lote não guarda soma. `valor` entra agora ao lado de
         `pecas` e `pontos`: é a coluna que o financeiro lê. */
      const lotes = await Q.all(
        `SELECT l.*,
                (SELECT COUNT(*) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS fichas,
                (SELECT COALESCE(SUM(f.quantidade),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pecas,
                (SELECT COALESCE(SUM(f.total_pontos),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pontos,
                (SELECT COALESCE(SUM(f.total_valor),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS valor
           FROM lotes l WHERE l.cliente_id = ?
          ORDER BY l.criado_em DESC LIMIT 300`, clienteId);

      /* O resumo financeiro do cliente, na mesma resposta. "Quanto este
         cliente já rendeu e quanto ainda deve" é a pergunta que a aba existe
         para responder, e somar 300 linhas no navegador daria um número
         diferente do que a próxima tela mostraria. */
      const conta = lotes.reduce((a, l) => {
        const v = Number(l.valor || 0);
        a.total += v;
        if (l.pago_em) { a.recebido += v; a.pagos++; } else { a.a_receber += v; a.abertos++; }
        return a;
      }, { total: 0, recebido: 0, a_receber: 0, pagos: 0, abertos: 0 });

      return responder(res, 200, { lotes, conta });
    }

    /* As fichas do cliente. Limite alto e ordem decrescente: quem abre isto
       quer ver o que foi feito por último. */
    const de = url.searchParams.get("de") || null;
    const ate = url.searchParams.get("ate") || null;
    const onde = ["f.cliente_id = ?", "f.situacao = 'fechada'"], args = [clienteId];
    if (de)  { onde.push("f.fechada_em::date >= ?::date"); args.push(de); }
    if (ate) { onde.push("f.fechada_em::date <= ?::date"); args.push(ate); }

    const fichas = await Q.all(
      `SELECT f.id, f.quantidade, f.pontuacao, f.total_pontos, f.preco_unitario, f.total_valor,
              f.aberta_em, f.fechada_em, f.observacao,
              d.nome AS desenho_nome, u.nome AS operador_nome,
              me.nome AS mercadoria_nome, co.nome AS cor_nome, l.codigo AS lote_codigo
         FROM fichas f
         JOIN desenhos d ON d.id = f.desenho_id
         JOIN usuarios u ON u.id = f.usuario_id
         LEFT JOIN mercadorias me ON me.id = f.mercadoria_id
         LEFT JOIN cores co ON co.id = f.cor_id
         LEFT JOIN lotes l ON l.id = f.lote_id
        WHERE ${onde.join(" AND ")}
        ORDER BY f.fechada_em DESC LIMIT 300`, ...args);

    const soma = fichas.reduce((a, f) => ({
      pecas: a.pecas + Number(f.quantidade || 0),
      pontos: a.pontos + Number(f.total_pontos || 0),
      valor: a.valor + Number(f.total_valor || 0),
    }), { pecas: 0, pontos: 0, valor: 0 });

    return responder(res, 200, { fichas, soma });
  }

  /* Consulta das fichas. É a tela que substitui o "juntar as folhas dos
     operadores": filtra por período, operador, cliente, e mostra o que ainda
     não foi amalgamado em lote nenhum.

     A LISTA tem teto; os TOTAIS não. Ver o bloco dos totais mais abaixo. */
  if (caminho === "/restrito/api/producao" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const de = url.searchParams.get("de") || null;
    const ate = url.searchParams.get("ate") || null;
    const usuarioId = Number(url.searchParams.get("usuario")) || null;
    const clienteId = Number(url.searchParams.get("cliente")) || null;
    const soltas = url.searchParams.get("soltas") === "1";

    const rec = recorteDaPagina(url, 20);
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
        ORDER BY f.fechada_em DESC LIMIT ${rec.por} OFFSET ${rec.offset}`, ...args);

    /* ------------------------------------------------------------------
       OS TOTAIS SAEM DO BANCO, NÃO DAS LINHAS DEVOLVIDAS

       Antes eram somados sobre as fichas da resposta — e a resposta tem teto.
       Enquanto a tela abria no DIA, o teto nunca era alcançado e a conta
       fechava. Agora a tela abre em TUDO: a primeira oficina com mais de 500
       fichas veria os totais pararem de crescer, calados, sempre no valor das
       500 últimas. Um número errado que não se apresenta como errado é pior
       que não ter número.

       Contando no banco, a soma é sobre o filtro INTEIRO. A lista continua
       com teto (ninguém lê dez mil linhas numa tela), mas aí é só a LISTA que
       está cortada — e a resposta diz isso em `truncado`, para a tela avisar
       em vez de deixar parecer que é tudo o que existe.
       ------------------------------------------------------------------ */
    const t = await Q.get(
      `SELECT COUNT(*) fichas,
              COALESCE(SUM(f.quantidade),0)   pecas,
              COALESCE(SUM(f.total_pontos),0) pontos,
              COALESCE(SUM(f.total_valor),0)  valor
         FROM fichas f WHERE ${onde.join(" AND ")}`, ...args);

    const soma = {
      pecas: Number(t.pecas), pontos: Number(t.pontos), valor: Number(t.valor),
    };
    const total = Number(t.fichas);

    /* Por operador, para responder "quem produziu o quê" sem a pessoa ter de
       somar a lista na cabeça — que é exatamente o trabalho que o papel dá.
       Também agrupado pelo BANCO, pelo mesmo motivo dos totais. */
    const linhasOp = await Q.all(
      `SELECT u.nome AS operador_nome, COUNT(*) fichas,
              COALESCE(SUM(f.quantidade),0) pecas, COALESCE(SUM(f.total_pontos),0) pontos
         FROM fichas f JOIN usuarios u ON u.id = f.usuario_id
        WHERE ${onde.join(" AND ")}
        GROUP BY u.nome ORDER BY 4 DESC`, ...args);

    const porOperador = {};
    for (const o of linhasOp) {
      porOperador[o.operador_nome || "?"] = {
        pecas: Number(o.pecas), pontos: Number(o.pontos), fichas: Number(o.fichas),
      };
    }

    /* ------------------------------------------------------------------
       O QUE ESTÁ NA MÁQUINA AGORA

       As fichas ABERTAS vêm à parte, e três decisões explicam por quê:

       1. FORA DA PAGINAÇÃO. "O que está rodando agora" não pode cair na
          página 3. Vêm todas, sempre — e cabem, porque o índice único
          parcial garante UMA ficha aberta por operador: o teto é o tamanho
          da equipe, não o do histórico.

       2. FORA DOS TOTAIS. Ficha aberta não tem quantidade — ela só é
          informada no fechamento. Somá-la como produção seria contar peça
          que ainda não existe, e o indicador de peças do período passaria a
          discordar do que a fábrica entregou.

       3. FORA DO FILTRO DE PERÍODO. O período é uma pergunta sobre o
          passado; ficha aberta é o presente. Escondê-la porque foi aberta
          fora do recorte esconderia justamente a mais importante: a que
          alguém abriu há três dias e esqueceu de fechar. Os filtros de
          operador, cliente e "fora de lote" continuam valendo, porque esses
          recortam QUEM/O QUÊ, não QUANDO.
       ------------------------------------------------------------------ */
    const ondeAbertas = ["f.situacao = 'aberta'"];
    const argsAbertas = [];
    if (usuarioId) { ondeAbertas.push("f.usuario_id = ?"); argsAbertas.push(usuarioId); }
    if (clienteId) { ondeAbertas.push("f.cliente_id = ?"); argsAbertas.push(clienteId); }
    if (soltas) ondeAbertas.push("f.lote_id IS NULL");

    const abertas = await Q.all(
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
        WHERE ${ondeAbertas.join(" AND ")}
        ORDER BY f.aberta_em ASC LIMIT 200`, ...argsAbertas);

    /* `total` sai da contagem do BANCO, não do tamanho da página — é ele que
       alimenta tanto os indicadores quanto a barra de paginação. */
    return responder(res, 200,
      Object.assign({ fichas, abertas, soma, porOperador }, envelope(total, rec)));
  }

  /* ---------------------------------------------------------- lotes ----- */
  /* ======================================================================
     FINANCEIRO
     ======================================================================

     lote → nota → lançamentos.

     A NOTA é do cliente: junta um ou mais lotes e vai sendo quitada aos
     poucos. O CAIXA é da fábrica: entra o que o cliente paga, sai o que a
     fábrica gasta. Os dois vivem na mesma tabela `lancamentos`, com a nota
     como coluna opcional — dinheiro que entra e dinheiro que sai são o mesmo
     tipo de fato, o que muda é o sinal e o motivo.

     O VALOR DA NOTA NÃO É GUARDADO. Ele é somado dos lotes, que somam as
     fichas, na hora de responder. Guardar um total criaria um segundo lugar
     para a mesma verdade, e no dia em que uma ficha fosse corrigida a nota
     continuaria dizendo o valor antigo sem que nada avisasse.
     ====================================================================== */

  /* Uma nota inteira, com valor, pagamentos e saldo. Monta UMA vez e serve à
     lista, ao detalhe e ao recibo — pelo mesmo motivo do `detalheDoLote`: se
     cada tela somasse por conta própria, o papel que o cliente leva embora
     poderia discordar da tela onde a cobrança foi conferida. */
  async function contaDaNota(nota) {
    const lotes = await Q.all(
      `SELECT l.*,
              (SELECT COALESCE(SUM(f.total_valor), 0) FROM fichas f
                WHERE f.lote_id = l.id AND f.situacao = 'fechada') AS valor,
              (SELECT COALESCE(SUM(f.quantidade), 0) FROM fichas f
                WHERE f.lote_id = l.id AND f.situacao = 'fechada') AS pecas
         FROM lotes l JOIN nota_lotes nl ON nl.lote_id = l.id
        WHERE nl.nota_id = ? ORDER BY l.codigo`, nota.id);

    const lancamentos = await Q.all(
      `SELECT la.*, u.nome AS quem
         FROM lancamentos la LEFT JOIN usuarios u ON u.id = la.criado_por
        WHERE la.nota_id = ? ORDER BY la.ocorrido_em, la.id`, nota.id);

    const bruto = lotes.reduce((a, l) => a + Number(l.valor || 0), 0);
    const valor = bruto - Number(nota.desconto || 0) + Number(nota.acrescimo || 0);
    /* Lançamento cancelado não entra em conta nenhuma — mas continua na lista,
       riscado, porque um recibo entregue precisa de lastro mesmo depois de
       estornado. */
    const vivos = lancamentos.filter((l) => !l.cancelado_em);
    const pago = vivos.filter((l) => l.tipo === "entrada").reduce((a, l) => a + Number(l.valor), 0);
    const devolvido = vivos.filter((l) => l.tipo === "saida").reduce((a, l) => a + Number(l.valor), 0);
    /* Devolução AUMENTA o que falta: o dinheiro voltou para o cliente, então
       ele deve de novo. Somar em vez de subtrair aqui é o erro que faz a nota
       aparecer quitada depois de um estorno. */
    const saldo = Math.round((valor - pago + devolvido) * 100) / 100;

    return {
      nota, lotes, lancamentos,
      bruto, valor, pago, devolvido, saldo,
      pecas: lotes.reduce((a, l) => a + Number(l.pecas || 0), 0),
      /* Quitada é CALCULADO, nunca guardado: uma coluna "paga" poderia
         discordar da soma dos pagamentos, e a soma é que é verdade. */
      quitada: nota.situacao !== "cancelada" && saldo <= 0.004,
      vencida: nota.situacao !== "cancelada" && saldo > 0.004
               && !!nota.vencimento && emIso(nota.vencimento) < hojeIso(),
    };
  }

  /* ---------------------------------------------------------- listar notas */
  if (caminho === "/restrito/api/notas" && req.method === "GET") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador vê o financeiro" });
    const url = new URL(req.url, "http://localhost");
    const clienteId = Number(url.searchParams.get("cliente")) || null;
    const de = url.searchParams.get("de") || null;
    const ate = url.searchParams.get("ate") || null;
    const situacao = String(url.searchParams.get("s") || "");

    const cond = ["1=1"]; const args = [];
    if (clienteId) { cond.push("n.cliente_id = ?"); args.push(clienteId); }
    if (de) { cond.push("n.emitida_em >= ?"); args.push(de); }
    if (ate) { cond.push("n.emitida_em <= ?"); args.push(ate); }

    const rec = recorteDaPagina(url, 30);
    const linhas = await Q.all(
      `SELECT n.*, c.nome AS cliente_nome FROM notas n
         JOIN clientes c ON c.id = n.cliente_id
        WHERE ${cond.join(" AND ")}
        ORDER BY n.emitida_em DESC, n.id DESC`, ...args);

    /* A conta é feita por nota e depois filtrada. Filtrar "quitada" no SQL
       exigiria repetir a fórmula do saldo lá dentro — e duas fórmulas para o
       mesmo número é como elas passam a discordar. */
    const contas = [];
    for (const n of linhas) contas.push(await contaDaNota(n));
    const filtradas = !situacao ? contas
      : situacao === "quitada" ? contas.filter((x) => x.quitada)
      : situacao === "vencida" ? contas.filter((x) => x.vencida)
      : situacao === "aberta" ? contas.filter((x) => !x.quitada && x.nota.situacao !== "cancelada")
      : situacao === "cancelada" ? contas.filter((x) => x.nota.situacao === "cancelada")
      : contas;

    const pagina = filtradas.slice(rec.offset, rec.offset + rec.por);
    return responder(res, 200, Object.assign({
      itens: pagina.map((x) => ({
        id: x.nota.id, codigo: x.nota.codigo, cliente_nome: x.nota.cliente_nome,
        cliente_id: x.nota.cliente_id, numero_nf: x.nota.numero_nf,
        emitida_em: x.nota.emitida_em, vencimento: x.nota.vencimento,
        situacao: x.nota.situacao, lotes: x.lotes.length, pecas: x.pecas,
        valor: x.valor, pago: x.pago, devolvido: x.devolvido, saldo: x.saldo,
        quitada: x.quitada, vencida: x.vencida,
      })),
      resumo: {
        valor: filtradas.reduce((a, x) => a + (x.nota.situacao === "cancelada" ? 0 : x.valor), 0),
        pago: filtradas.reduce((a, x) => a + x.pago, 0),
        saldo: filtradas.reduce((a, x) => a + (x.nota.situacao === "cancelada" ? 0 : Math.max(0, x.saldo)), 0),
        vencidas: filtradas.filter((x) => x.vencida).length,
      },
    }, envelope(filtradas.length, rec)));
  }

  /* ------------------------------------------------------------ criar nota */
  if (caminho === "/restrito/api/notas" && req.method === "POST") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador cria nota" });
    const corpo = (await lerCorpo(req)) || {};
    const clienteId = Number(corpo.cliente_id) || null;
    const loteIds = Array.isArray(corpo.lotes)
      ? [...new Set(corpo.lotes.map((x) => Number(x) | 0).filter(Boolean))] : [];
    if (!clienteId) return responder(res, 400, { error: "escolha o cliente" });
    if (!loteIds.length) return responder(res, 400, { error: "escolha ao menos um lote" });

    const lotes = await Q.all(
      "SELECT id, cliente_id, codigo FROM lotes WHERE id = ANY(?::bigint[])",
      "{" + loteIds.join(",") + "}");
    if (lotes.length !== loteIds.length) {
      return responder(res, 400, { error: "algum lote não existe mais. Recarregue a tela." });
    }
    if (lotes.some((l) => Number(l.cliente_id) !== clienteId)) {
      return responder(res, 400, { error: "há lote de outro cliente na seleção." });
    }
    /* Um lote em duas notas é o mesmo serviço cobrado duas vezes — e a segunda
       cobrança pareceria tão legítima quanto a primeira. A UNIQUE do banco já
       barra; aqui a mensagem diz QUAL lote e em que nota ele está. */
    const jaEm = await Q.all(
      `SELECT l.codigo, n.codigo AS nota FROM nota_lotes nl
         JOIN lotes l ON l.id = nl.lote_id JOIN notas n ON n.id = nl.nota_id
        WHERE nl.lote_id = ANY(?::bigint[])`, "{" + loteIds.join(",") + "}");
    if (jaEm.length) {
      return responder(res, 409, {
        error: "já está em nota: " + jaEm.map((x) => `${x.codigo} (${x.nota})`).join(", ") });
    }

    const ano = new Date().getFullYear();
    const r = await Q.get(
      `SELECT COALESCE(MAX(split_part(codigo, '-', 3)::int), 0) AS n
         FROM notas WHERE codigo ~ ?`, `^NOTA-${ano}-[0-9]+$`);
    const codigo = `NOTA-${ano}-${String(Number(r?.n || 0) + 1).padStart(4, "0")}`;

    let id = null;
    await Q.tx(async () => {
      id = await Q.inserir(
        /* `COALESCE(?, CURRENT_DATE)` e não a data do Node: o resto do sistema
           inteiro decide "hoje" pelo `current_date` do Postgres, e o servidor
           roda em UTC enquanto a fábrica trabalha em UTC−3. Depois das 21h as
           duas respostas divergem, e a nota nasceria datada de amanhã. */
        `INSERT INTO notas (codigo, cliente_id, numero_nf, emitida_em, vencimento, observacao)
         VALUES (?,?,?, COALESCE(?::date, CURRENT_DATE), ?,?) RETURNING id`,
        codigo, clienteId, String(corpo.numero_nf || "").trim(),
        corpo.emitida_em || null,
        corpo.vencimento || null, sanitizarHtml(String(corpo.observacao || "")));
      for (const l of loteIds) {
        await Q.run("INSERT INTO nota_lotes (nota_id, lote_id) VALUES (?, ?)", id, l);
      }
    });
    avisar("notas");
    return responder(res, 201, { ok: true, id, codigo });
  }

  /* ---------------------------------------------------------- uma nota só */
  const mNota = /^\/restrito\/api\/notas\/(\d+)$/.exec(caminho);
  if (mNota) {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador vê o financeiro" });
    const id = Number(mNota[1]);
    const nota = await Q.get(
      `SELECT n.*, c.nome AS cliente_nome, c.documento, c.telefone, c.cidade
         FROM notas n JOIN clientes c ON c.id = n.cliente_id WHERE n.id = ?`, id);
    if (!nota) return responder(res, 404, { error: "nota não encontrada" });

    if (req.method === "GET") return responder(res, 200, await contaDaNota(nota));

    if (req.method === "PUT") {
      const corpo = (await lerCorpo(req)) || {};
      const campos = {};
      if ("numero_nf" in corpo) campos.numero_nf = String(corpo.numero_nf || "").trim().slice(0, 40);
      if ("vencimento" in corpo) campos.vencimento = corpo.vencimento || null;
      if ("emitida_em" in corpo && corpo.emitida_em) campos.emitida_em = corpo.emitida_em;
      if ("observacao" in corpo) campos.observacao = sanitizarHtml(String(corpo.observacao || ""));
      for (const k of ["desconto", "acrescimo"]) {
        if (k in corpo) {
          try { campos[k] = dinheiro(corpo[k], "o " + k) || "0.00"; }
          catch (e) { return responder(res, 400, { error: e.message }); }
        }
      }
      if ("situacao" in corpo) {
        if (!["aberta", "cancelada"].includes(corpo.situacao)) {
          return responder(res, 400, { error: "situação inválida" });
        }
        /* Cancelar nota que já recebeu dinheiro esconderia um pagamento que
           existe. Estorne primeiro; a devolução fica registrada. */
        if (corpo.situacao === "cancelada") {
          const c = await contaDaNota(nota);
          if (c.pago > 0) {
            return responder(res, 409, {
              error: "esta nota já recebeu pagamento. Estorne antes de cancelar." });
          }
        }
        campos.situacao = corpo.situacao;
      }
      if (!Object.keys(campos).length) return responder(res, 400, { error: "nada para salvar" });
      campos.alterado_em = new Date().toISOString();
      await Q.run("UPDATE notas SET " + Object.keys(campos).map((k) => k + " = ?").join(", ") +
        " WHERE id = ?", ...Object.values(campos), id);
      avisar("notas");
      return responder(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      const c = await contaDaNota(nota);
      if (c.lancamentos.length) {
        return responder(res, 409, {
          error: "esta nota tem lançamentos. Cancele-a em vez de apagar." });
      }
      /* Apagar a nota desfaz o VÍNCULO com os lotes (ON DELETE CASCADE em
         nota_lotes), não o trabalho: os lotes voltam a ficar disponíveis. */
      await Q.run("DELETE FROM notas WHERE id = ?", id);
      avisar("notas");
      return responder(res, 200, { ok: true });
    }
  }

  /* ------------------------------------------- trocar os lotes de uma nota */
  const mNotaLotes = /^\/restrito\/api\/notas\/(\d+)\/lotes$/.exec(caminho);
  if (mNotaLotes && req.method === "PUT") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador mexe na nota" });
    const id = Number(mNotaLotes[1]);
    const nota = await Q.get("SELECT * FROM notas WHERE id = ?", id);
    if (!nota) return responder(res, 404, { error: "nota não encontrada" });
    const corpo = (await lerCorpo(req)) || {};
    const querem = Array.isArray(corpo.lotes)
      ? [...new Set(corpo.lotes.map((x) => Number(x) | 0).filter(Boolean))] : [];
    if (!querem.length) return responder(res, 400, { error: "a nota precisa de ao menos um lote" });

    const lotes = await Q.all(
      "SELECT id, cliente_id FROM lotes WHERE id = ANY(?::bigint[])", "{" + querem.join(",") + "}");
    if (lotes.length !== querem.length ||
        lotes.some((l) => Number(l.cliente_id) !== Number(nota.cliente_id))) {
      return responder(res, 400, { error: "há lote inválido ou de outro cliente na seleção." });
    }
    const conflito = await Q.all(
      `SELECT l.codigo, n.codigo AS nota FROM nota_lotes nl
         JOIN lotes l ON l.id = nl.lote_id JOIN notas n ON n.id = nl.nota_id
        WHERE nl.lote_id = ANY(?::bigint[]) AND nl.nota_id <> ?`,
      "{" + querem.join(",") + "}", id);
    if (conflito.length) {
      return responder(res, 409, {
        error: "já está em outra nota: " + conflito.map((x) => `${x.codigo} (${x.nota})`).join(", ") });
    }

    /* Reconcilia em vez de acumular: a tela manda a lista COMPLETA e o
       servidor acerta. Clicar duas vezes não duplica nada. */
    await Q.tx(async () => {
      await Q.run("DELETE FROM nota_lotes WHERE nota_id = ?", id);
      for (const l of querem) await Q.run("INSERT INTO nota_lotes (nota_id, lote_id) VALUES (?, ?)", id, l);
    });
    avisar("notas");
    return responder(res, 200, { ok: true });
  }

  /* ---------------------------------------------------- lançar no caixa */
  if (caminho === "/restrito/api/lancamentos" && req.method === "POST") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador lança no caixa" });
    const corpo = (await lerCorpo(req)) || {};

    const categoria = String(corpo.categoria || "").trim();
    const CATEGORIAS_NOTA = ["recebimento", "devolucao"];
    const tipo = CATEGORIAS_NOTA.includes(categoria)
      ? (categoria === "recebimento" ? "entrada" : "saida")
      : (corpo.tipo === "entrada" ? "entrada" : "saida");

    let valor;
    try { valor = dinheiro(corpo.valor, "o valor"); }
    catch (e) { return responder(res, 400, { error: e.message }); }
    if (!valor || Number(valor) <= 0) return responder(res, 400, { error: "informe um valor maior que zero" });

    let notaId = null, clienteId = null, recibo = null, funcionarioId = null;
    if (CATEGORIAS_NOTA.includes(categoria)) {
      notaId = Number(corpo.nota_id) || null;
      if (!notaId) return responder(res, 400, { error: "escolha a nota" });
      const nota = await Q.get("SELECT * FROM notas WHERE id = ?", notaId);
      if (!nota) return responder(res, 404, { error: "nota não encontrada" });
      if (nota.situacao === "cancelada") {
        return responder(res, 409, { error: "esta nota está cancelada." });
      }
      clienteId = nota.cliente_id;

      const c = await contaDaNota(nota);
      /* PAGAR MAIS QUE O SALDO é quase sempre erro de digitação — um zero a
         mais. Barrar com o número na mensagem é mais útil que aceitar e deixar
         a nota com saldo negativo, que ninguém sabe ler.
         Uma folga de um centavo cobre arredondamento de parcela. */
      if (categoria === "recebimento" && Number(valor) > c.saldo + 0.01) {
        return responder(res, 400, {
          error: `o saldo desta nota é de R$ ${c.saldo.toFixed(2).replace(".", ",")}. ` +
                 `Não dá para receber R$ ${Number(valor).toFixed(2).replace(".", ",")}.` });
      }
      /* DEVOLVER mais do que entrou também não fecha: sairia dinheiro que
         nunca chegou. */
      if (categoria === "devolucao" && Number(valor) > c.pago - c.devolvido + 0.01) {
        return responder(res, 400, {
          error: `só entraram R$ ${(c.pago - c.devolvido).toFixed(2).replace(".", ",")} nesta nota. ` +
                 "Não dá para devolver mais que isso." });
      }

      const ano = new Date().getFullYear();
      const r = await Q.get(
        `SELECT COALESCE(MAX(split_part(recibo, '-', 3)::int), 0) AS n
           FROM lancamentos WHERE recibo ~ ?`, `^RC-${ano}-[0-9]+$`);
      recibo = `RC-${ano}-${String(Number(r?.n || 0) + 1).padStart(4, "0")}`;
    } else {
      /* Despesa da fábrica não tem nota, e a trava do banco garante isso. */
      if (!String(corpo.descricao || "").trim()) {
        return responder(res, 400, { error: "descreva a despesa" });
      }

      /* A QUEM foi paga. Quem decide se a categoria pede um nome é a PRÓPRIA
         categoria (`pede_funcionario`), não um `if (categoria === "Salários")`
         escrito aqui: a lista é cadastrável pela tela, e no dia em que alguém
         renomeasse "Salários" para "Folha" o campo sumiria sem erro nenhum. */
      const cat = await Q.get(
        "SELECT pede_funcionario FROM categorias_despesa WHERE nome = ?", categoria);
      const pede = !!(cat && cat.pede_funcionario);
      const quem = Number(corpo.funcionario_id) || null;

      if (pede && !quem) {
        return responder(res, 400, { error: `a categoria "${categoria}" precisa do funcionário.` });
      }
      /* E o contrário também é recusado: aceitar um funcionário numa conta de
         luz encheria o relatório da folha de linhas que não são folha. */
      if (!pede && quem) {
        return responder(res, 400, {
          error: `a categoria "${categoria}" não recebe funcionário.` });
      }
      if (quem) {
        const f = await Q.get(
          "SELECT id, ativo, papel FROM usuarios WHERE id = ? AND papel <> 'dono'", quem);
        if (!f) return responder(res, 404, { error: "funcionário não encontrado" });
        /* Desligado ainda RECEBE — rescisão e último salário são pagos depois
           da saída. O que não pode é ele sumir da lista antes de ser pago. */
        funcionarioId = quem;
      }
    }

    const id = await Q.inserir(
      `INSERT INTO lancamentos (tipo, categoria, nota_id, cliente_id, funcionario_id, valor, forma,
                                ocorrido_em, descricao, recibo, criado_por)
       VALUES (?,?,?,?,?,?,?, COALESCE(?::date, CURRENT_DATE), ?,?,?) RETURNING id`,
      tipo, categoria || "outra", notaId, clienteId, funcionarioId, valor,
      String(corpo.forma || "pix").slice(0, 30),
      corpo.ocorrido_em || null,
      sanitizarHtml(String(corpo.descricao || "")).slice(0, 500),
      recibo, sessao.usuarioId);

    avisar("notas"); avisar("caixa");
    return responder(res, 201, { ok: true, id, recibo });
  }

  /* ----------------------------------------------------- cancelar lançamento */
  const mCancelaLanc = /^\/restrito\/api\/lancamentos\/(\d+)\/cancelar$/.exec(caminho);
  if (mCancelaLanc && req.method === "PUT") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador cancela lançamento" });
    const id = Number(mCancelaLanc[1]);
    const l = await Q.get("SELECT * FROM lancamentos WHERE id = ?", id);
    if (!l) return responder(res, 404, { error: "lançamento não encontrado" });
    if (l.cancelado_em) return responder(res, 200, { ok: true, jaEstava: true });
    const corpo = (await lerCorpo(req)) || {};
    const motivo = String(corpo.motivo || "").trim();
    /* O motivo é OBRIGATÓRIO. Um cancelamento sem motivo, seis meses depois, é
       indistinguível de um erro de operação — e é justamente o registro que
       alguém vai procurar quando a conta não fechar. */
    if (motivo.length < 3) return responder(res, 400, { error: "escreva o motivo do cancelamento" });

    /* NÃO se apaga: marca. Um recibo já entregue precisa continuar tendo
       lastro no sistema mesmo depois de estornado. */
    await Q.run(
      `UPDATE lancamentos SET cancelado_em = now(), cancelado_por = ?, motivo_cancelamento = ?
        WHERE id = ?`, sessao.usuarioId, motivo.slice(0, 300), id);
    avisar("notas"); avisar("caixa");
    return responder(res, 200, { ok: true });
  }

  /* ------------------------------------------------------------ o caixa */
  if (caminho === "/restrito/api/caixa" && req.method === "GET") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador vê o caixa" });
    const url = new URL(req.url, "http://localhost");
    /* Mês corrente por padrão. `emIso` e não `toISOString`: o primeiro dia do
       mês é construído na meia-noite LOCAL, e converter para UTC devolveria o
       último dia do mês anterior a oeste de Greenwich — o caixa abriria com um
       dia a mais e um dia a menos. */
    const hoje = new Date();
    const de = url.searchParams.get("de") || emIso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const ate = url.searchParams.get("ate") || hojeIso();
    const tipo = url.searchParams.get("tipo");

    const cond = ["la.ocorrido_em BETWEEN ? AND ?"]; const args = [de, ate];
    if (tipo === "entrada" || tipo === "saida") { cond.push("la.tipo = ?"); args.push(tipo); }

    /* `?funcionario=` — a folha de uma pessoa só. É a pergunta que se faz na
       hora de conferir "quanto já paguei a ela este mês". */
    const doFuncionario = Number(url.searchParams.get("funcionario")) || null;
    if (doFuncionario) { cond.push("la.funcionario_id = ?"); args.push(doFuncionario); }

    const rec = recorteDaPagina(url, 40);
    const itens = await Q.all(
      `SELECT la.*, u.nome AS quem, c.nome AS cliente_nome, n.codigo AS nota_codigo,
              f.nome AS funcionario_nome
         FROM lancamentos la
         LEFT JOIN usuarios u ON u.id = la.criado_por
         LEFT JOIN clientes c ON c.id = la.cliente_id
         LEFT JOIN notas n ON n.id = la.nota_id
         LEFT JOIN usuarios f ON f.id = la.funcionario_id
        WHERE ${cond.join(" AND ")}
        ORDER BY la.ocorrido_em DESC, la.id DESC
        LIMIT ? OFFSET ?`, ...args, rec.por, rec.offset);

    const total = await Q.get(
      `SELECT COUNT(*) c FROM lancamentos la WHERE ${cond.join(" AND ")}`, ...args);

    /* O resumo é do PERÍODO INTEIRO, não da página. Somar só o que está na
       tela daria um saldo que muda ao virar de página. E o cancelado fica de
       fora: ele aparece na lista, riscado, e não conta. */
    const soma = await Q.get(
      `SELECT
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'entrada' AND cancelado_em IS NULL), 0) entradas,
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'saida'   AND cancelado_em IS NULL), 0) saidas
         FROM lancamentos la WHERE ${cond.join(" AND ")}`, ...args);

    const porCategoria = await Q.all(
      `SELECT categoria, tipo, COALESCE(SUM(valor), 0) valor, COUNT(*)::int n
         FROM lancamentos la
        WHERE ${cond.join(" AND ")} AND la.cancelado_em IS NULL
        GROUP BY categoria, tipo ORDER BY valor DESC`, ...args);

    /* Quanto foi para cada pessoa no período. A quebra por CATEGORIA responde
       "quanto de salário"; esta responde "de quem" — e é a que alguém procura
       quando um funcionário pergunta o que já recebeu no mês. */
    const porFuncionario = await Q.all(
      `SELECT f.id, f.nome, la.categoria, COALESCE(SUM(la.valor), 0) valor, COUNT(*)::int n
         FROM lancamentos la JOIN usuarios f ON f.id = la.funcionario_id
        WHERE ${cond.join(" AND ")} AND la.cancelado_em IS NULL
        GROUP BY f.id, f.nome, la.categoria ORDER BY valor DESC`, ...args);

    /* `categorias` sai como OBJETO e não como lista de nomes: a tela precisa
       saber quais pedem funcionário, e devolver isso num segundo campo
       paralelo criaria duas listas para manter em acordo. */
    const categorias = await Q.all(
      "SELECT nome, pede_funcionario FROM categorias_despesa WHERE ativo ORDER BY ordem, nome");

    /* Quem pode aparecer na caixinha de funcionário. Inativo ENTRA: rescisão e
       último salário são pagos depois do desligamento, e sumir da lista antes
       disso impediria justamente o pagamento que fecha o vínculo. */
    const funcionarios = await Q.all(
      "SELECT id, nome, ativo FROM usuarios WHERE papel <> 'dono' ORDER BY ativo DESC, nome");

    return responder(res, 200, Object.assign({
      itens, porCategoria, porFuncionario, funcionarios,
      categorias: categorias.map((c) => ({ nome: c.nome, pedeFuncionario: !!c.pede_funcionario })),
      de, ate,
      resumo: {
        entradas: Number(soma.entradas), saidas: Number(soma.saidas),
        saldo: Number(soma.entradas) - Number(soma.saidas),
      },
    }, envelope(Number(total.c), rec)));
  }

  if (caminho === "/restrito/api/lotes" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const situacao = url.searchParams.get("situacao");
    const onde = [], args = [];
    if (situacao) { onde.push("l.situacao = ?"); args.push(situacao); }

    /* `?pago=0` é a lista de cobrança: o que já saiu e ainda não entrou. É a
       consulta que o índice parcial `ix_lotes_a_receber` existe para servir. */
    const pago = url.searchParams.get("pago");
    if (pago === "0") onde.push("l.pago_em IS NULL");
    if (pago === "1") onde.push("l.pago_em IS NOT NULL");
    const doCliente = Number(url.searchParams.get("cliente")) || null;
    if (doCliente) { onde.push("l.cliente_id = ?"); args.push(doCliente); }

    /* `?semNota=1` — os lotes que ainda podem entrar numa nota.
       A tela de nova nota oferece SÓ estes: um lote já cobrado noutra nota
       apareceria como disponível e a criação falharia no servidor. Melhor não
       oferecer do que oferecer e recusar depois de escolhido. */
    if (url.searchParams.get("semNota") === "1") {
      onde.push("NOT EXISTS (SELECT 1 FROM nota_lotes nl WHERE nl.lote_id = l.id)");
    }

    /* Os totais saem das FICHAS, por subconsulta — o lote não guarda soma.
       Guardar criaria duas verdades, e a errada seria justamente a que alguém
       leria na hora de fazer a nota. */
    const rec = recorteDaPagina(url, 20);
    const clausula = onde.length ? "WHERE " + onde.join(" AND ") : "";

    /* Contado antes da página, sobre o mesmo filtro: é o que a barra usa para
       saber quantas páginas existem, e o que o caixa usa para não somar só a
       página que está na tela. */
    const tot = await Q.get(`SELECT COUNT(*) c FROM lotes l ${clausula}`, ...args);

    const lotes = await Q.all(
      `SELECT l.*, c.nome AS cliente_nome,
              (SELECT COUNT(*) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS fichas,
              (SELECT COALESCE(SUM(f.quantidade),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pecas,
              (SELECT COALESCE(SUM(f.total_pontos),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS pontos,
              (SELECT COALESCE(SUM(f.total_valor),0) FROM fichas f WHERE f.lote_id = l.id AND f.situacao='fechada') AS valor
         FROM lotes l JOIN clientes c ON c.id = l.cliente_id
        ${clausula}
        ORDER BY l.criado_em DESC LIMIT ${rec.por} OFFSET ${rec.offset}`, ...args);

    /* ------------------------------------------------------------------
       O CAIXA É DE TODOS OS LOTES DO FILTRO, NÃO DA PÁGINA

       Somar as linhas da página daria um "a receber" que muda quando alguém
       vira a página — e o número que interessa a esta tela é justamente quanto
       ainda tem de entrar no total. Por isso a soma desce para o banco.
       ------------------------------------------------------------------ */
    const cx = await Q.get(
      `SELECT COALESCE(SUM(v.valor),0) total,
              COALESCE(SUM(CASE WHEN l.pago_em IS NOT NULL THEN v.valor ELSE 0 END),0) recebido,
              COALESCE(SUM(CASE WHEN l.pago_em IS NULL     THEN v.valor ELSE 0 END),0) a_receber,
              COUNT(*) FILTER (WHERE l.pago_em IS NOT NULL) pagos,
              COUNT(*) FILTER (WHERE l.pago_em IS NULL)     abertos
         FROM lotes l
         JOIN clientes c ON c.id = l.cliente_id
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(f.total_valor),0) valor FROM fichas f
            WHERE f.lote_id = l.id AND f.situacao = 'fechada') v
        ${clausula}`, ...args);

    const conta = {
      total: Number(cx.total), recebido: Number(cx.recebido), a_receber: Number(cx.a_receber),
      pagos: Number(cx.pagos), abertos: Number(cx.abertos),
    };

    return responder(res, 200, Object.assign({ lotes, conta }, envelope(Number(tot.c), rec)));
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

    if (req.method === "GET") return responder(res, 200, await detalheDoLote(lote));

    if (req.method === "PUT") {
      const corpo = (await lerCorpo(req)) || {};
      const campos = {};
      for (const c of ["descricao", "quantidade_prevista", "entrada_em", "situacao", "nota", "observacao", "pago_em"]) {
        if (!(c in corpo)) continue;
        if (c === "quantidade_prevista") {
          const s = String(corpo[c] ?? "").replace(/\D/g, "");
          campos[c] = s === "" ? null : Number(s);
        } else if (c === "observacao") campos[c] = sanitizarHtml(String(corpo[c] || ""));
        else if (c === "entrada_em" || c === "pago_em") campos[c] = corpo[c] || null;
        else campos[c] = String(corpo[c] ?? "").trim();
      }
      if (campos.situacao && !["aberto", "fechado", "faturado"].includes(campos.situacao))
        return responder(res, 400, { error: "situação inválida" });
      /* Faturar sem número da nota deixa o lote "faturado" sem como achar a
         nota depois — que é justamente o que se vai procurar meses adiante. */
      if (campos.situacao === "faturado" && !(campos.nota || lote.nota))
        return responder(res, 400, { error: "informe o número da nota antes de marcar como faturado" });

      /* --------------------------------------------------------------
         PAGO É UM FATO À PARTE DE FATURADO

         `pago_em` NÃO mexe em `situacao`, e é a coisa mais importante deste
         bloco. A tentação é marcar "pago" e mover o lote para um estado
         final — mas aí "faturado e ainda não pago", que é o normal do mês
         inteiro e a razão de existir da cobrança, deixa de ter resposta.

         O que se confere é a ORDEM: não existe dinheiro recebido de um lote
         que ainda está aberto na produção. Marcar pago um lote aberto é
         quase sempre clique na linha errada da lista — e o estrago sai
         calado, porque o lote continua parecendo normal em toda tela.
         -------------------------------------------------------------- */
      if (campos.pago_em) {
        const situacaoFinal = campos.situacao || lote.situacao;
        if (situacaoFinal === "aberto")
          return responder(res, 400, {
            error: "esse lote ainda está aberto na produção — feche-o antes de marcar como pago",
          });
        const d = new Date(campos.pago_em);
        if (Number.isNaN(d.getTime()))
          return responder(res, 400, { error: "a data do pagamento não é válida" });
      }

      const cols = Object.keys(campos);
      if (!cols.length) return responder(res, 400, { error: "nada para alterar" });
      await Q.run(`UPDATE lotes SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        ...cols.map((c) => campos[c]), id);
      avisar("lotes");
      return responder(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      if (lote.situacao === "faturado")
        return responder(res, 409, { error: "lote já faturado — não pode ser apagado" });

      /* Lote só sai VAZIO. Antes ele soltava as fichas sozinho e se apagava — o
         que é conveniente e errado: quem clica em "apagar" num lote com 40
         fichas dentro não está pensando nas 40, está pensando no lote. Desfazer
         a composição tem de ser um ato à parte, em "Juntar fichas", onde se vê
         o que está sendo desfeito. */
      const vinculos = await vinculosDe("lotes", id);
      if (vinculos.length) {
        return responder(res, 409, {
          error: `Não dá para apagar: o lote tem ${textoVinculos(vinculos)} dentro. ` +
                 "Tire as fichas em “Juntar fichas” e apague depois.",
          vinculos,
        });
      }

      await Q.run("DELETE FROM lotes WHERE id = ?", id);
      return responder(res, 200, { ok: true, excluido: true });
    }
  }

  /* ========================================================================
     USUÁRIOS — e a conta que não está aqui

     A conta de DONO não aparece nesta lista, não é criada, alterada,
     desativada, apagada nem tem senha redefinida por tela nenhuma. Ela existe
     para consertar o sistema quando pedirem, e some do dia a dia.

     ESCONDER NÃO É PROTEGER, e é por isso que as duas coisas estão aqui. Se a
     conta apenas sumisse da lista, o administrador continuaria podendo mandar
     `DELETE /restrito/api/usuarios/1` — e o id 1 é o primeiro palpite de
     qualquer um. Uma conta invisível e apagável é pior que uma conta visível:
     ninguém veria o estrago até precisar dela.

     PROMOÇÃO PELA ROTA também não passa: o `papel` é conferido contra uma
     lista de dois valores, e é essa conferência — não a ausência de um botão
     na tela — que impede um administrador de se promover a dono e sumir da
     própria lista de usuários.

     A trava do "último administrador ativo" continua contando SÓ `admin`. O
     dono não entra na conta de propósito: rebaixar o último admin e ficar só
     com a conta de manutenção deixaria a fábrica sem escritório, e a saída
     seria justamente chamar o dono — que é o que se quer evitar precisar.
     ======================================================================== */

  /* Alvo de qualquer rota que mexe em usuário. Devolve o papel para as rotas
     recusarem o dono num lugar só, em vez de cada uma repetir a consulta. */
  async function alvoUsuario(id) {
    return await Q.get("SELECT id, usuario, nome, papel, ativo FROM usuarios WHERE id = ?", id);
  }

  /* ======================================================================
     HORÁRIOS — quem começou, quem terminou, quanto tempo ficou aberto

     A jornada é o relógio da pessoa; a ficha é o que ela bordou. Esta tela
     olha só o relógio, e existe porque as duas perguntas do escritório não
     tinham resposta em lugar nenhum: "quantas horas o fulano fez esta
     semana?" e, sobretudo, "tem alguém com jornada aberta desde ontem?".

     O TEMPO ABERTO É CALCULADO NO SERVIDOR, e não no navegador. O relógio do
     celular da bancada erra em minutos e às vezes em fuso — e uma jornada
     "aberta há 9 horas" que na verdade tem 3 manda o escritório atrás de uma
     pessoa que está trabalhando normalmente.

     `EXTRACT(EPOCH …)` devolve segundos; a tela formata. Mandar já formatado
     daqui obrigaria a somar textos do outro lado.
     ====================================================================== */
  if (caminho === "/restrito/api/horarios" && req.method === "GET") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador vê os horários" });

    const url = new URL(req.url, "http://localhost");
    const de = String(url.searchParams.get("de") || "").trim();
    const ate = String(url.searchParams.get("ate") || "").trim();
    const usuarioId = Number(url.searchParams.get("usuario_id")) || null;

    const cond = ["u.papel <> 'dono'"];
    const args = [];
    /* O filtro é pelo DIA do início, e não pelo instante: quem digita
       "de 01/08 até 05/08" quer o dia 5 inteiro, não até a meia-noite dele. */
    if (de) { cond.push("j.inicio >= ?"); args.push(de + " 00:00:00"); }
    if (ate) { cond.push("j.inicio <= ?"); args.push(ate + " 23:59:59"); }
    if (usuarioId) { cond.push("j.usuario_id = ?"); args.push(usuarioId); }
    const clausula = "WHERE " + cond.join(" AND ");

    const rec = recorteDaPagina(url, 30);
    const itens = await Q.all(
      `SELECT j.id, j.usuario_id, j.inicio, j.fim, j.observacao,
              u.nome AS operador, u.usuario AS login, u.expediente,
              EXTRACT(EPOCH FROM (COALESCE(j.fim, NOW()) - j.inicio))::bigint AS segundos,
              (j.fim IS NULL) AS aberta,
              (SELECT COUNT(*) FROM fichas f WHERE f.jornada_id = j.id AND f.situacao <> 'cancelada') AS fichas,
              (SELECT COALESCE(SUM(f.quantidade), 0) FROM fichas f
                 WHERE f.jornada_id = j.id AND f.situacao <> 'cancelada') AS pecas
         FROM jornadas j JOIN usuarios u ON u.id = j.usuario_id
        ${clausula}
        ORDER BY j.inicio DESC
        LIMIT ? OFFSET ?`, ...args, rec.por, rec.offset);

    const total = await Q.get(
      `SELECT COUNT(*) c FROM jornadas j JOIN usuarios u ON u.id = j.usuario_id ${clausula}`, ...args);

    /* O RESUMO vem do banco, não da soma da página. Somar só o que está na
       tela daria um total que muda ao virar de página — e é o total do
       período que o escritório anota. */
    const resumo = await Q.get(
      `SELECT COUNT(*) c,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(j.fim, NOW()) - j.inicio))), 0)::bigint segundos,
              COUNT(*) FILTER (WHERE j.fim IS NULL) abertas
         FROM jornadas j JOIN usuarios u ON u.id = j.usuario_id ${clausula}`, ...args);

    /* AS ABERTAS VÊM FORA DA PAGINAÇÃO **E FORA DO PERÍODO**.
       O aviso vermelho da tela dizia "1 jornada aberta" com o resumo logo
       abaixo dizendo 2: ele contava só as que caíram na página aberta. E o
       caso pior nem aparecia — a jornada esquecida há dez dias fica fora de
       "últimos 7 dias", que é justamente o recorte padrão. A informação mais
       urgente da tela não pode depender de qual página se está vendo nem de
       qual data se escolheu. É uma consulta pequena por construção: o banco só
       permite uma aberta por pessoa. */
    const abertas = await Q.all(
      `SELECT j.id, j.inicio, u.nome AS operador, u.usuario AS login,
              EXTRACT(EPOCH FROM (now() - j.inicio))::bigint AS segundos
         FROM jornadas j JOIN usuarios u ON u.id = j.usuario_id
        WHERE j.fim IS NULL AND u.papel <> 'dono'` +
        (usuarioId ? " AND j.usuario_id = ?" : "") +
        " ORDER BY j.inicio", ...(usuarioId ? [usuarioId] : []));

    return responder(res, 200, Object.assign(
      { itens, resumo, abertas, saldos: await saldoDoPeriodo({ de, ate, usuarioId }) },
      envelope(Number(total.c), rec)));
  }

  /* Corrigir a jornada. Mesmo espírito da correção de ficha: o operador
     esquece de bater o fim, e uma jornada aberta desde ontem envenena o total
     de horas de todo relatório que a inclua — para sempre, porque ela nunca
     fecha sozinha. */
  const mCorrigirJornada = /^\/restrito\/api\/horarios\/(\d+)$/.exec(caminho);
  if (mCorrigirJornada && req.method === "PUT") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador corrige horário" });
    const id = Number(mCorrigirJornada[1]);
    const j = await Q.get("SELECT * FROM jornadas WHERE id = ?", id);
    if (!j) return responder(res, 404, { error: "jornada não encontrada" });

    const corpo = (await lerCorpo(req)) || {};
    const campos = {};
    for (const c of ["inicio", "fim"]) {
      if (!(c in corpo)) continue;
      const bruto = String(corpo[c] ?? "").trim();
      if (bruto === "") {
        /* Só o FIM pode ficar em branco — é a jornada reaberta. Início vazio
           deixaria a jornada sem começo, e o cálculo do tempo sem base. */
        if (c === "inicio") return responder(res, 400, { error: "a jornada precisa da hora de início" });
        campos.fim = null; continue;
      }
      const d = new Date(bruto);
      if (Number.isNaN(d.getTime()))
        return responder(res, 400, { error: `${c === "inicio" ? "o início" : "o fim"} não é uma data válida` });
      campos[c] = d.toISOString();
    }
    if ("observacao" in corpo) campos.observacao = sanitizarHtml(String(corpo.observacao || ""));
    if (!Object.keys(campos).length) return responder(res, 400, { error: "nada para alterar" });

    const inicio = "inicio" in campos ? campos.inicio : j.inicio;
    const fim = "fim" in campos ? campos.fim : j.fim;
    if (inicio && fim && new Date(fim) < new Date(inicio))
      return responder(res, 400, { error: "o fim não pode ser antes do início" });

    /* Reabrir esbarra na trava de uma jornada aberta por pessoa. Explicar aqui
       poupa a violação de índice, que chega na tela como erro de driver. */
    if ("fim" in campos && campos.fim === null) {
      const outra = await Q.get(
        "SELECT id FROM jornadas WHERE usuario_id = ? AND fim IS NULL AND id <> ?", j.usuario_id, id);
      if (outra) return responder(res, 409, {
        error: "esta pessoa já tem outra jornada aberta — feche aquela antes de reabrir esta." });
    }

    const cols = Object.keys(campos);
    try {
      await Q.run(`UPDATE jornadas SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
        ...cols.map((c) => campos[c]), id);
    } catch (e) {
      return responder(res, 400, { error: "a correção não foi aceita: confira as horas" });
    }
    avisar("horarios");
    return responder(res, 200, { ok: true });
  }

  if (caminho === "/restrito/api/usuarios" && req.method === "GET") {
    const itens = await Q.all(
      "SELECT id, usuario, nome, papel, ativo, criado_em, expediente FROM usuarios WHERE papel <> 'dono' ORDER BY nome, usuario");
    return responder(res, 200, { itens });
  }
  if (caminho === "/restrito/api/usuarios" && req.method === "POST") {
    const corpo = (await lerCorpo(req)) || {};
    const usuario = String(corpo.usuario || "").trim().toLowerCase();
    const papel = String(corpo.papel || "operador");

    if (!/^[a-z][a-z0-9._-]{2,31}$/.test(usuario))
      return responder(res, 400, {
        error: "o login começa com letra e tem de 3 a 32 caracteres (a-z, 0-9, ponto, hífen ou _)",
        campo: "usuario",
      });
    if (!["admin", "operador"].includes(papel)) return responder(res, 400, { error: "papel inválido" });

    if (await Q.get("SELECT id FROM usuarios WHERE usuario = ?", usuario))
      return responder(res, 409, { error: `já existe alguém com o login "${usuario}"`, campo: "usuario" });

    /* A SENHA É GERADA, NUNCA DIGITADA por quem cadastra. Um administrador com
       sete operadores para criar põe "123456" em todos, e o sistema que separa
       a produção de cada um passa a não separar nada. */
    let expediente = null;
    try { const e = lerExpediente(corpo.expediente); expediente = e === null ? null : JSON.stringify(e); }
    catch (e) { return responder(res, 400, { error: e.message, campo: "expediente" }); }

    const senha = senhaProvisoria();
    const id = await Q.inserir(
      `INSERT INTO usuarios (usuario, nome, senha_hash, papel, senha_provisoria, expediente)
       VALUES (?,?,?,?,TRUE,?) RETURNING id`,
      usuario, String(corpo.nome || usuario).trim(), gerarHash(senha), papel, expediente);

    /* A senha volta UMA vez, para a tela mostrar e a pessoa anotar. Não fica
       guardada em lugar nenhum além do hash — nem eu nem o administrador
       conseguem lê-la depois. */
    return responder(res, 201, { ok: true, id, usuario, senha });
  }

  const mSenhaUsuario = /^\/restrito\/api\/usuarios\/(\d+)\/senha$/.exec(caminho);
  if (mSenhaUsuario && req.method === "POST") {
    const id = Number(mSenhaUsuario[1]);
    const u = await alvoUsuario(id);
    if (!u) return responder(res, 404, { error: "usuário não encontrado" });
    /* 404, e não 403: para quem está do lado de fora, a conta de dono não
       existe. Um 403 aqui confirmaria o id dela a quem estivesse procurando. */
    if (u.papel === "dono") return responder(res, 404, { error: "usuário não encontrado" });

    const senha = senhaProvisoria();
    await Q.run("UPDATE usuarios SET senha_hash = ?, senha_provisoria = TRUE WHERE id = ?",
      gerarHash(senha), id);

    /* Redefinir derruba as sessões da pessoa. É o caso "perdi o celular" ou
       "desconfio que alguém entrou": deixar a sessão viva anularia a redefinição. */
    for (const [k, s] of sessoes) if (s.usuarioId === id) sessoes.delete(k);
    return responder(res, 200, { ok: true, usuario: u.usuario, senha });
  }

  const mUsuario = /^\/restrito\/api\/usuarios\/(\d+)$/.exec(caminho);
  if (mUsuario && req.method === "PUT") {
    const id = Number(mUsuario[1]);
    const quem = await alvoUsuario(id);
    if (!quem) return responder(res, 404, { error: "usuário não encontrado" });
    if (quem.papel === "dono") return responder(res, 404, { error: "usuário não encontrado" });

    const corpo = (await lerCorpo(req)) || {};
    const campos = {};
    if ("papel" in corpo) {
      /* `dono` não está na lista, e é aqui que a promoção pela rota morre:
         sem esta conferência, um administrador viraria dono mandando o papel
         no corpo — e passaria a ser invisível na própria lista de usuários. */
      if (!["admin", "operador"].includes(corpo.papel)) return responder(res, 400, { error: "papel inválido" });
      campos.papel = corpo.papel;
    }
    if ("ativo" in corpo) campos.ativo = !!corpo.ativo;
    if ("nome" in corpo) campos.nome = String(corpo.nome || "").trim();
    if ("expediente" in corpo) {
      /* JSONB entra como TEXTO no driver. Mandar o objeto direto grava a string
         "[object Object]" — que passa pelo CHECK do banco (é JSON válido? não,
         nem isso) e some sem erro na tela. */
      try { const e = lerExpediente(corpo.expediente); campos.expediente = e === null ? null : JSON.stringify(e); }
      catch (e) { return responder(res, 400, { error: e.message, campo: "expediente" }); }
    }
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

  if (mUsuario && req.method === "DELETE") {
    const id = Number(mUsuario[1]);
    const alvo = await alvoUsuario(id);
    if (!alvo) return responder(res, 404, { error: "usuário não encontrado" });
    if (alvo.papel === "dono") return responder(res, 404, { error: "usuário não encontrado" });

    /* Ninguém apaga a si mesmo: a sessão continuaria viva apontando para um id
       que não existe mais, e a próxima tela quebraria sem dizer por quê. */
    if (Number(id) === Number(sessao.usuarioId))
      return responder(res, 409, { error: "você não pode excluir a sua própria conta" });

    /* Conta que JÁ PRODUZIU não sai: a ficha diz quem bordou, e é isso que
       separa a produção de cada um. Sem o nome, o relatório do mês passado
       passa a ter peça sem dono. */
    const vinculos = await vinculosDe("usuarios", id);
    if (vinculos.length) {
      return responder(res, 409, {
        error: `Não dá para excluir: ${alvo.usuario} tem ${textoVinculos(vinculos)}. ` +
               "Desative a conta — ela deixa de entrar e continua no que já foi produzido.",
        vinculos, podeDesativar: true,
      });
    }

    /* O último administrador ativo não sai nem por exclusão. A trava já existia
       para "desativar" e "rebaixar"; sem ela aqui, o mesmo estrago sairia pela
       outra porta — e a saída seria mexer no banco à mão. */
    if (alvo.papel === "admin" && alvo.ativo) {
      const outros = await Q.get(
        "SELECT COUNT(*) c FROM usuarios WHERE papel = 'admin' AND ativo AND id <> ?", id);
      if (Number(outros.c) === 0)
        return responder(res, 409, { error: "este é o último administrador ativo — promova outro antes." });
    }

    await Q.run("DELETE FROM usuarios WHERE id = ?", id);
    /* E derruba a sessão de quem foi apagado, se estiver aberta em algum lugar. */
    for (const [k, s] of sessoes) if (s.usuarioId === id) sessoes.delete(k);
    return responder(res, 200, { ok: true, excluido: true });
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

  /* O RECIBO DO LOTE — página feita para sair na impressora e ser assinada.
     Abre em aba própria justamente para o "imprimir" do navegador pegar o
     recibo, e não o sistema inteiro em volta dele. */
  /* O RECIBO DE PAGAMENTO — o papel que o cliente leva embora.

     Ele é por LANÇAMENTO, e não por nota: o cliente que pagou três vezes tem
     três recibos, cada um com o que pagou naquele dia e quanto ficou faltando
     DEPOIS daquele pagamento. Um recibo por nota diria só o total, e o cliente
     que pagou R$ 1.000 de R$ 8.000 sairia com um papel de R$ 8.000 na mão. */
  const mReciboPg = /^\/restrito\/lancamentos\/(\d+)\/recibo$/.exec(caminho);
  if (mReciboPg && req.method === "GET") {
    if (!ehAdmin(sessao)) return responder(res, 403, { error: "só o administrador imprime recibo" });
    const l = await Q.get(
      `SELECT la.*, u.nome AS quem, n.codigo AS nota_codigo, n.numero_nf,
              c.nome AS cliente_nome, c.documento, c.telefone, c.cidade
         FROM lancamentos la
         LEFT JOIN usuarios u ON u.id = la.criado_por
         LEFT JOIN notas n ON n.id = la.nota_id
         LEFT JOIN clientes c ON c.id = la.cliente_id
        WHERE la.id = ?`, Number(mReciboPg[1]));
    if (!l || !l.nota_id) return responder(res, 404, { error: "recibo não encontrado" });

    const nota = await Q.get("SELECT * FROM notas WHERE id = ?", l.nota_id);
    const conta = await contaDaNota(nota);

    /* O SALDO DO RECIBO É O DAQUELE MOMENTO, não o de agora.
       Um recibo impresso hoje e reimpresso mês que vem tem de dizer a mesma
       coisa — senão o papel que o cliente guardou deixa de bater com o papel
       que a fábrica reimprime, e não há como saber qual dos dois vale. Por
       isso a conta considera só os lançamentos ATÉ ESTE, pelo id. */
    const ateAqui = conta.lancamentos.filter((x) => !x.cancelado_em && x.id <= l.id);
    const pagoAte = ateAqui.filter((x) => x.tipo === "entrada").reduce((a, x) => a + Number(x.valor), 0);
    const devolvidoAte = ateAqui.filter((x) => x.tipo === "saida").reduce((a, x) => a + Number(x.valor), 0);
    const faltavaDepois = Math.round((conta.valor - pagoAte + devolvidoAte) * 100) / 100;

    return responder(res, 200, reciboDePagamento({
      lancamento: l, nota, conta, pagoAte, faltavaDepois,
    }, empresa, { agora: new Date(), porQuem: sessao.nome || sessao.usuario }),
    { "Content-Type": "text/html; charset=utf-8" });
  }

  const mRecibo = /^\/restrito\/lotes\/(\d+)\/recibo$/.exec(caminho);
  if (mRecibo && req.method === "GET") {
    const lote = await Q.get(
      `SELECT l.*, c.nome AS cliente_nome FROM lotes l JOIN clientes c ON c.id = l.cliente_id WHERE l.id = ?`,
      Number(mRecibo[1]));
    if (!lote) return responder(res, 404, { error: "lote não encontrado" });

    const dados = await detalheDoLote(lote);
    dados.cliente = await Q.get(
      "SELECT nome, documento, telefone, email, cidade FROM clientes WHERE id = ?", lote.cliente_id);

    const orientacao = new URL(req.url, "http://localhost").searchParams.get("orientacao") === "paisagem"
      ? "paisagem" : "retrato";
    const html = reciboDoLote(dados, empresa, {
      orientacao,
      agora: new Date(),
      /* Quem emitiu fica no rodapé. Recibo é documento: meses depois, "quem
         imprimiu isto" é a primeira pergunta quando o número não bate. */
      porQuem: sessao.nome || sessao.usuario,
    });
    return responder(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
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
  rotas, sessaoDe, gerarHash, conferirSenha, prepararCadastro, senhaProvisoria, conferirSenhaNova,
  CADASTROS,
};
