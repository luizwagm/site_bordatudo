/* ==========================================================================
   BORDA TUDO — site e gerenciador

   O site é ESTÁTICO. O painel grava no banco; publicar reescreve o HTML entre
   marcadores `<!--#CHAVE-->…<!--/CHAVE-->`. Quem visita recebe arquivo pronto:
   sem consulta a banco, sem espera, e com uma superfície de ataque que é
   basicamente a do nginx.

       src/molde-*.html   ← é aqui que se mexe no layout
              ↓ publicar
       index.html, servicos/, vitrine/, ...   ← o que o visitante recebe

   Mexer no `index.html` gerado é trabalho perdido: a próxima publicação
   sobrescreve.
   ========================================================================== */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { abrirBanco } = require("./db");
const { criarLimitador } = require("./limitador");
const { agendarBackups } = require("./backup");
const { carregarAmbiente } = require("./pg");
const restrito = require("./restrito");

/* PGPASSWORD e DADOS_CHAVE saem do `.env` (ou de /etc/bordatudo.env no
   servidor). Tem de ser ANTES de qualquer consulta ao Postgres. */
carregarAmbiente(__dirname);

const APP_VERSION = "1.7.0";
const PORTA = Number(process.env.PORT) || 5193;
const HOST = process.env.HOST || "127.0.0.1";
const RAIZ = __dirname;
/* O caminho do banco é configurável para a SUÍTE poder subir o servidor contra
   um banco descartável. Sem isso, testar o painel exigiria a senha do cliente —
   e eu não leio senha de cliente. */
const ARQ_BANCO = process.env.SITE_DB || path.join(RAIZ, "data", "site.db");

const SITE = {
  nome: "Borda Tudo",
  nomeCompleto: "Borda Tudo — Bordados Computadorizados",
  cidade: "Caruaru",
  uf: "PE",
  base: process.env.SITE_BASE || "https://bordatudo.com",
};

/* ==========================================================================
   1. BANCO
   ========================================================================== */
fs.mkdirSync(path.dirname(ARQ_BANCO), { recursive: true });
const db = abrirBanco(ARQ_BANCO);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS servicos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo    TEXT NOT NULL,
    resumo    TEXT NOT NULL DEFAULT '',
    aplicacao TEXT NOT NULL DEFAULT '',
    material  TEXT NOT NULL DEFAULT '',
    limite    TEXT NOT NULL DEFAULT '',
    icone     TEXT NOT NULL DEFAULT 'ponto',
    ordem     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pecas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo    TEXT NOT NULL,
    categoria TEXT NOT NULL DEFAULT '',
    tecnica   TEXT NOT NULL DEFAULT '',
    material  TEXT NOT NULL DEFAULT '',
    pontos    TEXT NOT NULL DEFAULT '',
    imagem    TEXT NOT NULL DEFAULT '',
    alt       TEXT NOT NULL DEFAULT '',
    /* Preparado e DESLIGADO. O preço de bordado depende de pontos, cores e
       quantidade — número fixo aqui mentiria. Fica pronto para o dia em que
       houver item de linha própria com valor fechado. */
    preco     REAL,
    destaque  INTEGER NOT NULL DEFAULT 0,
    ordem     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS depoimentos (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    nome   TEXT NOT NULL,
    papel  TEXT NOT NULL DEFAULT '',
    texto  TEXT NOT NULL DEFAULT '',
    nota   INTEGER NOT NULL DEFAULT 5,
    ordem  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS duvidas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    pergunta  TEXT NOT NULL,
    resposta  TEXT NOT NULL DEFAULT '',
    ordem     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS visitas (
    dia   TEXT PRIMARY KEY,
    total INTEGER NOT NULL DEFAULT 0
  );

  /* O IP nunca é gravado em claro — vira hash com um sal desta instalação.
     Serve para não contar a mesma pessoa duas vezes no dia, e nada além. */
  CREATE TABLE IF NOT EXISTS visitantes (
    dia  TEXT NOT NULL,
    marca TEXT NOT NULL,
    PRIMARY KEY (dia, marca)
  );
`);

/* ==========================================================================
   2. SENHA

   scrypt com sal por instalação. `HASH_ISCA` existe para o caso de senha
   inexistente: sem ele, "conta que não existe" responde mais rápido que
   "senha errada", e o tempo de resposta vira um oráculo.
   ========================================================================== */
const HASH_ISCA = crypto.scryptSync("isca", "isca", 64).toString("hex");

function gerarHash(senha) {
  const sal = crypto.randomBytes(16).toString("hex");
  return `${sal}:${crypto.scryptSync(senha, sal, 64).toString("hex")}`;
}
function conferirSenha(senha, guardado) {
  const [sal, esperado] = String(guardado || `x:${HASH_ISCA}`).split(":");
  let calculado;
  try { calculado = crypto.scryptSync(senha, sal, 64).toString("hex"); }
  catch { return false; }
  const a = Buffer.from(calculado, "hex");
  const b = Buffer.from(esperado || HASH_ISCA, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ==========================================================================
   3. CONTEÚDO INICIAL

   Escrito para o público que o site atende primeiro: fabricante de confecção.
   Os números estão marcados com `0` ou vazio de propósito — número inventado
   em site institucional é passivo, não enfeite.
   ========================================================================== */
const PADROES = {
  /* --- identidade --- */
  cnpj: "0",
  whatsapp: "5581997740959",
  email: "",
  instagram: "https://www.instagram.com/bordatudo",
  endereco: "Caruaru, Pernambuco",
  maps: "",
  horario: "Segunda a sexta, 8h às 18h · Sábado, 8h às 12h",

  /* --- topo --- */
  heroi_rotulo: "Bordado computadorizado · Caruaru-PE",
  heroi_titulo: "Bordado que sai <mark>igual</mark> na peça 1 e na peça 800.",
  heroi_lead: "Atendemos confecção do Agreste com bordado digitalizado, ponto conferido e prazo combinado por escrito. Sua etiqueta, seu logotipo, sua coleção — na mesma medida, do primeiro ao último lote.",
  heroi_botao: "Pedir orçamento",
  heroi_botao2: "Ver trabalhos",
  heroi_imagem: "/assets/img/vitrine/cones-prateleira.jpg",
  heroi_imagem_alt: "Cones de linha na gaiola de uma máquina de bordar industrial, prontos para produção",

  selo1_numero: "0", selo1_texto: "anos bordando para o Polo",
  selo2_numero: "0", selo2_texto: "peças por mês de capacidade",
  selo3_numero: "0", selo3_texto: "cabeças em operação",
  selo4_numero: "0", selo4_texto: "dias de prazo médio",

  /* --- serviços --- */
  sec_servicos_rotulo: "O que fazemos",
  sec_servicos_titulo: "Cada tipo de bordado tem seu ponto e seu limite",
  sec_servicos_lead: "Não existe técnica que sirva para tudo. Abaixo está o que cada uma resolve, em que material funciona e onde ela para — para você escolher antes de mandar a peça, e não depois.",

  /* --- como funciona --- */
  sec_como_rotulo: "Como funciona",
  sec_como_titulo: "Do arquivo ao lote pronto",
  sec_como_lead: "Quatro etapas, todas com você sabendo onde a peça está.",
  passo1_titulo: "Você manda a arte",
  passo1_texto: "Qualquer formato serve para começar a conversa: PNG, PDF, foto da etiqueta antiga. A gente diz se dá para bordar como está e o que precisa mudar.",
  passo2_titulo: "Digitalizamos o ponto",
  passo2_texto: "A arte vira programa de bordado: sequência, direção, densidade e ordem de cor. É esta etapa que faz o desenho sair igual em toda peça.",
  passo3_titulo: "Você aprova a amostra",
  passo3_texto: "Bordamos uma peça no tecido real do seu lote. Sem aprovação da amostra, a produção não começa.",
  passo4_titulo: "Produção e entrega",
  passo4_texto: "Lote bordado, conferido peça a peça e entregue no prazo combinado. Retirada em Caruaru ou envio para a região.",

  /* --- diferenciais --- */
  sec_porque_rotulo: "Por que a Borda Tudo",
  sec_porque_titulo: "O que muda quando o bordado é o gargalo da sua produção",
  sec_porque_texto: "<p>Confecção não perde dinheiro com bordado caro. Perde com bordado <b>atrasado</b>, com peça que volta porque o logotipo saiu torto, e com o lote que não pode ir para a loja porque a última caixa saiu de outro tom.</p><p>Trabalhamos para que o bordado seja a parte previsível da sua produção: amostra aprovada antes, prazo por escrito, e a mesma programação rodando do primeiro ao último lote.</p>",
  sec_porque_imagem: "/assets/img/vitrine/guias-linha.jpg",
  sec_porque_imagem_alt: "Guias de linha de uma máquina de bordar de múltiplas cabeças",
  porque_itens: "<ul><li><b>Amostra antes da produção.</b> Você aprova no tecido do seu lote, não numa simulação de tela.</li><li><b>Prazo por escrito.</b> Combinado na proposta e cumprido — ou avisado com antecedência.</li><li><b>Programação guardada.</b> O mesmo arquivo roda no lote de repetição, sem redigitalizar e sem variação.</li><li><b>Conferência peça a peça.</b> Nada sai daqui sem passar por olho humano.</li></ul>",

  /* --- vitrine --- */
  sec_vitrine_rotulo: "Vitrine",
  sec_vitrine_titulo: "Trabalhos que saíram desta máquina",
  sec_vitrine_lead: "Peças reais, com a técnica e o material de cada uma. Clique para pedir orçamento de algo parecido.",

  /* --- prova social --- */
  sec_depo_rotulo: "Quem já bordou aqui",
  sec_depo_titulo: "O que dizem as confecções que atendemos",

  /* --- dúvidas --- */
  sec_duvidas_rotulo: "Dúvidas",
  sec_duvidas_titulo: "O que perguntam antes de fechar",

  /* --- orçamento --- */
  sec_orca_rotulo: "Orçamento",
  sec_orca_titulo: "Diga o que precisa bordar",
  sec_orca_lead: "Preencha e o pedido chega pronto no WhatsApp. Nada fica gravado neste site.",
  sec_orca_botao: "Enviar pelo WhatsApp",

  /* --- empresa --- */
  sec_empresa_rotulo: "A Borda Tudo",
  sec_empresa_titulo: "Bordado é ofício antes de ser máquina",
  sec_empresa_texto: "<p>A Borda Tudo nasceu em Caruaru, no meio do maior polo de confecção do Norte e Nordeste. Atendemos quem produz roupa em escala e quem quer uma peça só — com a mesma exigência de acabamento nos dois casos.</p><p>A máquina computadorizada garante repetição. O que garante <b>qualidade</b> é quem programa o ponto, escolhe a linha e confere a peça antes de ela sair. Esse é o nosso trabalho.</p>",
  sec_empresa_imagem: "/assets/img/vitrine/linhas-cores.jpg",
  sec_empresa_imagem_alt: "Parede de carretéis de linha em várias cores",

  /* --- rodapé --- */
  rodape_texto: "Bordados computadorizados para confecção e peça avulsa. Caruaru e região.",

  /* --- operação --- */
  senha_hash: "",
  visit_salt: "",
  /* TRÊS estados, não um interruptor de dois.
     "em construção" e "em manutenção" dizem coisas diferentes a quem chega:
     manutenção promete que o site volta, construção diz que ele ainda não
     nasceu. Prometer volta de um site que nunca esteve no ar é mentira, e é
     a primeira impressão que a empresa dá. */
  site_estado: "no-ar",         // no-ar | construcao | manutencao
  /* NAO existe texto configuravel para essas paginas. Elas tem o texto
     embutido de proposito: aparecem justamente quando a publicacao pode
     nao ter rodado. Um ajuste no painel que a pagina nunca le e pior que
     ajuste nenhum — alguem edita, salva, publica e nada muda. */
  analytics_id: "",
  pixel_id: "",
};

const pegar = db.prepare("SELECT value FROM settings WHERE key = ?");
const porFora = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(PADROES)) porFora.run(k, v);

/* O `manutencao` de "0"/"1" virou `site_estado` com três valores. A conversão
   roda uma vez, no lugar em que o banco é preparado: um site que já estivesse
   EM MANUTENÇÃO voltaria ao ar sozinho no primeiro `git pull` se a chave nova
   nascesse com o padrão. Depois de converter, a chave velha sai — duas chaves
   dizendo a mesma coisa acabam discordando. */
{
  const velho = pegar.get("manutencao");
  if (velho) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'site_estado'")
      .run(velho.value === "1" ? "manutencao" : "no-ar");
    db.prepare("DELETE FROM settings WHERE key = 'manutencao'").run();
    console.log(`  · situação do site migrada: manutencao=${velho.value} → site_estado`);
  }
}

/* Página fora do ar por estado. O `/admin` e o `/assets` continuam servindo,
   senão não haveria como desligar; o `/restrito` é tratado antes disto, porque
   a produção da fábrica não para quando o site institucional para. */
const PAGINA_DO_ESTADO = { construcao: "construcao.html", manutencao: "manutencao.html" };

/* ==========================================================================
   TRAVA DE CONSTRUÇÃO

   O site NÃO ABRE enquanto isto for `true` — nem que alguém mude a situação no
   painel, nem que o banco venha de um backup antigo com o valor errado. O que
   está no ar agora é só o /restrito.

   É uma constante, e não uma configuração, de propósito: configuração se muda
   sem querer, e o efeito de mudar esta é o site inteiro aparecer antes da hora.
   Trocar para `false` é uma decisão consciente, com commit e versão — que é
   exatamente o peso que "lançar o site" tem.

   PARA LANÇAR O SITE:
     1. troque para `false` aqui;
     2. painel → Situação do site → "Site no ar";
     3. suba a versão e faça o deploy.
   ========================================================================== */
const TRAVA_CONSTRUCAO = true;

if (!pegar.get("senha_hash")?.value) {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'senha_hash'").run(gerarHash("borda-admin"));
}
if (!pegar.get("visit_salt")?.value) {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'visit_salt'")
    .run(crypto.randomBytes(24).toString("hex"));
}

const S = () => Object.fromEntries(
  db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));

/* --- semeadura das tabelas de lista --------------------------------------
   Só na primeira subida: `COUNT` zero. Semear sempre sobrescreveria o que o
   cliente cadastrou. */
if (db.prepare("SELECT COUNT(*) c FROM servicos").get().c === 0) {
  const ins = db.prepare(`INSERT INTO servicos (titulo, resumo, aplicacao, material, limite, icone, ordem)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  [
    ["Ponto cheio (cetim)", "O acabamento brilhante clássico. Cobre a área com linha lado a lado e é o que dá o relevo de logotipo bordado.",
     "Logotipo, nome, contorno de letra", "Malha, jeans, brim, sarja", "Traço abaixo de 1 mm fecha e some", "cetim", 1],
    ["Ponto cheio texturizado", "Preenchimento de área grande com direção programada. Não enruga a peça porque distribui a tensão.",
     "Brasão, escudo, área fechada", "Jeans, brim, lona", "Área muito grande endurece a peça", "textura", 2],
    ["Matelassê", "Costura decorativa em linhas paralelas ou losango, que dá volume ao tecido.",
     "Jaqueta, colete, bolsa", "Jeans, nylon, tecido acolchoado", "Precisa de manta ou forro por baixo", "matelasse", 3],
    ["Bordado em boné e sarja", "Bordado em peça pronta, no bastidor próprio de boné, sem abrir a costura.",
     "Boné, viseira, jaleco, avental", "Sarja, brim, algodão", "Frente estruturada limita altura do desenho", "bone", 4],
    ["Etiqueta e patch bordado", "Bordado feito em base própria, com acabamento de borda, para aplicar depois.",
     "Etiqueta de marca, patch, emblema", "Twill, feltro, base termocolante", "Aplicação com calor exige tecido compatível", "etiqueta", 5],
    ["Monograma e personalização", "Peça avulsa, nome ou inicial, com escolha de fonte e cor de linha.",
     "Toalha, roupão, enxoval, presente", "Felpa, algodão, linho", "Felpa alta pede ponto com base", "monograma", 6],
    ["Digitalização de arte", "Transformamos seu logotipo em programa de bordado. O arquivo fica guardado para as repetições.",
     "Qualquer arte que vá virar bordado", "—", "Arte muito detalhada precisa de simplificação", "arquivo", 7],
    ["Bordado em lote para confecção", "Produção em escala com amostra aprovada, prazo por escrito e conferência peça a peça.",
     "Coleção, uniforme, lote de loja", "O tecido do seu lote", "Volume mínimo combinado por proposta", "lote", 8],
  ].forEach((l) => ins.run(...l));
}

/* VITRINE — TUDO AQUI É PROVISÓRIO E PRECISA SAIR ANTES DE PUBLICAR.

   São fotos de banco de imagem gratuito, conferidas uma a uma: das onze que
   baixei, sete foram recusadas — três traziam a marca de outra empresa de
   bordado legível no equipamento, uma tinha palavrão bordado e personagens
   licenciados ao fundo, uma era bordado À MÃO (o oposto do que este site
   vende) e duas eu não cheguei a olhar. Nenhuma dessas recusas aparecia na
   descrição em texto da foto.

   Por isso os títulos aqui descrevem o que a FOTO mostra, e em momento nenhum
   afirmam que a peça saiu desta empresa — vitrine que atribui à casa um
   trabalho que não é dela é propaganda enganosa, não enfeite.

   Cinco fotos do celular do cliente, com luz de janela, substituem tudo isto
   com folga. É o item de maior retorno e menor custo do projeto. */
if (db.prepare("SELECT COUNT(*) c FROM pecas").get().c === 0) {
  const ins = db.prepare(`INSERT INTO pecas (titulo, categoria, tecnica, material, pontos, imagem, alt, destaque, ordem)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const cam = (a) => "/assets/img/vitrine/" + a;
  [
    ["Floral em bolso de jeans", "Peça avulsa", "Ponto cheio", "Jeans", "",
     cam("jeans-bolso-flor.jpg"), "Flor bordada em ponto cheio no bolso de uma peça jeans preta", 1, 1],
    ["Mascote em boné", "Boné", "Ponto cheio com contorno", "Sarja", "",
     cam("bone-mascote.jpg"), "Boné branco com mascote bordado na frente", 1, 2],
    ["Troca de cor programada", "Produção", "Multi-cabeças", "—", "",
     cam("guias-linha.jpg"), "Guias de linha de uma máquina de bordar de múltiplas cabeças", 1, 3],
    ["Gaiola pronta para o lote", "Produção", "Multi-cabeças", "—", "",
     cam("cones-prateleira.jpg"), "Cones de linha na gaiola de uma máquina industrial", 0, 4],
    ["Cartela de cores", "Cores", "—", "Linha de bordado", "",
     cam("linhas-cores.jpg"), "Parede de carretéis de linha em várias cores", 0, 5],
    ["Ponto em tecido escuro", "Detalhe", "Ponto corrido", "Algodão", "",
     cam("calcador.jpg"), "Calcador de máquina sobre tecido escuro, com a linha passando", 0, 6],
  ].forEach((l) => ins.run(...l));
}

if (db.prepare("SELECT COUNT(*) c FROM duvidas").get().c === 0) {
  const ins = db.prepare("INSERT INTO duvidas (pergunta, resposta, ordem) VALUES (?, ?, ?)");
  [
    ["Qual a quantidade mínima para confecção?",
     "<p>Depende do tipo de bordado e do tamanho da arte. Mande o desenho e a quantidade que você precisa — respondemos com o mínimo e o valor por peça na mesma conversa.</p>", 1],
    ["Vocês bordam em peça que eu mesmo levo?",
     "<p>Sim. Bordamos na sua peça, na peça do seu fornecedor ou em base nossa. Só pedimos que a peça chegue lavada e sem passar, porque goma e amaciante mudam o comportamento do tecido no bastidor.</p>", 2],
    ["Preciso ter o logotipo em vetor?",
     "<p>Ajuda, mas não é obrigatório. Trabalhamos a partir de PNG, PDF, JPG e até foto de uma peça antiga. Se a arte precisar de ajuste para virar ponto, a gente avisa antes de começar.</p>", 3],
    ["Quanto tempo leva?",
     "<p>A digitalização da arte sai em poucos dias úteis; a produção depende do tamanho do lote. O prazo vai por escrito na proposta, e se algo mudar você fica sabendo antes do vencimento, não depois.</p>", 4],
    ["O bordado desbota ou solta na lavagem?",
     "<p>Linha de bordado é feita para lavagem industrial. O que causa problema quase sempre é tecido inadequado ou entretela errada — por isso a amostra é bordada no tecido do seu lote antes de a produção começar.</p>", 5],
    ["Vocês entregam fora de Caruaru?",
     "<p>Sim, atendemos toda a região do Agreste. Combinamos envio ou retirada conforme o tamanho do lote.</p>", 6],
  ].forEach((l) => ins.run(...l));
}

/* ==========================================================================
   4. FERRAMENTAS DE TEXTO
   ========================================================================== */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const escAtributo = esc;

const semTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/* MARCADORES DE LINHA.

   Um `<p>` dentro de um `<p>` ou de um `<h2>` é HTML inválido: o navegador
   FECHA a tag externa e o texto escapa do estilo da seção. O painel oferece
   editor de texto rico, então a pessoa naturalmente escreve parágrafo — e o
   resultado é uma linha solta, sem cor e sem tamanho, que ninguém sabe
   explicar.

   Estas chaves vivem dentro de tag de linha no molde. Para elas, o bloco é
   achatado em `<br>` na publicação. */
const MARCADORES_DE_LINHA = new Set([
  "heroi_titulo", "heroi_lead", "heroi_rotulo",
  "sec_servicos_titulo", "sec_servicos_lead",
  "sec_como_titulo", "sec_como_lead",
  "sec_porque_titulo",
  "sec_vitrine_titulo", "sec_vitrine_lead",
  "sec_depo_titulo", "sec_duvidas_titulo",
  "sec_orca_titulo", "sec_orca_lead",
  "sec_empresa_titulo",
  "passo1_titulo", "passo2_titulo", "passo3_titulo", "passo4_titulo",
  "passo1_texto", "passo2_texto", "passo3_texto", "passo4_texto",
  "rodape_texto", "horario", "endereco",
]);

/* Achata bloco em linha. Insere quebra dos DOIS lados antes de remover a tag:
   sem isso, `a<p>b</p>c` viraria `abc` e o texto emendaria. */
function linhaUnica(html) {
  return String(html ?? "")
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|blockquote)[^>]*>/gi, "<br>")
    .replace(/(<br\s*\/?>\s*){2,}/gi, "<br>")
    .replace(/^(\s*<br\s*\/?>)+/i, "")
    .replace(/(<br\s*\/?>\s*)+$/i, "")
    .trim();
}

/* MARCADOR DE COMENTÁRIO NÃO FUNCIONA DENTRO DE ATRIBUTO.

   `src="<!--#IMAGEM-->/foto.jpg<!--/IMAGEM-->"` parece razoável e está errado:
   comentário HTML não existe dentro de valor de atributo, então o navegador lê
   a coisa inteira — comentário e tudo — como se fosse o endereço. A imagem não
   carrega, o link do WhatsApp vira URL inválida, e nada disso aparece no
   console. Só olhando a página.

   Para atributo o token é `{{CHAVE}}`: texto puro, seguro em qualquer posição.
   A troca é de mão única, e isso não custa nada, porque a publicação sempre
   parte do molde — o token continua lá para a próxima vez. */
function trocarTokens(html, valores) {
  return html.replace(/\{\{([A-Z_0-9]+)\}\}/g, (todo, chave) =>
    (chave in valores ? escAtributo(valores[chave]) : todo));
}

/* Substituição por FUNÇÃO, nunca por string.
   Em `String.replace`, `$&` dentro do texto de substituição é expandido e come
   o conteúdo. Qualquer texto do painel pode conter `$&` — preço, código,
   qualquer coisa. Com função, o texto entra literal. */
function setMarker(html, chave, conteudo) {
  const re = new RegExp(`(<!--#${chave}-->)([\\s\\S]*?)(<!--/${chave}-->)`, "g");
  if (!re.test(html)) return html;
  re.lastIndex = 0;
  return html.replace(re, (_, abre, __, fecha) => abre + conteudo + fecha);
}

/* ==========================================================================
   5. MONTAGEM DAS PEÇAS DA PÁGINA
   ========================================================================== */
const zap = (s, texto) =>
  `https://wa.me/${(s.whatsapp || "").replace(/\D/g, "")}?text=${encodeURIComponent(texto)}`;

const ICONES = {
  cetim: '<path d="M4 20 20 4M8 20l12-12M4 12l8-8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  textura: '<path d="M3 7h18M3 12h18M3 17h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 3v18M12 3v18M17 3v18" stroke="currentColor" stroke-width="1.1" opacity=".45"/>',
  matelasse: '<path d="M3 9l9-6 9 6-9 6z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M3 15l9 6 9-6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  bone: '<path d="M4 15a8 8 0 0116 0z" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M4 15h17a2 2 0 01-2 2H4z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/>',
  etiqueta: '<path d="M3 8a2 2 0 012-2h8l8 8-8 8-8-8z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><circle cx="8" cy="11" r="1.4" fill="currentColor"/>',
  monograma: '<path d="M5 19V6l7 9 7-9v13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  arquivo: '<path d="M6 3h7l5 5v13H6z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M13 3v5h5" stroke="currentColor" stroke-width="1.7" fill="none"/>',
  lote: '<path d="M4 8l8-4 8 4-8 4z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  ponto: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8" fill="none"/>',
};
const icone = (nome) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONES[nome] || ICONES.ponto}</svg>`;

function montarServicos() {
  const linhas = db.prepare("SELECT * FROM servicos ORDER BY ordem, id").all();
  return linhas.map((s) => `
      <article class="cartao surge">
        <div class="cartao__icone">${icone(s.icone)}</div>
        <h3 class="cartao__titulo">${esc(s.titulo)}</h3>
        <p class="cartao__texto">${esc(s.resumo)}</p>
        ${(s.aplicacao || s.material || s.limite) ? `<dl class="ficha">
          ${s.aplicacao ? `<div><dt>Aplicação</dt><dd>${esc(s.aplicacao)}</dd></div>` : ""}
          ${s.material ? `<div><dt>Material</dt><dd>${esc(s.material)}</dd></div>` : ""}
          ${s.limite ? `<div><dt>Limite</dt><dd>${esc(s.limite)}</dd></div>` : ""}
        </dl>` : ""}
      </article>`).join("");
}

function montarVitrine(s, { limite = 0, comFiltro = false } = {}) {
  let pecas = db.prepare("SELECT * FROM pecas ORDER BY ordem, id").all();
  if (limite) pecas = pecas.filter((p) => p.destaque).concat(pecas.filter((p) => !p.destaque)).slice(0, limite);
  if (!pecas.length) return "";

  const cartoes = pecas.map((p) => {
    const msg = `Olá! Vi "${p.titulo}" no site e quero um orçamento de algo parecido.`;
    return `
      <article class="peca surge" data-categoria="${escAtributo(p.categoria)}">
        <div class="peca__foto">
          <img src="${escAtributo(p.imagem)}" alt="${escAtributo(p.alt || p.titulo)}" loading="lazy" decoding="async" width="600" height="600">
          ${p.categoria ? `<span class="peca__etiqueta">${esc(p.categoria)}</span>` : ""}
        </div>
        <div class="peca__corpo">
          <h3 class="peca__titulo">${esc(p.titulo)}</h3>
          <p class="peca__meta">${[p.tecnica, p.material, p.pontos].filter(Boolean).map(esc).join(" · ")}</p>
          <div class="peca__acao">
            <a class="botao botao--contorno" href="${escAtributo(zap(s, msg))}" target="_blank" rel="noopener">Quero parecido</a>
          </div>
        </div>
      </article>`;
  }).join("");

  if (!comFiltro) return `<div class="grade">${cartoes}</div>`;

  const cats = [...new Set(pecas.map((p) => p.categoria).filter(Boolean))];
  const filtros = `<div class="filtros" role="group" aria-label="Filtrar por categoria">
      <button class="filtro" type="button" data-filtro="" aria-pressed="true">Tudo</button>
      ${cats.map((c) => `<button class="filtro" type="button" data-filtro="${escAtributo(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}
    </div>`;
  return filtros + `<div class="grade">${cartoes}</div>`;
}

function montarDepoimentos() {
  const linhas = db.prepare("SELECT * FROM depoimentos ORDER BY ordem, id").all();
  if (!linhas.length) return "";
  return `<div class="grade">` + linhas.map((d) => `
      <figure class="cartao costurado surge">
        <blockquote class="rico">${linhaUnica(d.texto)}</blockquote>
        <figcaption class="peca__meta" style="margin-top:var(--e4)">
          <b>${esc(d.nome)}</b>${d.papel ? ` · ${esc(d.papel)}` : ""}
        </figcaption>
      </figure>`).join("") + `</div>`;
}

function montarDuvidas() {
  const linhas = db.prepare("SELECT * FROM duvidas ORDER BY ordem, id").all();
  return linhas.map((d) => `
      <details class="duvida">
        <summary>${esc(d.pergunta)}</summary>
        <div class="duvida__corpo rico">${d.resposta}</div>
      </details>`).join("");
}

function montarSelos(s) {
  return [1, 2, 3, 4]
    .map((n) => ({ num: s[`selo${n}_numero`], txt: s[`selo${n}_texto`] }))
    .filter((x) => x.num && x.num !== "0" && x.txt)
    .map((x) => `<div class="selo"><div class="selo__numero">${esc(x.num)}</div><div class="selo__texto">${esc(x.txt)}</div></div>`)
    .join("");
}

/* Dados estruturados. Os marcadores ficam FORA da tag `<script>`: um
   comentário HTML dentro de JSON-LD entra no corpo do JSON e o invalida. A
   publicação injeta a tag inteira. */
function montarJsonLd(s) {
  const dados = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: SITE.nomeCompleto,
    description: semTags(s.heroi_lead).slice(0, 300),
    url: SITE.base,
    image: `${SITE.base}/assets/img/logo.png`,
    telephone: s.whatsapp ? `+${s.whatsapp}` : undefined,
    address: { "@type": "PostalAddress", addressLocality: SITE.cidade, addressRegion: SITE.uf, addressCountry: "BR" },
    areaServed: { "@type": "AdministrativeArea", name: "Caruaru e Agreste de Pernambuco" },
    sameAs: [s.instagram].filter(Boolean),
    makesOffer: db.prepare("SELECT titulo, resumo FROM servicos ORDER BY ordem, id").all().map((x) => ({
      "@type": "Offer",
      itemOffered: { "@type": "Service", name: x.titulo, description: semTags(x.resumo).slice(0, 200) },
    })),
  };
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: db.prepare("SELECT pergunta, resposta FROM duvidas ORDER BY ordem, id").all().map((d) => ({
      "@type": "Question", name: d.pergunta,
      acceptedAnswer: { "@type": "Answer", text: semTags(d.resposta) },
    })),
  };
  const limpo = JSON.stringify([dados, faq], (k, v) => (v === undefined ? undefined : v))
    .replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${limpo}</script>`;
}

/* ==========================================================================
   6. PUBLICAÇÃO
   ========================================================================== */
/* Carimba a versão nos arquivos de estilo e script.
   Sem isso, quem já visitou continua com o CSS antigo em cache por dias
   depois de uma correção — e o defeito "só acontece com alguns visitantes". */
function carimbar(html) {
  return html.replace(/(href|src)="(\/assets\/[^"?]+\.(?:css|js))"/g,
    (_, attr, url) => `${attr}="${url}?v=${APP_VERSION}"`);
}

const PAGINAS = [
  { molde: "molde-home.html", destino: "index.html" },
  { molde: "molde-servicos.html", destino: "servicos/index.html" },
  { molde: "molde-vitrine.html", destino: "vitrine/index.html" },
  { molde: "molde-empresa.html", destino: "empresa/index.html" },
  { molde: "molde-orcamento.html", destino: "orcamento/index.html" },
  { molde: "molde-privacidade.html", destino: "privacidade/index.html" },
  { molde: "molde-busca.html", destino: "busca/index.html" },
];

function publicar() {
  const s = S();
  const feito = [];

  for (const p of PAGINAS) {
    const origem = path.join(RAIZ, "src", p.molde);
    if (!fs.existsSync(origem)) continue;
    let html = fs.readFileSync(origem, "utf8");

    /* 1. cada ajuste de texto do painel */
    for (const [k, v] of Object.entries(s)) {
      if (k === "senha_hash" || k === "visit_salt") continue;
      html = setMarker(html, k.toUpperCase(), MARCADORES_DE_LINHA.has(k) ? linhaUnica(v) : v);
    }

    /* 2. as listas montadas */
    html = setMarker(html, "SERVICOS", montarServicos());
    html = setMarker(html, "VITRINE_DESTAQUE", montarVitrine(s, { limite: 6 }));
    html = setMarker(html, "VITRINE_TUDO", montarVitrine(s, { comFiltro: true }));
    html = setMarker(html, "DEPOIMENTOS", montarDepoimentos());
    html = setMarker(html, "DUVIDAS", montarDuvidas());
    html = setMarker(html, "SELOS", montarSelos(s));
    html = setMarker(html, "JSONLD", montarJsonLd(s));

    /* 3. links e valores repetidos, no CORPO da página */
    html = setMarker(html, "ZAP_NUMERO", esc(formatarZap(s.whatsapp)));
    html = setMarker(html, "ANO", String(new Date().getFullYear()));
    html = setMarker(html, "VERSAO", APP_VERSION);

    /* 4. valores que vivem dentro de ATRIBUTO — token, não marcador.
          Ver o comentário do `trocarTokens`: comentário HTML dentro de aspas
          não é comentário, é texto, e o endereço sai quebrado sem avisar. */
    html = trocarTokens(html, {
      /* As chaves do banco são minúsculas e o token é maiúsculo. Sem esta
         linha o `{{HEROI_IMAGEM}}` não casa com `heroi_imagem` e fica no HTML,
         cru, visível na página. */
      ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k.toUpperCase(), v])),
      ZAP_ORCAMENTO: zap(s, "Olá! Quero um orçamento de bordado."),
      ZAP_NUMERO: formatarZap(s.whatsapp),
      ANO: String(new Date().getFullYear()),
      VERSAO: APP_VERSION,
    });

    const destino = path.join(RAIZ, p.destino);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, carimbar(html), "utf8");
    feito.push(p.destino);
  }

  escreverSitemap();
  return feito;
}

function formatarZap(n) {
  const d = String(n || "").replace(/\D/g, "");
  if (d.length < 12) return d;
  return `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
}

function escreverSitemap() {
  const hoje = new Date().toISOString().slice(0, 10);
  const rotas = ["/", "/servicos/", "/vitrine/", "/empresa/", "/orcamento/", "/privacidade/"];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rotas.map((r) => `  <url><loc>${SITE.base}${r}</loc><lastmod>${hoje}</lastmod><changefreq>monthly</changefreq><priority>${r === "/" ? "1.0" : "0.7"}</priority></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(RAIZ, "sitemap.xml"), xml, "utf8");
}

module.exports = { publicar, db, APP_VERSION };

/* Declarado ANTES das rotas que o usam. Hoje funcionaria depois, porque a
   rota so executa quando ja ha pedido chegando — mas isso e sorte de ordem
   de execucao, nao garantia, e some no dia em que algo chamar mais cedo. */
const backups = agendarBackups({
  destino: path.join(RAIZ, "backups"),
  bancos: [ARQ_BANCO],
  manter: 30,
  intervaloHoras: 24,

  /* O Postgres do /restrito entra no MESMO backup diário. Ele guarda o que
     virou nota: se sumir, ninguém reescreve — a informação só existia ali.
     Só é copiado quando há senha no ambiente; em máquina de desenvolvimento
     sem `.env` o backup do site continua rodando normalmente. */
  postgres: process.env.PGPASSWORD ? {
    banco: process.env.PGDATABASE || "bordatudo_producao",
    usuario: process.env.PGUSER || "bordatudo",
    host: process.env.PGHOST || "127.0.0.1",
    porta: process.env.PGPORT || 5432,
    senha: process.env.PGPASSWORD,
    pgDump: process.env.PG_DUMP || "pg_dump",
  } : null,
});

/* ==========================================================================
   7. SESSÕES E TRAVA
   ========================================================================== */
const sessoes = new Map();
const DURACAO_SESSAO = 8 * 3600e3;

/* O arquivo da trava é configurável para a SUÍTE poder usar o dela. Sem isso o
   teste envenena o estado de produção: ele erra senhas de propósito, e as
   próximas cinco tentativas de quem for entrar de verdade caem no bloqueio. */
const limitador = criarLimitador({
  arquivo: process.env.LIMITES_ARQUIVO || path.join(RAIZ, "data", "limites.json"),
});
limitador.carregar();

/* O nginx ACRESCENTA ao X-Forwarded-For, então o primeiro item dele é texto
   que o próprio atacante mandou — e ele mudaria de "IP" a cada tentativa,
   deixando a trava inútil. O X-Real-IP é SOBRESCRITO pelo nginx: esse é o
   único que serve. */
function ipDoCliente(req) {
  return String(req.headers["x-real-ip"] || req.socket.remoteAddress || "")
    .replace(/^::ffff:/, "") || "0.0.0.0";
}

function novaSessao() {
  const id = crypto.randomBytes(24).toString("hex");
  sessoes.set(id, { criada: Date.now() });
  return id;
}
function sessaoValida(req) {
  const m = /sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  if (!m) return false;
  const s = sessoes.get(m[1]);
  if (!s) return false;
  if (Date.now() - s.criada > DURACAO_SESSAO) { sessoes.delete(m[1]); return false; }
  return true;
}

/* ==========================================================================
   8. SERVIDOR
   ========================================================================== */
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/* Pastas que a web NUNCA vê. A regra é por LOCAL, não por nome de arquivo:
   bloquear "server.js" pelo nome funciona até nascer um "rotas.js" ao lado. */
const PUBLICO = ["assets", "admin", "servicos", "vitrine", "empresa", "orcamento",
                 "privacidade", "busca"];
const ARQUIVOS_PUBLICOS = new Set([
  "index.html", "404.html", "manutencao.html", "robots.txt", "sitemap.xml",
  "manifest.webmanifest", "favicon.ico",
]);

function podeServir(rel) {
  if (!rel || rel.includes("..")) return false;
  const partes = rel.split("/").filter(Boolean);
  if (partes.length === 1) return ARQUIVOS_PUBLICOS.has(partes[0]);
  return PUBLICO.includes(partes[0]);
}

/* O pedido sai de `res.req`, que o próprio Node mantém, em vez de ser passado
   como argumento. São 31 chamadas de `responder()` neste arquivo: threading o
   `req` por todas seria 31 oportunidades de esquecer uma — e a que faltasse
   perderia o cabeçalho de segurança em silêncio, justamente numa rota. */
function cabecalhosBase(res, extra = {}) {
  const req = res.req || null;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");

  /* HSTS — SÓ QUANDO A CONEXÃO VEIO POR HTTPS.
     O `criar_site.sh` deixa este cabeçalho para o app justamente porque só o
     app sabe por onde a requisição entrou, lendo o X-Forwarded-Proto que o
     nginx põe. O comentário de lá afirmava isso desde o começo, e ninguém
     tinha implementado: o cabeçalho não existia em lugar nenhum.

     `includeSubDomains` fica de fora de propósito — este app responde por um
     domínio só, e assinar por subdomínios que não são dele é decisão de quem
     administra o domínio inteiro, não de um site dentro dele.
     `preload` também fica de fora: entrar na lista dos navegadores é fácil e
     sair leva meses, então não é coisa que um script de instalação decide. */
  if (req && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function responder(res, status, corpo, tipo = "application/json; charset=utf-8", extra = {}) {
  cabecalhosBase(res, extra);
  res.writeHead(status, { "Content-Type": tipo });
  res.end(typeof corpo === "string" || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
}

function lerCorpo(req, limite = 2e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const partes = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limite) { reject(new Error("corpo grande demais")); req.destroy(); return; }
      partes.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")); }
      catch { resolve(null); }
    });
    req.on("error", reject);
  });
}

function contarVisita(req) {
  const s = S();
  const dia = new Date().toISOString().slice(0, 10);
  const marca = crypto.createHash("sha256")
    .update(ipDoCliente(req) + "|" + (req.headers["user-agent"] || "") + "|" + s.visit_salt)
    .digest("hex").slice(0, 32);
  const novo = db.prepare("INSERT OR IGNORE INTO visitantes (dia, marca) VALUES (?, ?)").run(dia, marca);
  if (novo.changes) {
    db.prepare(`INSERT INTO visitas (dia, total) VALUES (?, 1)
                ON CONFLICT(dia) DO UPDATE SET total = total + 1`).run(dia);
  }
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const rota = decodeURIComponent(url.pathname);

  /* ------------------------------------------------------------- API ---- */
  if (rota.startsWith("/api/")) return rotasApi(req, res, rota, url);

  /* ---------------------------------------------------------- /restrito -- */
  /* O sistema de produção é OUTRA aplicação, com outro banco (Postgres) e
     outra autenticação. Ele mora no mesmo processo só para dividir a porta e o
     certificado — o site cai se o Postgres cair? Não: o `catch` abaixo devolve
     erro só de quem pediu /restrito, e o site institucional segue servindo. */
  if (rota === "/restrito" || rota.startsWith("/restrito/")) {
    if (rota === "/restrito") {
      /* Sem a barra, o `?m=` do QR se perderia num redirecionamento mal feito.
         Aqui a tela é servida direto e a busca fica intacta. */
      return servirRestrito(req, res);
    }
    if (rota === "/restrito/" || rota === "/restrito/index.html") return servirRestrito(req, res);
    try {
      /* Os dados da empresa vêm do painel do SITE (SQLite), não de uma segunda
         cópia dentro do /restrito. Duas cópias divergiriam, e a errada seria a
         que sai impressa no recibo que o cliente leva embora. */
      const c = S();
      const empresa = {
        nome: SITE.nomeCompleto,
        curto: SITE.nome,
        cnpj: c.cnpj && c.cnpj !== "0" ? c.cnpj : "",
        endereco: c.endereco || `${SITE.cidade}, ${SITE.uf}`,
        telefone: c.whatsapp || "",
        email: c.email || "",
        versao: APP_VERSION,
      };
      return await restrito.rotas(req, res, rota, limitador, ipDoCliente, empresa);
    } catch (e) {
      console.error("  ✖ /restrito:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "erro interno" }));
      }
      return;
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD")
    return responder(res, 405, { error: "método não permitido" });

  const s = S();
  /* A trava ganha do painel. Enquanto ela estiver de pé, "Site no ar" no painel
     não põe o site no ar — e é isso que a tela do painel avisa. */
  const paginaEstado = TRAVA_CONSTRUCAO ? "construcao.html" : PAGINA_DO_ESTADO[s.site_estado];
  /* O favicon passa mesmo com o site fora do ar: a própria página de aviso o
     pede, e uma aba com o ícone quebrado é a diferença entre "estão
     trabalhando nisso" e "está tudo quebrado". */
  if (paginaEstado && !rota.startsWith("/admin") && !rota.startsWith("/assets")
      && rota !== "/favicon.ico") {
    const p = path.join(RAIZ, paginaEstado);
    if (fs.existsSync(p)) {
      /* 503, e não 200: diz ao Google "isto não é o site, volte depois" em vez
         de deixá-lo indexar a página de aviso no lugar da home. O `Retry-After`
         de construção é longo — não adianta o robô voltar em 10 minutos. */
      return responder(res, 503, fs.readFileSync(p), TIPOS[".html"],
        { "Retry-After": paginaEstado === "construcao.html" ? "86400" : "600" });
    }
  }

  /* ------------------------------------------------------- arquivo ------ */
  let rel = rota.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  if (!podeServir(rel)) return pagina404(res);

  const alvo = path.join(RAIZ, rel);
  const dentro = path.resolve(alvo).startsWith(path.resolve(RAIZ) + path.sep);
  if (!dentro || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) return pagina404(res);

  const ext = path.extname(alvo).toLowerCase();
  const tipo = TIPOS[ext] || "application/octet-stream";

  const extra = {};
  if (rel.startsWith("admin/")) {
    extra["X-Frame-Options"] = "DENY";
    extra["Content-Security-Policy"] =
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    extra["X-Robots-Tag"] = "noindex, nofollow";
    extra["Cache-Control"] = "no-store";
  } else if (url.searchParams.has("v")) {
    /* Só quem tem carimbo de versão pode ficar guardado por muito tempo — é o
       carimbo que garante que uma correção chegue no mesmo dia. */
    extra["Cache-Control"] = "public, max-age=31536000, immutable";
  } else if (ext === ".html") {
    extra["Cache-Control"] = "no-cache";
    if (req.method === "GET") { try { contarVisita(req); } catch {} }
  } else {
    extra["Cache-Control"] = "public, max-age=3600";
  }

  let corpo = fs.readFileSync(alvo);
  if (rel === "admin/index.html") corpo = Buffer.from(String(corpo).replace(/\{\{VERSAO\}\}/g, APP_VERSION), "utf8");

  cabecalhosBase(res, extra);
  res.writeHead(200, { "Content-Type": tipo, "Content-Length": corpo.length });
  res.end(req.method === "HEAD" ? undefined : corpo);
});

/* A tela do /restrito é UM arquivo só. Ele carrega logado ou não: quando não
   há sessão, o próprio JavaScript mostra a entrada. Servir telas diferentes
   para os dois casos duplicaria o cabeçalho e o rodapé em dois lugares. */
function servirRestrito(req, res) {
  const alvo = path.join(RAIZ, "restrito", "app.html");
  if (!fs.existsSync(alvo)) return pagina404(res);
  const corpo = Buffer.from(
    fs.readFileSync(alvo, "utf8").replace(/\{\{VERSAO\}\}/g, APP_VERSION), "utf8");
  cabecalhosBase(res, {
    /* Sem `frame-ancestors`, a tela poderia ser posta dentro de um iframe
       invisível e o operador clicaria em "fechar ficha" sem saber. */
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "no-store",
  });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": corpo.length });
  res.end(req.method === "HEAD" ? undefined : corpo);
}

function pagina404(res) {
  const p = path.join(RAIZ, "404.html");
  const corpo = fs.existsSync(p) ? fs.readFileSync(p) : "não encontrado";
  return responder(res, 404, corpo, TIPOS[".html"]);
}

/* ==========================================================================
   9. ROTAS DA API
   ========================================================================== */
/* LISTA DE PERMISSÃO. Chave que não estiver aqui é DESCARTADA em silêncio pelo
   PUT: o campo aparece no painel, a pessoa salva, o aviso diz "salvo" e nada
   muda. Campo novo no painel exige entrada aqui. */
const CHAVES = new Set(Object.keys(PADROES).filter((k) => k !== "senha_hash" && k !== "visit_salt"));

const TABELAS = {
  servicos: ["titulo", "resumo", "aplicacao", "material", "limite", "icone", "ordem"],
  pecas: ["titulo", "categoria", "tecnica", "material", "pontos", "imagem", "alt", "preco", "destaque", "ordem"],
  depoimentos: ["nome", "papel", "texto", "nota", "ordem"],
  duvidas: ["pergunta", "resposta", "ordem"],
};

/* Campo numérico em branco chega como `""`. Em coluna inteira isso é string, e
   o banco recusa — em Postgres com erro 500 na cara do cliente, em SQLite com
   um valor sujo guardado. A conversão fica NA BEIRA DO BANCO, uma vez, não
   espalhada por cada tela. */
const NUMERICOS = new Set(["ordem", "nota", "preco", "destaque"]);
function prepararCampos(tabela, corpo) {
  const saida = {};
  for (const col of TABELAS[tabela]) {
    if (!(col in corpo)) continue;
    let v = corpo[col];
    if (NUMERICOS.has(col)) {
      if (v === "" || v === null || v === undefined) v = col === "preco" ? null : 0;
      else { const n = Number(v); v = Number.isFinite(n) ? n : 0; }
    } else v = String(v ?? "");
    saida[col] = v;
  }
  return saida;
}

async function rotasApi(req, res, rota, url) {
  const ip = ipDoCliente(req);

  /* ---- entrar ---- */
  if (rota === "/api/login" && req.method === "POST") {
    const pode = limitador.verificar("painel", ip, "admin");
    if (!pode.ok) return responder(res, 429, { error: pode.mensagem }, undefined, { "Retry-After": String(pode.esperar || 60) });

    const corpo = await lerCorpo(req);
    const certo = conferirSenha(corpo?.senha || "", pegar.get("senha_hash")?.value);
    if (!certo) { limitador.errou("painel", ip, "admin"); return responder(res, 401, { error: "senha incorreta" }); }

    limitador.acertou("painel", ip, "admin");
    const sid = novaSessao();
    return responder(res, 200, { ok: true }, undefined, {
      "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACAO_SESSAO / 1000}`,
    });
  }

  if (rota === "/api/logout" && req.method === "POST") {
    const m = /sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
    if (m) sessoes.delete(m[1]);
    return responder(res, 200, { ok: true }, undefined, { "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
  }

  if (!sessaoValida(req)) return responder(res, 401, { error: "não autenticado" });

  /* ---- conteúdo ---- */
  if (rota === "/api/conteudo" && req.method === "GET") {
    const settings = S();
    delete settings.senha_hash; delete settings.visit_salt;   /* nunca saem, nem para quem entrou */
    return responder(res, 200, {
      settings,
      servicos: db.prepare("SELECT * FROM servicos ORDER BY ordem, id").all(),
      pecas: db.prepare("SELECT * FROM pecas ORDER BY ordem, id").all(),
      depoimentos: db.prepare("SELECT * FROM depoimentos ORDER BY ordem, id").all(),
      duvidas: db.prepare("SELECT * FROM duvidas ORDER BY ordem, id").all(),
      versao: APP_VERSION,
      /* O painel precisa SABER que a trava existe. Sem isto ele mostraria
         "Site no ar" selecionado com o site fora do ar, e a pessoa passaria a
         tarde procurando o que está errado no servidor. */
      travaConstrucao: TRAVA_CONSTRUCAO,
    });
  }

  if (rota === "/api/conteudo" && req.method === "PUT") {
    const corpo = await lerCorpo(req);
    if (!corpo) return responder(res, 400, { error: "corpo inválido" });
    const gravar = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    let n = 0;
    for (const [k, v] of Object.entries(corpo)) {
      if (!CHAVES.has(k)) continue;
      /* Valor fora da lista aqui tiraria o site do ar sem página nenhuma para
         mostrar — e o painel continuaria dizendo que está tudo certo. */
      if (k === "site_estado" && !["no-ar", "construcao", "manutencao"].includes(String(v)))
        return responder(res, 400, { error: "situação do site inválida" });
      gravar.run(String(v ?? ""), k); n++;
    }
    return responder(res, 200, { ok: true, gravados: n });
  }

  /* ---- tabelas de lista ---- */
  const mTab = /^\/api\/(servicos|pecas|depoimentos|duvidas)(?:\/(\d+))?$/.exec(rota);
  if (mTab) {
    const [, tabela, id] = mTab;
    const cols = TABELAS[tabela];

    if (req.method === "POST") {
      const dados = prepararCampos(tabela, (await lerCorpo(req)) || {});
      const usadas = cols.filter((c) => c in dados);
      if (!usadas.length) return responder(res, 400, { error: "nada para gravar" });
      const r = db.prepare(`INSERT INTO ${tabela} (${usadas.join(",")}) VALUES (${usadas.map(() => "?").join(",")})`)
        .run(...usadas.map((c) => dados[c]));
      return responder(res, 201, { ok: true, id: r.lastInsertRowid });
    }
    if (req.method === "PUT" && id) {
      const dados = prepararCampos(tabela, (await lerCorpo(req)) || {});
      const usadas = cols.filter((c) => c in dados);
      if (!usadas.length) return responder(res, 400, { error: "nada para gravar" });
      db.prepare(`UPDATE ${tabela} SET ${usadas.map((c) => `${c}=?`).join(",")} WHERE id=?`)
        .run(...usadas.map((c) => dados[c]), Number(id));
      return responder(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      db.prepare(`DELETE FROM ${tabela} WHERE id=?`).run(Number(id));
      return responder(res, 200, { ok: true });
    }
  }

  /* ---- envio de imagem ----
     Recebe base64 num JSON em vez de multipart. Multipart exigiria um
     analisador próprio ou uma dependência; para foto de vitrine, base64 custa
     33% a mais de tráfego numa rede interna e elimina uma superfície inteira
     de bugs de parsing. */
  if (rota === "/api/enviar" && req.method === "POST") {
    const corpo = await lerCorpo(req, 12e6);      // ~9 MB de imagem depois do base64
    if (!corpo?.dados) return responder(res, 400, { error: "sem arquivo" });

    const ext = String(corpo.nome || "").toLowerCase().match(/\.(jpe?g|png|webp|avif)$/)?.[0];
    if (!ext) return responder(res, 400, { error: "formato não aceito — use jpg, png, webp ou avif" });

    /* O nome do arquivo é RECONSTRUÍDO, não higienizado.
       Limpar o que o cliente mandou é jogo de gato e rato com `..`, barra,
       dois-pontos, nome reservado do Windows e caractere invisível. Aqui só a
       parte legível sobrevive, e o resto é gerado por nós. */
    /* Recorta pelo COMPRIMENTO, não por `replace(ext)`: a extensão foi lida em
       minúscula e o nome pode ter vindo em maiúscula, então o replace não casa
       e "Foto.JPG" viraria "foto-jpg-a1b2.jpg". */
    const base = String(corpo.nome).slice(0, String(corpo.nome).length - ext.length)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "foto";
    const arquivo = `${base}-${crypto.randomBytes(4).toString("hex")}${ext}`;

    const bruto = Buffer.from(String(corpo.dados).replace(/^data:[^,]+,/, ""), "base64");
    if (!bruto.length) return responder(res, 400, { error: "arquivo vazio" });
    if (bruto.length > 9e6) return responder(res, 413, { error: "imagem acima de 9 MB" });

    const destino = path.join(RAIZ, "assets", "img", "uploads", arquivo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, bruto);
    return responder(res, 201, { ok: true, caminho: `/assets/img/uploads/${arquivo}` });
  }

  /* ---- publicar ---- */
  if (rota === "/api/publicar" && req.method === "POST") {
    const feito = publicar();
    return responder(res, 200, { ok: true, paginas: feito });
  }

  /* ---- senha ---- */
  if (rota === "/api/senha" && req.method === "POST") {
    const corpo = await lerCorpo(req);
    const atual = corpo?.atual || "", nova = corpo?.nova || "";
    if (!conferirSenha(atual, pegar.get("senha_hash")?.value))
      return responder(res, 401, { error: "senha atual incorreta" });
    if (nova.length < 10) return responder(res, 400, { error: "a nova senha precisa de 10 caracteres ou mais" });
    if (nova === "borda-admin") return responder(res, 400, { error: "essa senha é pública no README — escolha outra" });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'senha_hash'").run(gerarHash(nova));
    sessoes.clear();   /* derruba as outras sessões: trocar senha tem de expulsar quem já estava */
    return responder(res, 200, { ok: true });
  }

  /* ---- acessos ---- */
  if (rota === "/api/acessos" && req.method === "GET") {
    return responder(res, 200, {
      dias: db.prepare("SELECT dia, total FROM visitas ORDER BY dia DESC LIMIT 60").all(),
    });
  }

  /* ---- backup ---- */
  if (rota === "/api/backup" && req.method === "POST") {
    const r = backups.rodarAgora("pelo painel");
    return responder(res, 200, { ok: true, resultado: r });
  }
  if (rota === "/api/backup" && req.method === "GET") {
    return responder(res, 200, backups.status());
  }

  return responder(res, 404, { error: "rota desconhecida" });
}

/* ==========================================================================
   10. SUBIDA
   ========================================================================== */
if (require.main === module) {
  /* BANDEIRAS DE LINHA DE COMANDO — o `deploy.sh` DEPENDE delas.
     Ele chama `node server.js --backup` no passo 1 e `--backup-status` no
     fim. Sem tratar aqui, o argumento é ignorado em silêncio: o processo
     publica, ABRE A PORTA e nunca termina — o deploy trava no primeiro passo,
     ou morre com "address already in use" se o serviço já estiver de pé.
     Um contrato entre dois arquivos que ninguém confere quebra na primeira
     vez que é usado de verdade, que é sempre no servidor. */
  const bandeiras = process.argv.slice(2);

  if (bandeiras.includes("--backup")) {
    /* `rodarAgora` devolve a LISTA do que copiou, não um objeto de resultado.
       Testar `r.erro` num array dá sempre `undefined`, e o deploy anunciaria
       "cópia feita" mesmo com o backup falhando — que é a única hora em que
       essa mensagem importa. Lista vazia é a falha. */
    const feitos = backups.rodarAgora("pelo deploy") || [];
    if (!feitos.length) {
      console.error("  nenhuma cópia feita — veja a mensagem acima");
      process.exit(1);
    }
    console.log(`  ${feitos.length} cópia(s) de segurança feita(s)`);
    process.exit(0);
  }

  if (bandeiras.includes("--backup-status")) {
    const s = backups.status();
    (s.bancos || []).forEach((b) => {
      console.log(`  ${b.banco}: ${b.copias} cópias · última ` +
        (b.ultimo ? new Date(b.ultimo).toLocaleString("pt-BR") : "nenhuma"));
    });
    process.exit(0);
  }

  if (bandeiras.includes("--publicar")) {
    const feito = publicar();
    console.log(`  publicado: ${feito.join(", ")}`);
    process.exit(0);
  }

  publicar();
  servidor.listen(PORTA, HOST, () => {
    console.log(`\n  ${SITE.nomeCompleto} — site + gerenciador v${APP_VERSION}`);
    console.log(`  · Site:   http://localhost:${PORTA}/`);
    console.log(`  · Painel: http://localhost:${PORTA}/admin/`);
    console.log(`  · Banco:  data/site.db\n`);
  });
}
