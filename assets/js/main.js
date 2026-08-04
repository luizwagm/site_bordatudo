/* ==========================================================================
   BORDA TUDO — comportamento do site

   Tudo aqui é melhoria: sem este arquivo a página continua legível, navegável
   e com todos os links funcionando. Nada de conteúdo depende de JavaScript —
   é o que mantém a página utilizável em conexão ruim e indexável sem esforço.
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- menu */
  var botao = document.getElementById("menu-botao");
  var nav = document.getElementById("nav");
  if (botao && nav) {
    botao.addEventListener("click", function () {
      var aberto = botao.getAttribute("aria-expanded") === "true";
      botao.setAttribute("aria-expanded", String(!aberto));
      botao.setAttribute("aria-label", aberto ? "Abrir menu" : "Fechar menu");
      nav.classList.toggle("aberto", !aberto);
    });
    /* Escolher um item fecha o menu. Sem isto, no celular a pessoa toca no
       link, a página rola por trás e o painel continua tapando o conteúdo. */
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        botao.setAttribute("aria-expanded", "false");
        nav.classList.remove("aberto");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("aberto")) {
        botao.setAttribute("aria-expanded", "false");
        nav.classList.remove("aberto");
        botao.focus();
      }
    });
  }

  /* ------------------------------------------------------- topo ao rolar */
  var topo = document.getElementById("topo");
  if (topo) {
    var ultimo = -1;
    var marcar = function () {
      var rolou = window.scrollY > 12;
      if (rolou !== ultimo) { topo.classList.toggle("rolou", rolou); ultimo = rolou; }
    };
    marcar();
    /* `passive: true`: sem isso o navegador precisa esperar o ouvinte para
       saber se ele vai cancelar a rolagem, e a página trava sob o dedo. */
    window.addEventListener("scroll", marcar, { passive: true });
  }

  /* ------------------------------------------------- entrada das seções */
  var comMovimento = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var surgem = document.querySelectorAll(".surge");

  if (!comMovimento || !("IntersectionObserver" in window)) {
    /* Sem observador ou com movimento reduzido, tudo aparece de uma vez. O
       conteúdo NUNCA pode ficar preso em opacidade zero. */
    for (var i = 0; i < surgem.length; i++) surgem[i].classList.add("visivel");
  } else {
    var olho = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("visivel");
        olho.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    for (var j = 0; j < surgem.length; j++) olho.observe(surgem[j]);

    /* REDE DE SEGURANÇA. Se o observador não disparar por qualquer motivo —
       navegador em modo estranho, aba que nunca compõe quadro, container de
       rolagem inesperado —, o conteúdo ficaria preso em opacidade zero e a
       página apareceria com cabeçalho, rodapé e um vazio no meio.
       Passados 4 segundos, tudo aparece de qualquer jeito. Perder a animação
       é irrelevante; perder o conteúdo, não. */
    setTimeout(function () {
      for (var k = 0; k < surgem.length; k++) surgem[k].classList.add("visivel");
    }, 4000);
  }

  /* ------------------------------------------------------------ o fio ---
     O traço da logo se desenha conforme a seção entra na tela. O comprimento
     é medido do próprio caminho: chutar um número deixa o traço aparecendo
     pela metade ou já pronto antes de começar. */
  document.querySelectorAll(".fio").forEach(function (svg) {
    var caminho = svg.querySelector("path");
    if (!caminho || !caminho.getTotalLength) return;
    var comprimento = Math.ceil(caminho.getTotalLength());
    caminho.style.setProperty("--comprimento", comprimento);
    if (!comMovimento) { svg.classList.add("bordando"); return; }
    if (!("IntersectionObserver" in window)) { svg.classList.add("bordando"); return; }
    var obs = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { svg.classList.add("bordando"); obs.disconnect(); } });
    }, { threshold: 0.15 });
    obs.observe(svg.parentElement || svg);
  });

  /* --------------------------------------------------- filtro da vitrine */
  var filtros = document.querySelectorAll(".filtro");
  if (filtros.length) {
    filtros.forEach(function (b) {
      b.addEventListener("click", function () {
        var alvo = b.dataset.filtro || "";
        filtros.forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        document.querySelectorAll(".peca").forEach(function (p) {
          var mostra = !alvo || p.dataset.categoria === alvo;
          p.hidden = !mostra;
        });
      });
    });
  }

  /* ---------------------------------------------------------- aviso LGPD
     A contagem de acesso do servidor conta quem CARREGA a página. Este aviso
     controla o que fica guardado no navegador; recusar não quebra nada, só
     não guarda a escolha para a próxima visita. */
  var CHAVE = "bt-privacidade";
  var aviso = document.getElementById("aviso-lgpd");
  if (aviso) {
    var jaRespondeu = false;
    try { jaRespondeu = !!localStorage.getItem(CHAVE); } catch (e) { jaRespondeu = true; }
    if (!jaRespondeu) {
      aviso.hidden = false;
      requestAnimationFrame(function () { aviso.classList.add("aberto"); });
    }
    aviso.addEventListener("click", function (e) {
      var b = e.target.closest("[data-lgpd]");
      if (!b) return;
      try { localStorage.setItem(CHAVE, b.dataset.lgpd); } catch (err) { /* modo privado */ }
      aviso.classList.remove("aberto");
      setTimeout(function () { aviso.hidden = true; }, 340);
    });
  }

  /* ------------------------------------------------ formulário de orçamento
     Não grava nada: monta a mensagem e abre a conversa. Sem banco de leads não
     há dado pessoal parado em servidor — e nem obrigação de guardá-lo. */
  var form = document.getElementById("form-orcamento");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = new FormData(form);
      var linhas = [];
      linhas.push("*Pedido de orçamento — Borda Tudo*");
      linhas.push("");
      [["nome", "Nome"], ["empresa", "Empresa"], ["telefone", "Telefone"],
       ["tipo", "Tipo de bordado"], ["peca", "Peça"], ["tecido", "Tecido"],
       ["quantidade", "Quantidade"], ["prazo", "Prazo desejado"],
       ["detalhes", "Detalhes"]].forEach(function (par) {
        var v = (d.get(par[0]) || "").toString().trim();
        if (v) linhas.push(par[1] + ": " + v);
      });
      var numero = form.dataset.zap || "";
      window.open("https://wa.me/" + numero + "?text=" + encodeURIComponent(linhas.join("\n")), "_blank", "noopener");
    });
  }

  /* ------------------------------------------------------------- busca */
  var campoBusca = document.getElementById("campo-busca");
  if (campoBusca) {
    var itens = Array.prototype.slice.call(document.querySelectorAll("[data-busca]"));
    var vazio = document.getElementById("busca-vazia");
    campoBusca.addEventListener("input", function () {
      var q = campoBusca.value.trim().toLowerCase();
      var achou = 0;
      itens.forEach(function (el) {
        var bate = !q || (el.dataset.busca || "").toLowerCase().indexOf(q) >= 0;
        el.hidden = !bate;
        if (bate) achou++;
      });
      if (vazio) vazio.hidden = achou > 0;
    });
  }
})();
