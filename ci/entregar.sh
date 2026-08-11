#!/usr/bin/env bash
# ==========================================================================
#  entregar.sh — o ÚNICO comando que a chave do GitHub consegue executar
#
#  Instalar no servidor:
#      mkdir -p ~/bin && cp ci/entregar.sh ~/bin/entregar-bordatudo
#      chmod 755 ~/bin/entregar-bordatudo
#
#  E no ~/.ssh/authorized_keys, a chave da entrega entra assim:
#      restrict,command="/home/deploy/bin/entregar-bordatudo" ssh-ed25519 AAAA... entrega-bordatudo
#
#  POR QUE O `command=` É A PEÇA MAIS IMPORTANTE DESTE ARQUIVO
#
#  Uma chave SSH comum dá SHELL. Guardada como segredo no GitHub, ela vira uma
#  porta para o servidor inteiro na mão de quem tiver acesso ao repositório —
#  incluindo qualquer Action de terceiro que alguém adicione ao workflow.
#
#  Com `command=`, o servidor IGNORA o que o cliente pedir e roda só isto. A
#  chave deixa de ser "entrar no servidor" e passa a ser "pedir uma entrega
#  deste site". O `restrict` desliga túnel, encaminhamento de agente e terminal.
#
#  Testado assim (deve mostrar o deploy, nunca um shell):
#      ssh -i chave deploy@servidor "cat /etc/shadow"
# ==========================================================================
set -uo pipefail

PROJETO="/var/www/projetos/Borda-Tudo"
TRAVA="/tmp/entregar-bordatudo.lock"

cd "$PROJETO" || { echo "entregar: $PROJETO não existe"; exit 1; }

# ---------------------------------------------------------------- registro
# Toda entrega fica no journal, com quem pediu. Sem isto, uma entrega
# inesperada não tem de onde ser explicada depois.
logger -t entrega-bordatudo "pedido de entrega de ${SSH_CLIENT%% *}"

# ------------------------------------------------------------------ trava
# DOIS PUSHES SEGUIDOS disparam duas entregas ao mesmo tempo, e as duas mexem
# no mesmo banco: uma para o serviço enquanto a outra restaura o arquivo. O
# `flock` faz a segunda esperar a primeira terminar, em vez de correrem juntas.
exec 9>"$TRAVA"
if ! flock -w 600 9; then
  echo "entregar: outra entrega está rodando há mais de 10 minutos — desisti"
  exit 1
fi

echo "=== entrega iniciada em $(date '+%d/%m/%Y %H:%M:%S') ==="

# ==========================================================================
#  O DEPLOY.SH É ATUALIZADO ANTES DE RODAR — e isto conserta um impasse real.
#
#  O `deploy.sh` faz o `git pull`. Logo, uma correção DENTRO dele só chega ao
#  servidor se ele rodar até o pull. Se a correção for justamente num passo
#  ANTERIOR ao pull — uma conferência de permissão que recusa cedo demais, por
#  exemplo —, o script morre antes e a correção nunca desce. O arquivo que
#  precisa ser atualizado é o mesmo que teria de rodar para se atualizar.
#
#  Aconteceu aqui em 10/08/2026: o teste de permissão usava um comando fora da
#  lista do sudo, o deploy parava na primeira linha útil, e dois pushes
#  seguidos com a correção não mudaram nada.
#
#  A saída é buscar SÓ ESTE ARQUIVO antes de executá-lo. É uma linha, e ela
#  garante que a entrega sempre roda a versão mais nova das próprias
#  instruções. `git fetch` não mexe na árvore; o `checkout` toca um arquivo só.
# ==========================================================================
if git fetch --quiet origin main 2>/dev/null; then
  if ! git diff --quiet HEAD origin/main -- deploy.sh 2>/dev/null; then
    git checkout origin/main -- deploy.sh && echo "deploy.sh atualizado antes de rodar"
  fi
fi

# Chamado por "bash ./deploy.sh", e não direto: o passo acima traz o arquivo do
# remoto com o MODO gravado no git, e um deploy.sh commitado como 100644 chega
# aqui sem o bit de execucao — mesmo tendo sido executavel no disco antes.
# Aconteceu no Kenosis: a auto-atualizacao rebaixou a permissao e a entrega
# morreu com "Permission denied" (codigo 126) no arquivo que ela mesma acabara
# de buscar. Chamando pelo interpretador, o modo deixa de importar.
bash ./deploy.sh
CODIGO=$?
echo "=== entrega terminou com código $CODIGO ==="

logger -t entrega-bordatudo "entrega terminou com código $CODIGO"
exit $CODIGO
