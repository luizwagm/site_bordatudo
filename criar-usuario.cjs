/* ==========================================================================
   Cria ou atualiza um usuário do /restrito PELO TERMINAL.

       node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"

   NO DIA A DIA NÃO SE USA ISTO. Usuário se cria e se edita no painel, em
   Cadastros → Usuários, com o botão "Novo". Este arquivo existe para dois
   casos em que o painel não serve:

     1. O PRIMEIRO administrador. Antes dele não há ninguém para entrar no
        painel e criar alguém.
     2. Ficou todo mundo trancado para fora — último admin desativado por
        engano, senha perdida sem outro administrador para redefinir.

   A SENHA NÃO VEM NA LINHA DE COMANDO, de propósito: argumento de processo
   aparece no `ps` para qualquer usuário da máquina e fica no histórico do
   terminal. Ela é GERADA, mostrada uma vez e nunca mais.

   Rodar de novo com o mesmo usuário TROCA a senha e mostra a nova.
   ========================================================================== */
"use strict";

const path = require("node:path");
const { Q, carregarAmbiente } = require("./pg.js");
const { gerarHash, senhaProvisoria } = require("./restrito.js");

carregarAmbiente(__dirname);

const [, , usuarioArg, papelArg = "operador", ...resto] = process.argv;
const usuario = String(usuarioArg || "").trim().toLowerCase();
const papel = String(papelArg).trim();
const nome = resto.join(" ").trim() || usuario;

if (!/^[a-z][a-z0-9._-]{2,31}$/.test(usuario)) {
  console.error('  uso: node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"');
  console.error("  o usuário começa com letra e tem de 3 a 32 caracteres (a-z 0-9 . _ -)");
  console.error("\n  no dia a dia: painel → Cadastros → Usuários → Novo");
  process.exit(1);
}
if (!["admin", "operador"].includes(papel)) {
  console.error("  o papel é 'admin' ou 'operador'");
  process.exit(1);
}

(async () => {
  /* A regra de senha é a MESMA do painel porque vem da mesma função. Duas
     cópias divergiriam, e a diferença só apareceria quando alguém não
     conseguisse ditar a senha por telefone. */
  const senha = senhaProvisoria();
  const hash = gerarHash(senha);

  const existe = await Q.get("SELECT id FROM usuarios WHERE usuario = ?", usuario);
  if (existe) {
    await Q.run(`UPDATE usuarios SET nome = ?, papel = ?, senha_hash = ?, ativo = TRUE,
                        senha_provisoria = TRUE WHERE id = ?`,
      nome, papel, hash, existe.id);
    console.log(`\n  usuário ATUALIZADO: ${usuario} (${papel})`);
  } else {
    await Q.run(`INSERT INTO usuarios (usuario, nome, senha_hash, papel, senha_provisoria)
                 VALUES (?, ?, ?, ?, TRUE)`, usuario, nome, hash, papel);
    console.log(`\n  usuário CRIADO: ${usuario} (${papel})`);
  }

  console.log(`  nome:  ${nome}`);
  console.log(`  senha: ${senha}`);
  console.log("\n  Anote agora — ela não é mostrada de novo.");
  console.log("  É senha DE USO ÚNICO: no primeiro acesso o sistema exige a troca");
  console.log("  e não deixa fazer mais nada antes disso.");
  console.log("  A partir daqui, use o painel: Cadastros → Usuários.\n");
})().catch((e) => {
  console.error("\n  ✖ " + String(e.message).split("\n")[0]);
  process.exit(1);
}).finally(() => Q.fechar());
