#!/usr/bin/env bash
# ==========================================================================
#  restaurar.sh — devolve um backup ao lugar
#
#  Uso:  sudo ./restaurar.sh                 lista os backups disponíveis
#        sudo ./restaurar.sh site            restaura o mais recente
#        sudo ./restaurar.sh site ARQUIVO    restaura um backup específico
#
#  O que ele faz ANTES de sobrescrever qualquer coisa:
#   1. confere a integridade do backup escolhido — não restaura cópia quebrada;
#   2. guarda o banco ATUAL como .antes-da-restauracao, para que restaurar por
#      engano não seja irreversível;
#   3. para o serviço, troca o arquivo, ajusta o dono e sobe de volta.
#
#  Restaurar devolve o site ao estado daquela data: TUDO que foi escrito no
#  painel depois da cópia se perde. Por isso o script mostra a data e exige
#  que se digite RESTAURAR por extenso.
# ==========================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-bordatudo.service}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

listar() {
  azul "  Backups disponíveis (mais novo primeiro):"
  local achou=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    achou=1
    printf "    %-46s %6s  %s\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$(date -r "$f" '+%d/%m/%Y %H:%M')"
  done < <(ls -1t "$BACKUP_DIR"/site.*.db 2>/dev/null)
  [ "$achou" = "0" ] && amarelo "    nenhum ainda (o primeiro sai em até 24h ou no próximo deploy)"
  echo
  echo "  Para restaurar o mais recente:  sudo ./restaurar.sh site"
  echo "  Para escolher um:               sudo ./restaurar.sh site backups/NOME.db"
}

BANCO="${1:-}"
if [ -z "$BANCO" ]; then listar; exit 0; fi
if [ "$BANCO" != "site" ]; then
  vermelho "Banco desconhecido: $BANCO   (o único é 'site')"; echo; listar; exit 1
fi

ARQ="${2:-$(ls -1t "$BACKUP_DIR"/site.*.db 2>/dev/null | head -1)}"
if [ -z "$ARQ" ] || [ ! -f "$ARQ" ]; then
  vermelho "Não encontrei backup para restaurar."; echo; listar; exit 1
fi

# ------------------------------------------- 1. o backup presta?
azul "1/4  Conferindo o backup"
VEREDITO=$(node -e '
  const { abrirBanco } = require("./db");
  try {
    const d = abrirBanco(process.argv[1]);
    const r = d.prepare("PRAGMA integrity_check").get();
    const v = r ? (r.integrity_check || Object.values(r)[0]) : "sem resposta";
    const n = (t) => { try { return d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return 0; } };
    const resumo = `${n("services")} modalidades · ${n("team")} equipe · ${n("posts")} matérias`;
    d.close();
    console.log(v + "|" + resumo);
  } catch (e) { console.log("ILEGÍVEL: " + e.message + "|"); }
' "$ARQ" 2>/dev/null)
INTEG="${VEREDITO%%|*}"; RESUMO="${VEREDITO##*|}"
if [ "$INTEG" != "ok" ]; then
  vermelho "     Este backup NÃO está íntegro ($INTEG). Nada foi alterado."
  amarelo  "     Tente outro:  sudo ./restaurar.sh"
  exit 1
fi
verde "     íntegro · $RESUMO · $(du -h "$ARQ" | cut -f1) · de $(date -r "$ARQ" '+%d/%m/%Y %H:%M')"

# ------------------------------------------- 2. confirmação
echo
amarelo "  Vai substituir  data/site.db"
amarelo "  pelo backup de  $(date -r "$ARQ" '+%d/%m/%Y às %H:%M')"
vermelho "  Tudo que foi escrito no painel DEPOIS dessa data será perdido."
echo
printf "  Digite RESTAURAR para confirmar: "
read -r RESP
[ "$RESP" = "RESTAURAR" ] || { amarelo "Cancelado. Nada foi alterado."; exit 0; }

# ------------------------------------------- 3. troca
azul "2/4  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1

azul "3/4  Guardando o banco atual e trocando"
if [ -f data/site.db ]; then
  SEGURANCA="$BACKUP_DIR/site.antes-da-restauracao.$(date +%Y-%m-%d_%H%M%S).db"
  # cp e não mv: se a cópia falhar, o banco original continua no lugar
  if cp data/site.db "$SEGURANCA"; then
    verde "     estado de agora guardado em $(basename "$SEGURANCA")"
  else
    vermelho "     NÃO consegui guardar o estado atual. Restauração cancelada."
    amarelo  "     (sem essa cópia, um engano aqui seria irreversível)"
    systemctl start "$SERVICO" 2>/dev/null
    exit 1
  fi
fi
# O -wal guarda escritas que ainda não entraram no .db. Deixá-lo para trás
# faria o SQLite aplicar sobre o banco restaurado escritas do banco ANTIGO.
rm -f data/site.db-wal data/site.db-shm
cp "$ARQ" data/site.db
verde "     backup no lugar"

azul "4/4  Ajustando dono e subindo"
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO" ] && DONO="root"
GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null); [ -z "$GRUPO" ] && GRUPO="$DONO"
chown -R "$DONO:$GRUPO" data 2>/dev/null
chmod 755 data 2>/dev/null; chmod 644 data/site.db 2>/dev/null
systemctl start "$SERVICO" 2>/dev/null
sleep 3

PORTA="${PORTA:-5193}"
CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/" || echo 000)
echo
if [ "$CODIGO" = "200" ]; then
  verde "Restaurado — site no ar."
  echo "  Conteúdo agora: $RESUMO"
  echo "  Se algo parecer errado, o estado anterior está em:"
  echo "    ${SEGURANCA:-(não havia banco antes)}"
  echo "  Entre no painel e clique em Publicar para as páginas refletirem o banco."
else
  vermelho "O site não respondeu (HTTP $CODIGO). Log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  exit 1
fi
