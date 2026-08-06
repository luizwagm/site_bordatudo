#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — só olha, não altera nada.
#  Rode ANTES do deploy para saber em que estado a produção está.
# ==========================================================================
APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-bordatudo.service}"
PORTA="${PORTA:-5193}"
cd "$APP_DIR" || exit 1

echo "===================== ESTADO DA PRODUÇÃO ====================="
echo
echo "Commit atual : $(git rev-parse --short HEAD 2>/dev/null) — $(git log -1 --format=%s 2>/dev/null)"
echo "Node         : $(node -v)"
echo "Driver SQLite: $(node -p 'require("./db").DRIVER_NOME + (require("./db").DRIVER_AVISO ? "  ⚠ " + require("./db").DRIVER_AVISO : "")' 2>/dev/null || echo '—')"
echo "Serviço      : $(systemctl is-active "$SERVICO" 2>/dev/null)"
printf "Site         : HTTP %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/")"
printf "Painel       : HTTP %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/admin/")"
echo

# O painel é uma página só, com todo o JavaScript embutido. Um erro de sintaxe
# ali não aparece em lugar nenhum: o servidor entrega o arquivo, o navegador
# desiste de interpretar e a tela fica em BRANCO, sem nada no log do serviço.
echo "--- O JavaScript do painel compila? ---"
node -e '
  const fs = require("fs");
  const s = fs.readFileSync("admin/index.html", "utf8");
  const blocos = [...s.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocos.length) { console.log("  não achei bloco <script> em admin/index.html"); process.exit(0); }
  let erro = null;
  blocos.forEach((b, i) => { if (erro) return; try { new (require("vm").Script)(b, { filename: "admin/index.html" }); } catch (e) { erro = `bloco ${i}: ${e.message}`; } });
  console.log(erro ? "  ERRO DE SINTAXE — o painel NÃO vai abrir:\n  " + erro : "  OK: sem erro de sintaxe (" + blocos.length + " bloco(s))");
' 2>/dev/null || echo "  não consegui verificar"
echo

echo "--- O banco corre risco no próximo pull? ---"
if git ls-files --error-unmatch data/site.db >/dev/null 2>&1; then
  echo "  ATENÇÃO: data/site.db ainda é RASTREADO neste commit."
  echo "  Um git pull simples pode apagá-lo. Use ./deploy.sh, que o protege."
  echo "  Para tirar do git sem apagar o arquivo:  git rm --cached -r data"
else
  echo "  OK: data/site.db não é rastreado — o git não mexe nele."
fi
echo

echo "--- Permissão de escrita no banco ---"
DONO_SVC=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO_SVC" ] && DONO_SVC="root"
echo "  serviço roda como : $DONO_SVC"
echo "  dono de data/     : $(stat -c '%U:%G %a' data 2>/dev/null || echo '—')"
echo "  dono do site.db   : $(stat -c '%U:%G %a' data/site.db 2>/dev/null || echo '—')"
# O SQLite grava um -wal AO LADO do banco: sem escrita NA PASTA dá "attempt to
# write a readonly database" mesmo com o .db gravável. Por isso testa os dois.
if sudo -u "$DONO_SVC" test -w data 2>/dev/null && sudo -u "$DONO_SVC" test -w data/site.db 2>/dev/null; then
  echo "  resultado         : OK, o serviço consegue gravar"
else
  echo "  resultado         : SEM PERMISSÃO — o painel não vai salvar nada"
  echo "                      corrija com: sudo chown -R $DONO_SVC: data assets/img/uploads backups"
fi
echo

echo "--- Conteúdo do banco ---"
if [ -f data/site.db ]; then
  echo "  arquivo: $(du -h data/site.db | cut -f1)"
  node -e '
    const { abrirBanco } = require("./db");
    try {
      const db = abrirBanco("data/site.db");
      /* As tabelas vêm do PRÓPRIO BANCO, não de uma lista escrita aqui.
         Com lista fixa, tabela que não existe imprime "—" igualzinho a tabela
         vazia — e o dia em que alguém renomear uma, a conferência continua
         verde apontando para o nada. Foi o que veio junto ao copiar este
         arquivo de outro projeto: metade dos nomes era de lá. */
      /* O filtro é em JavaScript de propósito. Este bloco inteiro está dentro
         de `node -e '...'`, entre aspas SIMPLES do shell — e SQLite exige
         aspas simples em literal de texto. Um `type='table'` aqui fecharia a
         string do shell no meio e o erro sairia como "near table: syntax
         error", que não aponta para o shell em momento nenhum. */
      const tabelas = db.prepare("SELECT name, type FROM sqlite_master ORDER BY name")
        .all()
        .filter((r) => r.type === "table" && r.name.indexOf("sqlite_") !== 0)
        .map((r) => r.name);
      for (const t of tabelas) {
        console.log("  " + t.padEnd(14) + db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c);
      }
      console.log("  integridade   " + db.prepare("PRAGMA integrity_check").get().integrity_check);
      const e = db.prepare("SELECT value FROM settings WHERE key=?").get("site_estado");
      const estado = (e && e.value) || "no-ar";
      const aviso = { construcao: "EM CONSTRUÇÃO — o visitante vê a página de aviso",
                      manutencao: "EM MANUTENÇÃO — o site está fora do ar!" };
      console.log("  situação do site " + (aviso[estado] || "no ar"));
    } catch (e) { console.log("  ERRO ao ler: " + e.message); }
  ' 2>/dev/null
else
  echo "  data/site.db NÃO EXISTE"
fi
echo

echo "--- Banco do /restrito (PostgreSQL) ---"
# No servidor as credenciais vêm de /etc/bordatudo.env; na máquina de quem
# desenvolve, do .env do projeto. Conferir os dois deixa este script útil nos
# dois lugares — e é justamente aqui que se quer saber se falta o arquivo.
if [ ! -f /etc/bordatudo.env ] && [ ! -f .env ]; then
  echo "  sem /etc/bordatudo.env nem .env — o /restrito não tem como falar com o banco"
else
  node -e '
    const { Q, carregarAmbiente } = require("./pg.js");
    carregarAmbiente(__dirname);
    (async () => {
      /* Conta as tabelas que importam. "Conectou" não basta: um banco vazio
         conecta igualzinho, e a diferença só aparece quando o operador tenta
         abrir a ficha. */
      const t = ["usuarios","clientes","desenhos","fichas","lotes","maquinas"];
      for (const n of t) {
        const r = await Q.get(`SELECT COUNT(*) c FROM ${n}`);
        console.log("  " + n.padEnd(14) + r.c);
      }
      const admins = await Q.get("SELECT COUNT(*) c FROM usuarios WHERE papel = ? AND ativo", "admin");
      if (Number(admins.c) === 0) console.log("  ATENÇÃO: nenhum administrador ativo — ninguém entra no /restrito");
      const abertas = await Q.get("SELECT COUNT(*) c FROM fichas WHERE situacao = ?", "aberta");
      if (Number(abertas.c)) console.log("  " + abertas.c + " ficha(s) aberta(s) agora (operador na máquina)");
    })().catch((e) => {
      console.log("  ERRO ao falar com o Postgres: " + String(e.message).split("\n")[0]);
      console.log("  Confira:  systemctl status postgresql@*-main   (a unit `postgresql` mente: ela é fachada)");
      process.exitCode = 1;
    }).finally(() => Q.fechar());
  ' 2>/dev/null || echo "  não consegui consultar (veja a mensagem acima)"
fi
echo

echo "--- Freio de tentativas de senha ---"
if [ -f data/limites.json ]; then
  node -e '
    const d = require("./data/limites.json");
    const f = Object.entries(d.falhas || {});
    console.log("  baldes ativos    " + f.length);
    const contas = f.filter(([k]) => k.includes("|conta|"));
    if (contas.length) for (const [k, v] of contas) console.log("    " + k + "  " + v.n + " erro(s)");
    console.log("  IPs conhecidos   " + Object.keys(d.ipsBons || {}).length + " (entram mesmo durante ataque)");
  ' 2>/dev/null || echo "  arquivo ilegível"
else
  echo "  ainda sem registro (ninguém errou a senha)"
fi
echo

echo "--- Backup automático ---"
node server.js --backup-status 2>/dev/null | sed 's/^/  /' || echo "  não consegui consultar"
echo
echo "--- Últimos backups no disco ---"
# o || não pega o caso vazio porque quem define o código de saída é o sed
LISTA=$(ls -1t backups/*.db 2>/dev/null | head -8)
if [ -n "$LISTA" ]; then echo "$LISTA" | sed 's/^/  /'; else echo "  nenhum ainda (o primeiro sai em até 24h ou no próximo deploy)"; fi
echo "  restaurar:  sudo ./restaurar.sh        (lista o que existe)"
echo "              sudo ./restaurar.sh site   (restaura o mais recente)"
echo
echo "=============================================================="
