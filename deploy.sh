#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — atualiza a Borda Tudo em produção sem arriscar o conteúdo
#
#  Uso:  sudo ./deploy.sh
#
#  O banco data/site.db é TODO o conteúdo do site: textos das seções,
#  serviços, peças da vitrine, depoimentos, dúvidas, a contagem
#  de visitas e a senha do painel. Ele vive SÓ no servidor — não está no repositório (ver
#  .gitignore). Por isso o deploy tira o banco do caminho ANTES do git pull e
#  devolve depois: nem um pull mal resolvido nem um commit antigo que apague o
#  arquivo conseguem encostar nele.
#
#  Sequência: backup → inventário → parar → proteger → pull → dependências →
#             devolver → subir → conferir inventário → testar.
#             Se algo falhar, restaura sozinho.
#
#  Este é o backup do DEPLOY (uma foto tirada antes de mexer). O sistema também
#  tira um backup DIÁRIO por conta própria, na mesma pasta — ver backup.js.
# ==========================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-bordatudo.service}"
PORTA="${PORTA:-5193}"
# Os endereços que respondem por este projeto, para a conferência do fim.
# Aqui eles TÊM valor padrão — diferente do criar_site.sh, onde o domínio é
# argumento: este script roda sozinho no cron e no dia a dia, e parar por falta
# de parâmetro seria pior do que conferir o endereço errado e avisar.
# Para trocar sem editar:  DOMINIO_PRINCIPAL=outro.com sudo ./deploy.sh
DOMINIO_PRINCIPAL="${DOMINIO_PRINCIPAL:-bordatudo.com}"
DOMINIO_TRABALHO="${DOMINIO_TRABALHO:-bordatudo.projetos.luizaugust.me}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
MANTER_BACKUPS=20
COFRE="/tmp/bordatudo-deploy-$$"

cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

# Conta o que existe no banco. Serve para PROVAR, no fim, que nada sumiu —
# um deploy que "deu certo" mas comeu as matérias não deu certo.
#
# Devolve "ILEGIVEL" (sem detalhe) quando não conseguiu ler. Antes devolvia a
# mensagem de erro inteira, e ela era COMPARADA com o inventário real no fim —
# então "não consegui ler" contra "8 serviços · 3 depoimentos…" parecia conteúdo
# alterado e disparava a restauração à toa. Foi o que aconteceu quando o
# node_modules veio do git com o binário de outra plataforma: o leitor estava
# quebrado ANTES e funcionando DEPOIS, e nada no banco havia mudado.
inventario() {
  [ -f data/site.db ] || { echo "SEM BANCO"; return; }
  node -e '
    const { abrirBanco } = require("./db");
    try {
      const db = abrirBanco("data/site.db");
      const n = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return 0; } };
      console.log(`${n("services")} serviços · ${n("produtos")} produtos · ${n("depoimentos")} depoimentos · ${n("posts")} matérias · ${n("settings")} textos · ${n("acessos")} acessos`);
    } catch (e) { console.log("ILEGIVEL"); }
  ' 2>/dev/null
}

# Verdadeiro quando o inventário não é uma CONTAGEM, e sim um estado de "não
# consegui olhar". Comparar um desses com uma contagem real não diz nada sobre
# o conteúdo ter mudado — só que a leitura falhou num dos dois momentos.
sem_leitura() { case "$1" in "ILEGIVEL"|"SEM BANCO"|"") return 0;; *) return 1;; esac; }

# O binário do better-sqlite3 é COMPILADO para a plataforma. Se ele vier do
# repositório (compilado no Windows), o Linux recusa com "invalid ELF header" e
# o banco fica ilegível — mesmo intacto. Detectar isso cedo e por nome evita
# perseguir um problema de dados que não existe.
diagnosticar_banco() {
  local motivo
  motivo=$(node -e 'try{require("./db").abrirBanco("data/site.db").close()}catch(e){console.log(e.message.split("\n")[0])}' 2>&1 | head -1)
  [ -z "$motivo" ] && return 0
  vermelho "     não consigo LER o banco: $motivo"
  case "$motivo" in
    *"invalid ELF header"*|*ERR_DLOPEN*)
      amarelo "     Isto é o driver compilado para OUTRA plataforma — quase sempre um"
      amarelo "     node_modules que veio do git. O conteúdo do banco está intacto."
      amarelo "     Conserte com:  rm -rf node_modules && npm ci --omit=dev"
      ;;
  esac
  return 1
}

restaurar_e_sair() {
  vermelho "$1"

  # SEMPRE guarda o banco que está no disco AGORA, antes de escrever por cima.
  # Sem isto, uma restauração equivocada é irreversível — e foi assim que um
  # deploy chegou a devolver um backup ANTIGO por cima de dados novos.
  if [ -f data/site.db ]; then
    SOCORRO="$BACKUP_DIR/site.antes-de-restaurar.$(date +%Y-%m-%d_%H%M%S).db"
    mkdir -p "$BACKUP_DIR" && cp data/site.db "$SOCORRO" 2>/dev/null \
      && amarelo "O banco que estava no disco foi guardado em: $SOCORRO"
  fi

  if [ -f "$COFRE/site.db" ]; then
    # O cofre é o banco de produção tirado do caminho neste mesmo deploy:
    # é sempre a cópia mais fiel, e por isso vem primeiro.
    mkdir -p data && cp "$COFRE/site.db" data/site.db
    amarelo "Banco devolvido do cofre temporário (a cópia deste deploy)."
  elif [ -f "${BACKUP:-}" ]; then
    # O cofre já foi esvaziado (passo 6). Aqui só resta o backup — e ele pode
    # ser mais VELHO do que o banco atual. Restaurar às cegas apagaria tudo
    # que entrou depois, então só faz isso se o backup for mais novo.
    if [ -f data/site.db ] && [ data/site.db -nt "$BACKUP" ]; then
      vermelho "NÃO restaurei: o banco no disco é MAIS NOVO que o backup."
      amarelo  "  banco : $(date -r data/site.db '+%d/%m/%Y %H:%M')"
      amarelo  "  backup: $(date -r "$BACKUP" '+%d/%m/%Y %H:%M')"
      amarelo  "  Voltar o backup apagaria o que foi cadastrado depois dele."
      amarelo  "  Se ainda assim quiser: sudo ./restaurar.sh site \"$BACKUP\""
    else
      mkdir -p data && cp "$BACKUP" data/site.db
      amarelo "Banco restaurado do backup: $BACKUP"
    fi
  fi

  systemctl start "$SERVICO" 2>/dev/null
  rm -rf "$COFRE"
  exit 1
}

# ------------------------------------------------- 0. o banco corre risco?
# ISTO É UMA TRAVA, e existe por um estrago real: o data/site.db estava sendo
# versionado. Com o banco no repositório, cada `git pull` escreve por cima do
# banco de PRODUÇÃO a cópia que veio da máquina de quem desenvolve — e o site
# volta ao conteúdo de exemplo, mesmo já tendo sido alimentado.
#
# Não dá para "contornar com cuidado": enquanto o arquivo for rastreado, o
# risco volta a cada atualização. Por isso o deploy PARA aqui e diz como
# resolver, em vez de seguir e torcer.
if git ls-files --error-unmatch data/site.db >/dev/null 2>&1; then
  vermelho "PAREI: o banco data/site.db está VERSIONADO no git."
  echo
  amarelo "  Enquanto ele estiver assim, todo git pull sobrescreve o banco de"
  amarelo "  produção com a cópia do repositório — o site volta ao conteúdo de"
  amarelo "  exemplo e o que foi cadastrado se perde."
  echo
  amarelo "  Resolva na SUA MÁQUINA (não aqui), e envie:"
  echo    "    git rm -r --cached data"
  echo    "    git commit -m \"chore: tira o banco do versionamento\""
  echo    "    git push"
  echo
  amarelo "  Depois rode este deploy de novo. Os arquivos continuam no disco —"
  amarelo "  o --cached só para de rastreá-los."
  exit 1
fi

# ----------------------------------------------------------- 1. backup
azul "1/7  Backup do banco"
mkdir -p "$BACKUP_DIR"
if [ -f data/site.db ]; then
  if node server.js --backup 2>&1 | sed 's/^/  /'; then
    :
  else
    amarelo "     backup pelo sistema falhou — caindo para cópia simples"
    cp data/site.db "$BACKUP_DIR/site.$(date +%Y-%m-%d_%H%M%S).db"
  fi
  # o mais recente serve de âncora para o restaurar_e_sair
  BACKUP=$(ls -1t "$BACKUP_DIR"/site.*.db 2>/dev/null | head -1)
  ls -1t "$BACKUP_DIR"/site.*.db 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
else
  amarelo "     ainda não existe banco (primeira instalação)"
fi

# ------------------------------------------------- 1b. backup do Postgres
# O banco do /restrito guarda o que virou NOTA. O `site.db` some e alguém
# reescreve o texto; este some e não há como reescrever. Vem ANTES do pull
# porque o pull pode trazer uma migração — e migração sem dump é aposta.
azul "1b/7 Backup do Postgres (/restrito)"
if [ -f /etc/bordatudo.env ] && command -v pg_dump >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  set -a; . /etc/bordatudo.env; set +a
  PGDB="${PGDATABASE:-bordatudo_producao}"
  DUMP="$BACKUP_DIR/$PGDB.$(date +%Y-%m-%d_%H%M%S).sql"
  if PGPASSWORD="$PGPASSWORD" pg_dump -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" \
       -U "${PGUSER:-bordatudo}" -d "$PGDB" --no-owner --no-privileges -f "$DUMP" 2>/tmp/pgdump.$$; then
    # pg_dump devolve 0 com arquivo vazio quando não lê as tabelas. Guardar um
    # dump que não restaura é pior que não ter dump: dá segurança falsa.
    if [ "$(stat -c%s "$DUMP" 2>/dev/null || echo 0)" -gt 200 ]; then
      verde "     $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
      ls -1t "$BACKUP_DIR/$PGDB".*.sql 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
    else
      rm -f "$DUMP"
      vermelho "     o dump saiu VAZIO — confira o acesso ao banco antes de seguir"
      exit 1
    fi
  else
    rm -f "$DUMP"
    vermelho "     pg_dump FALHOU: $(head -1 /tmp/pgdump.$$)"
    vermelho "     o /restrito é dado de faturamento — não vou atualizar sem cópia."
    vermelho "     Para subir mesmo assim (por sua conta):  SEM_BACKUP_PG=1 sudo ./deploy.sh"
    [ "${SEM_BACKUP_PG:-0}" = "1" ] || exit 1
  fi
  rm -f /tmp/pgdump.$$
elif [ ! -f /etc/bordatudo.env ]; then
  amarelo "     /etc/bordatudo.env não existe — o /restrito ainda não foi instalado"
else
  amarelo "     pg_dump não encontrado — instale com: apt install -y postgresql-client"
  [ "${SEM_BACKUP_PG:-0}" = "1" ] || exit 1
fi

# -------------------------------------------------------- 2. inventário
azul "2/7  Conteúdo atual"
ANTES=$(inventario)
echo "     $ANTES"
# Se não deu para ler, diga POR QUÊ agora — e não trinta linhas depois, quando
# o sintoma já virou "o conteúdo mudou".
sem_leitura "$ANTES" && diagnosticar_banco || true

# ------------------------------------------------------------ 3. parar
azul "3/7  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1
verde "     parado (o SQLite solta o arquivo antes de mexermos nele)"

# --------------------------------------------------------- 4. proteger
azul "4/7  Tirando banco e fotos do caminho do git"
mkdir -p "$COFRE"
[ -f data/site.db ] && mv data/site.db "$COFRE/site.db"
# O -wal guarda escritas ainda não gravadas no .db. Levar um sem o outro
# entrega um banco desatualizado — por isso os três andam juntos.
for extra in data/site.db-wal data/site.db-shm data/limites.json; do
  [ -f "$extra" ] && mv "$extra" "$COFRE/$(basename "$extra")"
done
[ -d assets/img/uploads ] && cp -r assets/img/uploads "$COFRE/uploads"
[ -d assets/video ] && cp -r assets/video "$COFRE/video"
verde "     guardados em $COFRE"

# ------------------------------------------------------------- 5. pull
azul "5/7  Baixando a versão nova"
DE=$(git rev-parse --short HEAD)
if ! git pull --ff-only; then
  restaurar_e_sair "     git pull falhou — nada foi alterado."
fi
PARA=$(git rev-parse --short HEAD)
if [ "$DE" = "$PARA" ]; then
  amarelo "     já estava atualizado ($PARA)"
else
  verde "     $DE → $PARA"
  git log --oneline "$DE..$PARA" | sed 's/^/       /'
fi

# ---------------------------------------------------- 5b. dependências
# O projeto usa o better-sqlite3. Não é fatal: sem node_modules o db.js volta
# sozinho para o driver de fábrica do Node e o site continua no ar, com aviso.
azul "5b/7 Dependências"
if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    if npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund; then
      verde "     node_modules em dia"
    else
      amarelo "     npm install falhou — o site sobe com o driver de reserva"
      amarelo "     tente à mão depois: npm ci --omit=dev"
    fi
  else
    amarelo "     npm não encontrado — instale com: apt install -y npm"
  fi
else
  amarelo "     sem package.json — nada a instalar"
fi

# ------------------------------------------------------- 5c. migrações
# Os arquivos em sql/ são IF NOT EXISTS / DROP-antes-de-criar: rodar de novo
# não faz nada. Rodar aqui, e não à mão, é o que impede o caso clássico —
# código novo no ar contra esquema velho no banco, funcionando em tudo menos
# na tela que usa a coluna que ainda não existe.
azul "5c/7 Esquema do /restrito"
if [ -f /etc/bordatudo.env ] && [ -d sql ]; then
  FALHOU_SQL=0
  for arquivo in sql/0[2-9]-*.sql sql/[1-9][0-9]-*.sql; do
    [ -f "$arquivo" ] || continue
    if node sql/rodar.cjs "$(basename "$arquivo")" >/tmp/sql.$$ 2>&1; then
      verde "     $(basename "$arquivo")"
    else
      FALHOU_SQL=1
      vermelho "     $(basename "$arquivo") FALHOU:"
      sed 's/^/       /' /tmp/sql.$$ | tail -5
    fi
  done
  rm -f /tmp/sql.$$
  if [ "$FALHOU_SQL" = "1" ]; then
    vermelho "     O esquema não está em dia. O site sobe, mas o /restrito pode falhar."
    vermelho "     O dump do passo 1b está em $BACKUP_DIR."
  fi
else
  amarelo "     pulado (o /restrito ainda não foi instalado)"
fi

# --------------------------------------------------------- 6. devolver
azul "6/7  Devolvendo banco e fotos"
mkdir -p data assets/img/uploads
[ -f "$COFRE/site.db" ] && mv "$COFRE/site.db" data/site.db
for extra in site.db-wal site.db-shm limites.json; do
  [ -f "$COFRE/$extra" ] && mv "$COFRE/$extra" "data/$extra"
done
# -n = não sobrescreve: fotos que vieram no repositório não apagam as que o
# cliente enviou pelo painel.
[ -d "$COFRE/uploads" ] && cp -rn "$COFRE/uploads/." assets/img/uploads/ 2>/dev/null
[ -d "$COFRE/video" ] && mkdir -p assets/video && cp -rn "$COFRE/video/." assets/video/ 2>/dev/null

# O dono precisa ser o usuário DO SERVIÇO, não um palpite: com o dono errado o
# SQLite responde "attempt to write a readonly database" e o painel não salva
# nada — sem erro visível na tela. systemd sem User= significa root.
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null)
[ -z "$DONO" ] && DONO="root"
GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null)
[ -z "$GRUPO" ] && GRUPO="$DONO"
chown -R "$DONO:$GRUPO" data assets/img/uploads assets/video backups 2>/dev/null
# a PASTA precisa ser gravável: o SQLite cria o -wal ao lado do banco
chmod 755 data assets/img/uploads assets/video backups 2>/dev/null
[ -f data/site.db ] && chmod 644 data/site.db
verde "     de volta no lugar (dono: $DONO:$GRUPO)"

systemctl start "$SERVICO"
sleep 3

# ----------------------------------------------------------- 7. testar
azul "7/7  Conferindo"
DEPOIS=$(inventario)
echo "     antes : $ANTES"
echo "     depois: $DEPOIS"
# Só compara CONTAGEM com CONTAGEM. Se um dos dois lados é "não consegui ler",
# a diferença é da LEITURA, não do conteúdo — restaurar aí seria desfazer um
# deploy correto por causa de um driver quebrado. Foi exatamente o que
# aconteceu quando o node_modules do Windows veio pelo git: o leitor falhou
# antes, o `npm ci` o consertou no meio, e o "antes ≠ depois" acusou uma perda
# de dados que nunca existiu.
if sem_leitura "$ANTES" || sem_leitura "$DEPOIS"; then
  amarelo "     não deu para comparar o conteúdo (o banco não pôde ser lido em um dos momentos)."
  amarelo "     NADA foi restaurado — o banco continua como está, e o backup do passo 1 segue guardado."
  diagnosticar_banco || true
elif [ "$ANTES" != "$DEPOIS" ]; then
  # a contagem de visitas muda sozinha entre as duas leituras; só alerta se o
  # CONTEÚDO mudou — por isso compara ignorando o último campo
  A_SEM_VISITAS="${ANTES%· *}"; D_SEM_VISITAS="${DEPOIS%· *}"
  if [ "$A_SEM_VISITAS" != "$D_SEM_VISITAS" ]; then
    restaurar_e_sair "     O CONTEÚDO MUDOU. Restaurando por segurança."
  fi
fi

OK=0
for _ in $(seq 1 10); do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/" || echo 000)
  [ "$CODIGO" = "200" ] && { OK=1; break; }
  sleep 2
done

rm -rf "$COFRE"

if [ "$OK" = "1" ]; then
  VERSAO=$(curl -s "http://127.0.0.1:$PORTA/admin/" | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)

  # ------------------------------------------------------------------------
  # OS DOIS ENDEREÇOS, MEDIDOS DE FORA.
  #
  # Responder em 127.0.0.1 só prova que o Node subiu. Quem serve o visitante é
  # o nginx, com TLS e cabeçalhos — e é lá que mora o tipo de erro que passa
  # despercebido: certificado vencido, bloco desabilitado, proxy apontando
  # para a porta errada. Medir de dentro e dizer "está no ar" já me enganou
  # antes; aqui os dois são conferidos pelo nome público.
  # ------------------------------------------------------------------------
  echo
  echo "  Conferindo pelos endereços públicos:"
  for DOM in "${DOMINIO_PRINCIPAL:-bordatudo.com}" "${DOMINIO_TRABALHO:-bordatudo.projetos.luizaugust.me}"; do
    COD=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "https://$DOM/" || echo 000)
    case "$COD" in
      200) verde   "    https://$DOM  →  $COD" ;;
      000) amarelo "    https://$DOM  →  sem resposta (DNS ainda não aponta para cá? TLS pendente?)" ;;
      *)   amarelo "    https://$DOM  →  $COD" ;;
    esac
  done

  echo
  verde "Deploy concluído — site no ar, gerenciador $VERSAO"
  echo "  Backup desta atualização: ${BACKUP:-nenhum (primeira instalação)}"
  echo "  Se mudou texto ou foto, entre no painel e clique em Publicar."
  echo
  echo "  Backup automático (diário, dentro do serviço):"
  node server.js --backup-status 2>/dev/null | sed 's/^/    /'
else
  echo
  vermelho "O site não respondeu (HTTP $CODIGO). Últimas linhas do log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  echo
  amarelo "O banco está intacto em data/site.db e no backup:"
  amarelo "  ${BACKUP:-(sem backup — primeira instalação)}"
  exit 1
fi
