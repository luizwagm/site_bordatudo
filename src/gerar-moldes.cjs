/* ==========================================================================
   Gera os moldes internos a partir do cabeçalho e rodapé da home.

   POR QUE EXISTE: cabeçalho, rodapé e aviso de privacidade são idênticos em
   todas as páginas. Escritos à mão sete vezes, começam iguais e terminam
   diferentes — alguém corrige um link em três arquivos e esquece do quarto, e
   o menu do site passa a mudar conforme a página.

   NÃO É ETAPA DE BUILD. Roda uma vez, cospe arquivos normais em src/, e
   depois disso cada molde é editado à mão como qualquer outro. Rodar de novo
   sobrescreve — por isso o aviso no topo de cada arquivo gerado.

   Uso:  node src/gerar-moldes.cjs
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SRC = __dirname;
const casca = fs.readFileSync(path.join(SRC, "molde-home.html"), "utf8");

const ABRE = '<main id="conteudo">';
const FECHA = "</main>";
const topo = casca.slice(0, casca.indexOf(ABRE) + ABRE.length);
const base = casca.slice(casca.indexOf(FECHA));

/* Faixa de abertura das páginas internas. Curta de propósito: o cabeçalho é
   fixo e o menu é claro, então o conteúdo precisa começar sobre fundo escuro
   — senão os links do menu somem sobre o branco ao rolar. */
const faixa = (rotulo, titulo, lead) => `
<section class="heroi tecido--escuro" style="padding-bottom:clamp(2rem,4vw,3rem)">
  <svg class="fio fio--claro" viewBox="0 0 1440 320" preserveAspectRatio="none" aria-hidden="true">
    <path d="M-40 250 C 300 250, 420 60, 760 110 S 1180 260, 1480 150"/>
  </svg>
  <div class="envolve" style="position:relative;z-index:2">
    <p class="secao__rotulo" style="color:var(--linha-viva)">${rotulo}</p>
    <h1 class="secao__titulo">${titulo}</h1>
    ${lead ? `<p class="heroi__lead">${lead}</p>` : ""}
  </div>
</section>`;

const chamada = (titulo, texto) => `
<section class="secao secao--escura tecido--escuro">
  <div class="envolve envolve--estreito" style="text-align:center">
    <p class="secao__rotulo"><!--#SEC_ORCA_ROTULO--><!--/SEC_ORCA_ROTULO--></p>
    <h2 class="secao__titulo">${titulo}</h2>
    <p class="secao__lead" style="margin-inline:auto">${texto}</p>
    <div class="grupo-botoes" style="justify-content:center;margin-top:var(--e6)">
      <a class="botao botao--principal" href="/orcamento/">Montar meu orçamento</a>
      <a class="botao botao--zap" href="{{ZAP_ORCAMENTO}}" target="_blank" rel="noopener">Falar no WhatsApp</a>
    </div>
  </div>
</section>`;

const PAGINAS = [
  {
    arquivo: "molde-servicos.html",
    rota: "/servicos/",
    menu: "Serviços",
    titulo: "Tipos de bordado — Borda Tudo · Caruaru-PE",
    descricao: "Ponto cheio, matelassê, boné, etiqueta, monograma e digitalização de arte: o que cada técnica resolve, em que material funciona e onde ela para.",
    corpo: faixa(
      "<!--#SEC_SERVICOS_ROTULO--><!--/SEC_SERVICOS_ROTULO-->",
      "<!--#SEC_SERVICOS_TITULO--><!--/SEC_SERVICOS_TITULO-->",
      "<!--#SEC_SERVICOS_LEAD--><!--/SEC_SERVICOS_LEAD-->") + `

<section class="secao tecido" id="lote">
  <div class="envolve">
    <div class="grade"><!--#SERVICOS--><!--/SERVICOS--></div>
  </div>
</section>

<hr class="ponto-corrente">

<section class="secao secao--macia" id="arte">
  <div class="envolve">
    <div class="secao__cabeca">
      <p class="secao__rotulo"><!--#SEC_COMO_ROTULO--><!--/SEC_COMO_ROTULO--></p>
      <h2 class="secao__titulo"><!--#SEC_COMO_TITULO--><!--/SEC_COMO_TITULO--></h2>
      <p class="secao__lead"><!--#SEC_COMO_LEAD--><!--/SEC_COMO_LEAD--></p>
    </div>
    <div class="passos" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))">
      ${[1, 2, 3, 4].map((n) => `<div class="passo surge">
        <h3 class="passo__titulo"><!--#PASSO${n}_TITULO--><!--/PASSO${n}_TITULO--></h3>
        <p class="passo__texto"><!--#PASSO${n}_TEXTO--><!--/PASSO${n}_TEXTO--></p>
      </div>`).join("\n      ")}
    </div>
  </div>
</section>
` + chamada("Sua peça não está na lista?",
     "Bordamos em quase tudo que passa no bastidor. Manda uma foto da peça que a gente diz se dá e como."),
  },

  {
    arquivo: "molde-empresa.html",
    rota: "/empresa/",
    menu: "A empresa",
    titulo: "A empresa — Borda Tudo · Bordados Computadorizados",
    descricao: "Bordado computadorizado em Caruaru, no maior polo de confecção do Nordeste. Atendemos produção em escala e peça avulsa com a mesma exigência de acabamento.",
    corpo: faixa(
      "<!--#SEC_EMPRESA_ROTULO--><!--/SEC_EMPRESA_ROTULO-->",
      "<!--#SEC_EMPRESA_TITULO--><!--/SEC_EMPRESA_TITULO-->", "") + `

<section class="secao tecido">
  <div class="envolve heroi__grade">
    <div class="rico secao__lead"><!--#SEC_EMPRESA_TEXTO--><!--/SEC_EMPRESA_TEXTO--></div>
    <figure>
      <div class="bastidor" style="max-width:420px;margin-inline:auto">
        <img src="{{SEC_EMPRESA_IMAGEM}}" alt="{{SEC_EMPRESA_IMAGEM_ALT}}" width="600" height="600" loading="lazy" decoding="async">
      </div>
    </figure>
  </div>
</section>

<hr class="ponto-corrente">

<section class="secao secao--macia">
  <div class="envolve">
    <div class="secao__cabeca">
      <p class="secao__rotulo"><!--#SEC_PORQUE_ROTULO--><!--/SEC_PORQUE_ROTULO--></p>
      <h2 class="secao__titulo"><!--#SEC_PORQUE_TITULO--><!--/SEC_PORQUE_TITULO--></h2>
    </div>
    <div class="secao__lead rico"><!--#SEC_PORQUE_TEXTO--><!--/SEC_PORQUE_TEXTO--></div>
    <div class="rico" style="margin-top:var(--e5)"><!--#PORQUE_ITENS--><!--/PORQUE_ITENS--></div>
  </div>
</section>
` + chamada("Quer conhecer o trabalho?",
     "Passe na oficina ou peça uma amostra bordada no tecido do seu lote."),
  },

  {
    arquivo: "molde-orcamento.html",
    rota: "/orcamento/",
    menu: "Orçamento",
    titulo: "Pedir orçamento — Borda Tudo · Caruaru-PE",
    descricao: "Monte seu pedido de orçamento de bordado e envie direto pelo WhatsApp. Nada fica gravado no site.",
    corpo: faixa(
      "<!--#SEC_ORCA_ROTULO--><!--/SEC_ORCA_ROTULO-->",
      "<!--#SEC_ORCA_TITULO--><!--/SEC_ORCA_TITULO-->",
      "<!--#SEC_ORCA_LEAD--><!--/SEC_ORCA_LEAD-->") + `

<section class="secao tecido">
  <div class="envolve envolve--estreito">
    <!-- SEM ENVIO PARA O SERVIDOR, DE PROPÓSITO.
         O formulário monta a mensagem e abre a conversa. Não existe banco de
         leads: nenhum dado pessoal fica parado aqui, e com ele some toda a
         obrigação de guarda, prazo de descarte e resposta a pedido de exclusão
         que viria junto. Quem recebe o dado é o WhatsApp da empresa, onde o
         cliente já ia falar de qualquer jeito. -->
    <form class="form" id="form-orcamento" data-zap="{{WHATSAPP}}" novalidate>
      <div class="form__linha form__linha--2">
        <div><label for="f-nome">Seu nome</label><input id="f-nome" name="nome" required autocomplete="name"></div>
        <div><label for="f-empresa">Empresa (se houver)</label><input id="f-empresa" name="empresa" autocomplete="organization"></div>
      </div>
      <div class="form__linha form__linha--2">
        <div><label for="f-telefone">Telefone</label><input id="f-telefone" name="telefone" inputmode="tel" autocomplete="tel"></div>
        <div>
          <label for="f-tipo">Tipo de bordado</label>
          <select id="f-tipo" name="tipo">
            <option value="">Não sei ainda</option>
            <option>Logotipo em peça</option>
            <option>Etiqueta ou patch</option>
            <option>Boné</option>
            <option>Uniforme</option>
            <option>Monograma / peça avulsa</option>
            <option>Matelassê</option>
            <option>Lote para confecção</option>
          </select>
        </div>
      </div>
      <div class="form__linha form__linha--2">
        <div><label for="f-peca">Qual peça</label><input id="f-peca" name="peca" placeholder="camisa, jaqueta, boné, toalha…"></div>
        <div><label for="f-tecido">Tecido</label><input id="f-tecido" name="tecido" placeholder="malha, jeans, sarja…"></div>
      </div>
      <div class="form__linha form__linha--2">
        <div><label for="f-quantidade">Quantidade</label><input id="f-quantidade" name="quantidade" inputmode="numeric" placeholder="10, 500, 2000…"></div>
        <div><label for="f-prazo">Prazo desejado</label><input id="f-prazo" name="prazo" placeholder="para quando você precisa"></div>
      </div>
      <div>
        <label for="f-detalhes">Detalhes</label>
        <textarea id="f-detalhes" name="detalhes" placeholder="Descreva a arte, as cores, onde vai o bordado. Se tiver o arquivo, é só mandar na conversa depois."></textarea>
      </div>
      <div class="grupo-botoes">
        <button class="botao botao--zap" type="submit"><!--#SEC_ORCA_BOTAO--><!--/SEC_ORCA_BOTAO--></button>
      </div>
      <p class="form__ajuda">
        Ao enviar, abrimos o WhatsApp com a mensagem montada — você confere antes de mandar.
        Nada é gravado neste site. <a href="/privacidade/">Como tratamos seus dados</a>.
      </p>
    </form>
  </div>
</section>

<section class="secao secao--macia">
  <div class="envolve envolve--estreito">
    <div class="secao__cabeca">
      <p class="secao__rotulo"><!--#SEC_DUVIDAS_ROTULO--><!--/SEC_DUVIDAS_ROTULO--></p>
      <h2 class="secao__titulo"><!--#SEC_DUVIDAS_TITULO--><!--/SEC_DUVIDAS_TITULO--></h2>
    </div>
    <!--#DUVIDAS--><!--/DUVIDAS-->
  </div>
</section>`,
  },

  {
    arquivo: "molde-privacidade.html",
    rota: "/privacidade/",
    menu: "",
    titulo: "Privacidade — Borda Tudo",
    descricao: "Como a Borda Tudo trata seus dados: o que é coletado, por quanto tempo e como pedir exclusão.",
    corpo: faixa("Privacidade", "Como tratamos seus dados",
      "Em resumo: quase nada é coletado, e o pouco que é serve só para contar quantas pessoas visitam o site.") + `

<section class="secao tecido">
  <div class="envolve envolve--estreito rico">
    <h2>O que este site coleta</h2>
    <p>Uma contagem diária de visitas, e só depois de você aceitar o aviso. Para não contar
       a mesma pessoa duas vezes no dia, o endereço de internet é transformado em um código
       irreversível junto com uma chave desta instalação — o endereço em si <b>nunca é gravado</b>,
       e do código não é possível voltar ao endereço.</p>

    <h2>O que este site NÃO faz</h2>
    <ul>
      <li>Não guarda formulário. O pedido de orçamento abre o WhatsApp; nada fica no servidor.</li>
      <li>Não usa mapa embutido nem vídeo de terceiro, que carregariam rastreador antes do seu aceite.</li>
      <li>Não vende, aluga nem compartilha dado nenhum.</li>
      <li>Não usa fonte de letra hospedada em outro domínio.</li>
    </ul>

    <h2>WhatsApp e Instagram</h2>
    <p>Ao clicar nos nossos links, você sai deste site e passa a ser tratado pela política de
       privacidade dessas plataformas, que não controlamos.</p>

    <h2>Seus direitos</h2>
    <p>Pela Lei Geral de Proteção de Dados você pode pedir confirmação, acesso, correção ou
       exclusão dos seus dados. Como aqui não guardamos cadastro, na prática o pedido se
       resolve na conversa: fale com a gente pelo WhatsApp
       <a href="{{ZAP_ORCAMENTO}}" target="_blank" rel="noopener">{{WHATSAPP}}</a>.</p>

    <h2>Mudanças</h2>
    <p>Se esta política mudar, a data abaixo muda junto.</p>
    <p><b>Borda Tudo — Bordados Computadorizados</b><br>
       CNPJ <!--#CNPJ--><!--/CNPJ--> · <!--#ENDERECO--><!--/ENDERECO--></p>
  </div>
</section>`,
  },

  {
    arquivo: "molde-busca.html",
    rota: "/busca/",
    menu: "",
    titulo: "Busca — Borda Tudo",
    descricao: "Procure por tipo de bordado, peça ou material.",
    corpo: faixa("Busca", "O que você procura?",
      "Digite abaixo: filtra serviços, peças da vitrine e dúvidas ao mesmo tempo.") + `

<section class="secao tecido">
  <div class="envolve">
    <div class="form" style="max-width:520px;margin-bottom:var(--e7)">
      <div>
        <label for="campo-busca">Buscar</label>
        <input id="campo-busca" type="search" placeholder="boné, jeans, etiqueta, prazo…" autocomplete="off">
      </div>
    </div>
    <p id="busca-vazia" hidden class="secao__lead">Nada encontrado com esse termo. Tente uma palavra mais curta.</p>
    <div class="grade"><!--#SERVICOS--><!--/SERVICOS--></div>
    <div style="margin-top:var(--e7)"><!--#VITRINE_TUDO--><!--/VITRINE_TUDO--></div>
  </div>
</section>`,
  },
];

/* --------------------------------------------------------------------- */
const AVISO = `<!-- GERADO por src/gerar-moldes.cjs a partir do cabeçalho e rodapé da home.
     Pode editar à mão daqui em diante — mas rodar o gerador de novo
     sobrescreve. Mexeu no cabeçalho ou no rodapé? Mexa na home e gere de novo. -->
`;

for (const p of PAGINAS) {
  let cabeca = topo
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${p.titulo}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(">)/, `$1${p.descricao}$2`)
    .replace(/(<link rel="canonical" href="https:\/\/bordatudo\.com)[^"]*(">)/, `$1${p.rota}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, `$1${p.titulo}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, `$1${p.descricao}$2`);

  /* `aria-current` diz ao leitor de tela em que página a pessoa está. Sem
     isso o menu inteiro soa igual, e quem não vê a cor não sabe onde está. */
  if (p.menu) {
    cabeca = cabeca.replace(
      new RegExp(`(<a href="${p.rota.replace(/\//g, "\\/")}")>`),
      '$1 aria-current="page">');
  }

  /* A home é a única com dados estruturados: repetir o mesmo LocalBusiness em
     toda página não acrescenta nada e ainda cria ruído para o Google. */
  cabeca = cabeca.replace("<!--#JSONLD--><!--/JSONLD-->\n", "");

  const saida = AVISO + cabeca + "\n" + p.corpo.trim() + "\n\n" + base;
  fs.writeFileSync(path.join(SRC, p.arquivo), saida, "utf8");
  console.log(`  ${p.arquivo.padEnd(26)} ${saida.split("\n").length} linhas`);
}
console.log(`\n  ${PAGINAS.length} moldes gerados.`);
