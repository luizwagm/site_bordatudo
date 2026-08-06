/* ==========================================================================
   Cria ou atualiza um usuário do /restrito.

       node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"

   A SENHA NÃO VEM NA LINHA DE COMANDO, de propósito. Argumento de processo
   aparece no `ps` para qualquer usuário da máquina e fica no histórico do
   terminal. Aqui ela é GERADA, mostrada uma vez e nunca mais — quem recebe
   troca no primeiro acesso.

   Rodar de novo com o mesmo usuário TROCA a senha e mostra a nova. É assim que
   se atende "esqueci a senha" sem ninguém precisar ler senha de ninguém.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Q, carregarAmbiente } = require("./pg.js");
const { gerarHash } = require("./restrito.js");

carregarAmbiente(__dirname);

const [, , usuarioArg, papelArg = "operador", ...resto] = process.argv;
const usuario = String(usuarioArg || "").trim().toLowerCase();
const papel = String(papelArg).trim();
const nome = resto.join(" ").trim() || usuario;

if (!/^[a-z][a-z0-9._-]{2,31}$/.test(usuario)) {
  console.error('  uso: node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"');
  console.error("  o usuário começa com letra e tem de 3 a 32 caracteres (a-z 0-9 . _ -)");
  process.exit(1);
}
if (!["admin", "operador"].includes(papel)) {
  console.error("  o papel é 'admin' ou 'operador'");
  process.exit(1);
}

/* Quatro blocos de quatro, sem vogais nem 0/O/1/l/I. É senha que se dita por
   telefone e se digita numa tela de fábrica sem errar — e ainda assim tem
   entropia de sobra porque são 16 caracteres de um alfabeto de 27. */
function senhaFacil() {
  const abc = "bcdfghjkmnpqrstvwxyz23456789";
  const bloco = () => Array.from({ length: 4 }, () =>
    abc[crypto.randomInt(abc.length)]).join("");
  return [bloco(), bloco(), bloco(), bloco()].join("-");
}

(async () => {
  const senha = senhaFacil();
  const hash = gerarHash(senha);

  const existe = await Q.get("SELECT id FROM usuarios WHERE usuario = ?", usuario);
  if (existe) {
    await Q.run("UPDATE usuarios SET nome = ?, papel = ?, senha_hash = ?, ativo = TRUE WHERE id = ?",
      nome, papel, hash, existe.id);
    console.log(`\n  usuário ATUALIZADO: ${usuario} (${papel})`);
  } else {
    await Q.run("INSERT INTO usuarios (usuario, nome, senha_hash, papel) VALUES (?, ?, ?, ?)",
      usuario, nome, hash, papel);
    console.log(`\n  usuário CRIADO: ${usuario} (${papel})`);
  }

  console.log(`  nome:  ${nome}`);
  console.log(`  senha: ${senha}`);
  console.log("\n  Anote agora — ela não é mostrada de novo.\n");
})().catch((e) => {
  console.error("\n  ✖ " + String(e.message).split("\n")[0]);
  process.exit(1);
}).finally(() => Q.fechar());
