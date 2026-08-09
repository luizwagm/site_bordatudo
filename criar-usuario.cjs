/* ==========================================================================
   Cria ou atualiza um usuário do /restrito PELO TERMINAL.

       node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"
       node criar-usuario.cjs --dono <usuario> "<Nome>"

   NO DIA A DIA NÃO SE USA ISTO. Usuário se cria e se edita no painel, em
   Cadastros → Usuários, com o botão "Novo". Este arquivo existe para três
   casos em que o painel não serve:

     1. O PRIMEIRO administrador. Antes dele não há ninguém para entrar no
        painel e criar alguém.
     2. Ficou todo mundo trancado para fora — último admin desativado por
        engano, senha perdida sem outro administrador para redefinir.
     3. A CONTA DE DONO, que o painel não mostra nem toca. Ver abaixo.

   A SENHA NÃO VEM NA LINHA DE COMANDO, de propósito: argumento de processo
   aparece no `ps` para qualquer usuário da máquina e fica no histórico do
   terminal. Ela é GERADA, mostrada uma vez e nunca mais.

   Rodar de novo com o mesmo usuário TROCA a senha e mostra a nova.

   --------------------------------------------------------------------------
   A CONTA DE DONO

   Um papel acima de `admin`, para manutenção. Ela não aparece na lista de
   usuários do painel e nenhuma tela a altera, desativa, apaga ou redefine —
   este arquivo é a única porta.

   Só pode existir UMA. Quem garante isso é um índice único no banco
   (`ux_usuarios_um_dono`), não a conferência daqui: duas execuções ao mesmo
   tempo passariam pela conferência e o banco recusaria a segunda. A
   conferência existe para a mensagem ser legível, não para ser a trava.

   A SENHA DELA É DIFERENTE das outras, em duas coisas:

     · não é de uso único. As demais nascem com seis dígitos que o sistema
       obriga a trocar no primeiro acesso; o dono NÃO PODE trocar senha pela
       tela, então uma senha de seis dígitos ficaria valendo para sempre —
       um milhão de combinações numa conta com poder sobre tudo;
     · é longa e sorteada aqui, para ser guardada num gerenciador de senhas,
       não decorada nem ditada por telefone.
   -------------------------------------------------------------------------- */
"use strict";

const crypto = require("node:crypto");
const { Q, carregarAmbiente } = require("./pg.js");
const { gerarHash, senhaProvisoria } = require("./restrito.js");

carregarAmbiente(__dirname);

/* Alfabeto SEM caracteres que se confundem ao ler de uma tela: nada de O/0,
   I/l/1, S/5, Z/2. Quem for copiar esta senha vai copiá-la à mão pelo menos
   uma vez, e "senha errada" por causa de um zero lido como ó é o tipo de
   problema que consome uma tarde. */
const ALFABETO = "abcdefghjkmnpqrtuvwxyzACDEFGHJKLMNPQRTUVWXY34679";

/* Cinco grupos de cinco. Com 47 símbolos, são ~139 bits de entropia — fora do
   alcance de qualquer ataque, inclusive de quem tiver o banco na mão. Os
   hifens não somam segurança; somam a chance de a senha ser transcrita certa. */
function senhaForte() {
  const g = () => Array.from({ length: 5 }, () => ALFABETO[crypto.randomInt(0, ALFABETO.length)]).join("");
  return Array.from({ length: 5 }, g).join("-");
}

const argv = process.argv.slice(2);
const querDono = argv[0] === "--dono";
const [usuarioArg, ...resto] = querDono ? argv.slice(1) : argv;

const usuario = String(usuarioArg || "").trim().toLowerCase();
const papel = querDono ? "dono" : String(resto.shift() || "operador").trim();
const nome = resto.join(" ").trim() || usuario;

function ajuda(erro) {
  console.error("  " + erro);
  console.error('\n  uso: node criar-usuario.cjs <usuario> <admin|operador> "<Nome>"');
  console.error('       node criar-usuario.cjs --dono <usuario> "<Nome>"');
  console.error("\n  o usuário começa com letra e tem de 3 a 32 caracteres (a-z 0-9 . _ -)");
  console.error("  no dia a dia: painel → Cadastros → Usuários → Novo");
  process.exit(1);
}

if (!/^[a-z][a-z0-9._-]{2,31}$/.test(usuario)) ajuda("usuário inválido.");
if (!["admin", "operador", "dono"].includes(papel)) ajuda("o papel é 'admin' ou 'operador'.");
/* `dono` como terceiro argumento não vale — tem de ser a bandeira. Sem isto,
   `node criar-usuario.cjs fulano dono` criaria a conta de manutenção sem que
   quem digitou tivesse lido uma linha do que ela é. */
if (papel === "dono" && !querDono) ajuda("para criar a conta de dono use a bandeira --dono.");

(async () => {
  if (querDono) {
    /* O dono existente, se houver. A comparação é por PAPEL e não por login:
       a pergunta é "já existe uma conta de dono", e ela pode ter qualquer
       nome. */
    const atual = await Q.get("SELECT id, usuario FROM usuarios WHERE papel = 'dono'");
    if (atual && atual.usuario !== usuario) {
      console.error(`\n  ✖ já existe uma conta de dono: ${atual.usuario}`);
      console.error("    Só pode haver uma. Para trocar a senha dela:");
      console.error(`      node criar-usuario.cjs --dono ${atual.usuario}`);
      console.error("    Para passar o posto a outro login, rebaixe a atual primeiro,");
      console.error("    direto no banco — é decisão que não deve ser fácil:");
      console.error(`      UPDATE usuarios SET papel = 'admin' WHERE usuario = '${atual.usuario}';`);
      process.exit(1);
    }

    const senha = senhaForte();
    const hash = gerarHash(senha);

    /* `senha_provisoria = FALSE` é obrigatório aqui, e não detalhe. Com TRUE,
       o sistema exigiria a troca no primeiro acesso — e a rota de trocar
       senha recusa o dono. A conta nasceria trancada para fora, e a única
       conta capaz de destrancar as outras seria a que ninguém destranca. */
    if (atual) {
      await Q.run(`UPDATE usuarios SET nome = ?, senha_hash = ?, ativo = TRUE,
                          senha_provisoria = FALSE WHERE id = ?`, nome, hash, atual.id);
      console.log(`\n  SENHA DA CONTA DE DONO TROCADA: ${usuario}`);
    } else {
      const jaExisteComum = await Q.get("SELECT id FROM usuarios WHERE usuario = ?", usuario);
      if (jaExisteComum) {
        await Q.run(`UPDATE usuarios SET nome = ?, papel = 'dono', senha_hash = ?, ativo = TRUE,
                            senha_provisoria = FALSE WHERE id = ?`, nome, hash, jaExisteComum.id);
        console.log(`\n  CONTA PROMOVIDA A DONO: ${usuario}`);
        console.log("  (ela some da lista de usuários do painel a partir de agora)");
      } else {
        await Q.run(`INSERT INTO usuarios (usuario, nome, senha_hash, papel, senha_provisoria)
                     VALUES (?, ?, ?, 'dono', FALSE)`, usuario, nome, hash);
        console.log(`\n  CONTA DE DONO CRIADA: ${usuario}`);
      }
    }

    console.log(`  nome:  ${nome}`);
    console.log(`  senha: ${senha}`);
    console.log("\n  ANOTE AGORA — ela não é mostrada de novo e o painel não a redefine.");
    console.log("  Guarde num gerenciador de senhas. Se esta senha se perder, a saída");
    console.log("  é rodar este mesmo comando de novo, no servidor.");
    console.log("\n  Esta conta não aparece na lista de usuários e nenhuma tela a altera.");
    console.log("  Ela enxerga e pode tudo que o administrador pode.\n");
    return;
  }

  /* A regra de senha é a MESMA do painel porque vem da mesma função. Duas
     cópias divergiriam, e a diferença só apareceria quando alguém não
     conseguisse ditar a senha por telefone. */
  const senha = senhaProvisoria();
  const hash = gerarHash(senha);

  const existe = await Q.get("SELECT id, papel FROM usuarios WHERE usuario = ?", usuario);

  /* Rebaixar o dono sem querer, com o comando do dia a dia, é o engano que
     este bloco existe para impedir: o login é o mesmo, ninguém lembra que
     aquela conta é a de manutenção, e ela perderia o papel em silêncio. */
  if (existe && existe.papel === "dono") {
    console.error(`\n  ✖ "${usuario}" é a conta de dono.`);
    console.error("    Para trocar a senha dela:");
    console.error(`      node criar-usuario.cjs --dono ${usuario}`);
    process.exit(1);
  }

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
