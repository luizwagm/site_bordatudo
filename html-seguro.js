/* ==========================================================================
   HIGIENIZAÇÃO DE HTML

   O painel passou a ter editor de texto formatado, e com ele os textos do site
   deixaram de ser texto puro: vêm com negrito, link, lista, subtítulo. Para o
   site EXIBIR isso, o publish precisa parar de escapar esses campos — e é aí
   que mora o risco.

   Sem filtro, qualquer coisa gravada num campo de texto vira código executado
   na página de todos os visitantes. Não é só "e se invadirem o painel": um
   `<img src=x onerror=...>` colado sem querer de um site qualquer já basta.

   POR QUE O FILTRO É AQUI, NO SERVIDOR, E NÃO NO NAVEGADOR
   Porque trava de navegador se contorna mandando o dado direto para a API com
   um `curl`. O editor não deixar colar HTML é conforto; o que garante é isto.

   POR QUE NA GRAVAÇÃO, E NÃO NA PUBLICAÇÃO
   Assim o banco só guarda HTML já seguro. Filtrar só na hora de publicar
   deixaria o conteúdo perigoso descansando no banco, pronto para vazar por
   qualquer outra rota que o leia — a API do painel, um backup, um relatório.

   LISTA BRANCA, NUNCA LISTA NEGRA. Proibir `<script>` é jogo perdido: sobram
   `onerror`, `onload`, `javascript:`, `<iframe>`, `<object>`, `<svg>` com
   script dentro, e o que aparecer no navegador do ano que vem. Aqui só passa o
   que está escrito abaixo; o resto some sem discussão.

   O TEXTO NUNCA SE PERDE. Tag fora da lista é removida, mas o conteúdo dela
   fica — quem escreveu vê o texto, só sem a formatação que não vale. As únicas
   exceções são as tags de TAGS_COM_MIOLO, cujo conteúdo também é lixo (o corpo
   de um <script> não é texto que alguém queira ler).

   Portado do `seguranca.js` do LA Publisher, onde já roda em produção.
   ========================================================================== */
"use strict";

/* ESCAPE QUE NÃO ESCAPA DUAS VEZES.

   O `&` só vira `&amp;` quando NÃO é o começo de uma entidade que já existe.
   Sem esse cuidado, o higienizador não é idempotente — e ele roda mais de uma
   vez sobre o mesmo texto na vida real:

     salva "Compra & venda"      -> banco guarda "Compra &amp; venda"
     abre o editor de novo        -> a tela mostra "Compra & venda" (certo)
     salva sem mudar nada         -> o innerHTML devolve "Compra &amp; venda"
                                     e uma segunda passada faria "&amp;amp;"

   Resultado: o site passaria a exibir "Compra &amp; venda" literalmente, e o
   texto ia se degradando a cada edição. Não aparece no primeiro salvamento —
   só na segunda vez que alguém mexer, dias depois, sem ligar uma coisa à outra.

   A lista de formas válidas é a do HTML: `&nome;`, `&#123;` e `&#x1F;`. */
const ENTIDADE = /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g;

const esc = (s) => String(s ?? "")
  .replace(ENTIDADE, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* O que a barra do editor produz, mais o que faz sentido escrever à mão no
   modo HTML. `em` está aqui porque o site o usa para o marca-texto amarelo dos
   títulos — tirá-lo quebraria a identidade visual em toda a home. */
const TAGS_OK = new Set(["p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup",
  "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "a", "img", "figure",
  "figcaption", "span", "div", "code", "pre", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "small"]);

const VAZIAS = new Set(["br", "hr", "img"]);

/* `style` NÃO está na lista, de propósito: por ele passa `background:url(javascript:…)`
   em navegadores antigos e, mesmo nos novos, dá para cobrir a tela inteira com
   um elemento invisível e sequestrar o clique. Formatação vem de `class`. */
const ATRIB_OK = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
  "*": ["class"],
};

/* Tags cujo CONTEÚDO também vai fora — tirar só a tag não resolve: o corpo de
   um <script> continuaria na página como texto e, num `<style>`, ainda seria
   interpretado se alguém o reembrulhasse. */
const TAGS_COM_MIOLO = /<(script|style|iframe|object|embed|svg|math|noscript|template|form|input|button|link|meta|base)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/* Endereço de link e de imagem.

   Os caracteres de controle são removidos ANTES de comparar porque
   `java\nscript:` e `java\tscript:` são aceitos por navegadores como
   `javascript:` — o filtro que só olha o texto cru passa batido neles. */
/* Montado a partir de texto ASCII, e nao escrito no literal: caracteres de
   controle sao INVISIVEIS no editor. Escrito direto, o NUL vira um byte 0 no
   meio do arquivo — o git passa a tratar o codigo como BINARIO, e grep, diff e
   revisao param de funcionar nele. */
const CONTROLE = new RegExp("[\u0000-\u0020]", "g");

function urlSegura(u, permitirDados) {
  const v = String(u || "").trim().replace(CONTROLE, "");
  if (!v) return null;
  if (/^(https?:)?\/\//i.test(v)) return v;                 // http, https, //
  if (/^\/[^/]/.test(v) || /^\.{0,2}\//.test(v)) return v;  // caminho do próprio site
  if (/^(mailto|tel):[^\s<>"']+$/i.test(v)) return v;
  if (permitirDados && /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  return null;                                              // javascript:, data:text/html… caem aqui
}

function sanitizarHtml(entrada) {
  if (!entrada) return "";
  let html = String(entrada);
  if (html.length > 500_000) html = html.slice(0, 500_000);
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(TAGS_COM_MIOLO, "");

  const saida = [];
  const pilha = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;
  let pos = 0, m;

  while ((m = re.exec(html)) !== null) {
    if (m.index > pos) saida.push(esc(html.slice(pos, m.index)));   // texto solto: sempre escapado
    pos = re.lastIndex;

    const fechando = m[0][1] === "/";
    const tag = m[1].toLowerCase();
    if (!TAGS_OK.has(tag)) continue;                                 // fora da lista: some, miolo fica

    if (fechando) {
      const i = pilha.lastIndexOf(tag);
      if (i === -1) continue;                                        // fechamento órfão
      while (pilha.length > i) saida.push(`</${pilha.pop()}>`);       // fecha o que ficou aberto no meio
      continue;
    }

    const permitidos = new Set([...(ATRIB_OK[tag] || []), ...ATRIB_OK["*"]]);
    const attrs = [];
    const rea = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|([a-zA-Z][a-zA-Z0-9-]*)/g;
    let a;
    while ((a = rea.exec(m[2] || "")) !== null) {
      const nome = (a[1] || a[5] || "").toLowerCase();
      if (!permitidos.has(nome)) continue;                           // on*, style, srcset… nunca entram
      let valor = a[2] ?? a[3] ?? a[4] ?? "";
      if (nome === "href" || nome === "src") {
        const u = urlSegura(valor, tag === "img");
        if (!u) continue;
        valor = u;
      } else if (nome === "class") {
        valor = valor.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 120);
        if (!valor) continue;
      } else if (nome === "target") {
        valor = valor === "_blank" ? "_blank" : "_self";
      } else if (nome === "rel") {
        valor = valor.replace(/[^a-zA-Z ]/g, "").slice(0, 60);
      } else if (["width", "height", "colspan", "rowspan"].includes(nome)) {
        if (!/^\d{1,5}$/.test(valor)) continue;
      } else if (nome === "loading") {
        valor = valor === "lazy" ? "lazy" : "eager";
      } else {
        valor = valor.slice(0, 300);
      }
      attrs.push(` ${nome}="${esc(valor)}"`);
    }

    /* Link para fora sempre com `rel` de segurança: sem `noopener`, a página de
       destino recebe `window.opener` e pode trocar o endereço da aba de origem
       por uma cópia falsa do site. */
    if (tag === "a" && attrs.some((x) => x.includes('target="_blank"')) && !attrs.some((x) => x.startsWith(" rel=")))
      attrs.push(' rel="noopener noreferrer"');

    const auto = /\/\s*>$/.test(m[0]);
    if (VAZIAS.has(tag) || auto) { saida.push(`<${tag}${attrs.join("")}>`); continue; }
    saida.push(`<${tag}${attrs.join("")}>`);
    pilha.push(tag);
    /* Aninhamento absurdo trava o navegador de quem visita. 60 é folgado para
       texto de verdade e barato para quem tentar montar uma bomba de div. */
    if (pilha.length > 60) { pilha.pop(); saida.push(`</${tag}>`); }
  }
  if (pos < html.length) saida.push(esc(html.slice(pos)));
  while (pilha.length) saida.push(`</${pilha.pop()}>`);               // fecha o que sobrou aberto
  return saida.join("");
}

/* --------------------------------------------------------------------------
   DESEMBRULHAR UM PARÁGRAFO ÚNICO

   O editor devolve `<p>texto</p>` mesmo para uma linha só. Vários lugares do
   site inserem esse valor DENTRO de um `<h2>` ou de um `<p>` que já existe — e
   `<p>` dentro de `<p>` não é HTML válido: o navegador FECHA o de fora antes do
   de dentro, e o layout desmonta em silêncio. Nenhum validador reclama porque o
   HTML servido está "certo"; quem quebra é a árvore que o navegador monta.

   Então: um parágrafo só vira o conteúdo dele. Dois ou mais ficam como estão —
   nesses lugares o contêiner é um `<div>`, que aceita.
   -------------------------------------------------------------------------- */
function linhaUnica(html) {
  const t = String(html || "").trim();
  const m = /^<p>([\s\S]*)<\/p>$/i.exec(t);
  if (!m) return t;
  return /<p[\s>]/i.test(m[1]) ? t : m[1].trim();   // <p> aninhado: não era um só
}

/* --------------------------------------------------------------------------
   TEXTO ANTIGO → HTML

   O conteúdo que já está no banco é texto puro, com parágrafos separados por
   linha em branco — foi assim que o site nasceu. Jogado direto na página agora
   que os campos aceitam HTML, ele vira UM bloco só: quebra de linha não é
   marcação, e o navegador não a transforma em parágrafo.

   Converter aqui, na leitura, em vez de migrar o banco de uma vez: a migração
   teria de acertar de primeira em cima do conteúdo real do cliente, e um erro
   nela não tem volta. Assim o texto antigo aparece certo sem ninguém tocar no
   banco, e vai virando HTML de verdade conforme cada campo for editado.

   O teste de "já é HTML?" olha as tags de BLOCO e as inline mais comuns. Um
   texto puro que por acaso contenha "<p" já teria sido escapado antes de
   chegar aqui — o higienizador transforma `<` solto em `&lt;`.
   -------------------------------------------------------------------------- */
function comoHtml(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/<(p|br|ul|ol|li|h[2-6]|blockquote|div|figure|table|strong|b|em|i|a|span)[\s>/]/i.test(s)) return s;
  return s.split(/\n{2,}/).map((par) => `<p>${par.trim().replace(/\n/g, "<br>")}</p>`).join("");
}

/* HTML → texto puro. Para `<title>`, `<meta description>` e os campos do feed
   do portal, onde marcação apareceria literalmente na tela do visitante. */
const semHtml = (h) => String(h || "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

module.exports = { sanitizarHtml, linhaUnica, semHtml, comoHtml, urlSegura, esc, TAGS_OK, ATRIB_OK };
