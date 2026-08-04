/* ==========================================================================
   db.js — o ÚNICO lugar que abre banco neste projeto

   Por que existe: o `node:sqlite` é marcado como EXPERIMENTAL pelo próprio
   Node — ele imprime um aviso a cada boot e a API pode mudar entre versões
   menores. Num site que vai ficar anos no ar, isso é uma dependência instável
   escondida no meio do servidor.

   O `better-sqlite3` é a biblioteca estável e é a preferida aqui. Mas ela é um
   módulo NATIVO: precisa de `npm install` e pode faltar num servidor onde
   ninguém rodou o comando. Se faltasse e o require estourasse no topo, o SITE
   INTEIRO sairia do ar por causa de uma dependência — trocaríamos um risco
   pequeno por um grande.

   Então a ordem é: tenta o estável, e se ele não estiver instalado volta para o
   de fábrica com um AVISO no boot. O site continua no ar nos dois casos, e
   quem opera fica sabendo em qual está.
   ========================================================================== */
let motor = null, nome = "", aviso = "";

try {
  const Better = require("better-sqlite3");

  /* ABRIR UM BANCO DE MENTIRA AQUI NÃO É EXCESSO DE ZELO.
     O `require` do better-sqlite3 carrega só JavaScript e passa mesmo quando o
     binário nativo não serve para este Node. O erro real — `ERR_DLOPEN_FAILED`
     ou `invalid ELF header` — só aparece ao CONSTRUIR o primeiro banco, uma
     linha depois, já fora deste `try`. Resultado: o desvio que existe para
     manter o site de pé nunca disparava justamente no caso mais provável, que
     é módulo compilado para outra versão ou copiado de outra máquina.
     Aconteceu na primeira subida deste projeto. */
  new Better(":memory:").close();

  motor = (arquivo) => new Better(arquivo);
  nome = "better-sqlite3";
} catch {
  const { DatabaseSync } = require("node:sqlite");
  /* A API dos dois é quase igual, mas não idêntica: o `node:sqlite` não tem
     `pragma()`. Como o resto do código só usa prepare/exec/run/get/all, um
     invólucro fino resolve — e mantém o resto do servidor sem saber qual dos
     dois está rodando. */
  motor = (arquivo) => new DatabaseSync(arquivo);
  nome = "node:sqlite (experimental)";
  aviso = "rode `npm ci` para usar o driver estável (better-sqlite3)";
}

function abrirBanco(arquivo) {
  const db = motor(arquivo);
  /* WAL: leitura e escrita deixam de esperar uma pela outra. Num site que
     publica enquanto alguém navega, é a diferença entre responder e travar. */
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch { /* driver sem suporte */ }
  return db;
}

module.exports = { abrirBanco, DRIVER_NOME: nome, DRIVER_AVISO: aviso };
