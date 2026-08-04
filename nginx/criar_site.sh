#!/usr/bin/env bash
# ==========================================================================
#  criar_site.sh — publica a Borda Tudo num servidor
#
#  USO (como root):
#
#      ./criar_site.sh bordatudo.com bordatudo.projetos.luizaugust.me
#      ./criar_site.sh bordatudo.com                            # só o principal
#      ./criar_site.sh bordatudo.com bordatudo.projetos.luizaugust.me --sem-tls
#
#  Ou por nome, se preferir:
#      ./criar_site.sh --dominio bordatudo.com --trabalho bordatudo.projetos.luizaugust.me
#
#  OS ENDEREÇOS SÃO ARGUMENTO, não estão gravados aqui. Foi assim que este
#  script deixou de depender de um arquivo de nginx nomeado pelo domínio: os
#  dois blocos são GERADOS na hora, a partir do que você passar. Trocar o
#  domínio do cliente, testar num subdomínio novo ou reaproveitar este script
#  noutro projeto vira questão de mudar a linha de comando.
#
#  DOIS ENDEREÇOS, DE PROPÓSITO:
#    · o primeiro — o do cliente, o que sai no cartão. É o canônico.
#    · o segundo  — o de trabalho, seu. Opcional.
#
#  Os dois batem no MESMO serviço, mesma porta, mesmo banco: não há cópia nem
#  chance de divergirem. O de trabalho serve para acompanhar o site antes de o
#  domínio do cliente apontar para cá e, depois, para separar problema de
#  servidor de problema de DNS. Ele NÃO é indexado — dois endereços com o mesmo
#  conteúdo dividem a autoridade no Google e nenhum dos dois sobe.
#
#  A ORDEM IMPORTA, e é o que a primeira versão deste script errava: um bloco
#  `server` com `ssl_certificate` apontando para arquivo que ainda não existe
#  faz o `nginx -t` FALHAR — e nada sobe. Por isso:
#      1. nginx só em HTTP, com o caminho do desafio ACME aberto
#      2. certbot emite (certonly: não encosta na configuração)
#      3. só então entra a configuração definitiva, com HTTPS
# ==========================================================================
set -euo pipefail

# ---------------------------------------------------------------- ajustes
APP="bordatudo"                                   # nome do serviço systemd
PASTA="${PASTA:-Borda-Tudo}"                      # nome da pasta do projeto
BASE="${BASE:-/var/www/projetos}"                # onde os projetos moram
DESTINO="${DESTINO:-$BASE/$PASTA}"
USUARIO="${USUARIO:-deploy}"
GRUPO="${GRUPO:-deploy}"
PORTA="${PORTA:-5193}"
EMAIL_TLS="${EMAIL_TLS:-luizwagm@gmail.com}"
RAIZ_ACME="/var/www/certbot"

DOMINIO=""
TRABALHO=""
COM_TLS=1

# ------------------------------------------------------- linha de comando
while [ $# -gt 0 ]; do
  case "$1" in
    --sem-tls)  COM_TLS=0; shift ;;
    --dominio)  DOMINIO="${2:-}"; shift 2 ;;
    --trabalho) TRABALHO="${2:-}"; shift 2 ;;
    --destino)  DESTINO="${2:-}"; shift 2 ;;
    --porta)    PORTA="${2:-}"; shift 2 ;;
    --usuario)  USUARIO="${2:-}"; GRUPO="${2:-}"; shift 2 ;;
    -h|--ajuda|--help)
      sed -n '2,33p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
    -*)  echo "opção desconhecida: $1" >&2; exit 1 ;;
    *)   if [ -z "$DOMINIO" ]; then DOMINIO="$1"
         elif [ -z "$TRABALHO" ]; then TRABALHO="$1"
         else echo "argumento a mais: $1" >&2; exit 1; fi
         shift ;;
  esac
done

msg()   { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
erro()  { printf "\n\033[1;31m✖ %s\033[0m\n" "$*" >&2; exit 1; }
aviso() { printf "\033[1;33m%s\033[0m\n" "$*"; }
bom()   { printf "\033[1;32m%s\033[0m\n" "$*"; }

[ "$(id -u)" -eq 0 ] || erro "rode como root (sudo)"
[ -n "$DOMINIO" ] || erro "falta o domínio.  Uso: ./criar_site.sh bordatudo.com [bordatudo.projetos.luizaugust.me]"

# Um domínio errado só aparece lá na frente, quando o certbot falha e o nginx
# já foi recarregado. Conferir o formato aqui custa nada.
for d in "$DOMINIO" ${TRABALHO:+$TRABALHO}; do
  case "$d" in
    *.*) : ;;
    *) erro "\"$d\" não parece um domínio" ;;
  esac
done

temCertificado() { [ -f "/etc/letsencrypt/live/$1/fullchain.pem" ]; }

# Status HTTP de um endereço, ou "000" se nem conectou.
#
# O `|| true` é obrigatório: quando o curl não conecta ele imprime 000 E sai
# com erro. Com `curl ... || echo 000` os dois disparavam e a saída virava
# "000000", um número que não existe — e a conferência do fim, que compara com
# "404", acusava falha de segurança que não havia.
codigo() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-8}" "$1" 2>/dev/null || true; }

# Endereços IP que esta máquina realmente tem. Serve para separar duas causas
# que se parecem e se investigam de forma completamente diferente: "o DNS
# aponta para outro servidor" e "aponta para cá, e quem respondeu 404 foi o
# nginx daqui".
enderecosDaMaquina() { ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }

# `www.` SÓ FAZ SENTIDO EM DOMÍNIO RAIZ.
#
# Para `bordatudo.com`, o par com e sem www é o esperado. Para um subdomínio
# como `bordatudo.projetos.luizaugust.me`, pedir `www.bordatudo.projetos.luizaugust.me` é
# pedir um nome que ninguém cadastrou — e o certbot falha o LOTE INTEIRO por
# causa dele, levando junto o domínio que estava certo. Foi exatamente o que
# aconteceu na primeira subida.
#
# Raiz = dois rótulos (empresa.com) ou três terminando em sufixo composto
# (empresa.com.br). Acima disso é subdomínio.
ehDominioRaiz() {
  local d="$1"
  local rotulos; rotulos=$(printf '%s' "$d" | tr '.' '
' | grep -c .)
  case "$d" in
    *.com.br|*.net.br|*.org.br|*.gov.br|*.edu.br|*.co.uk|*.com.au)
      [ "$rotulos" -eq 3 ] ;;
    *) [ "$rotulos" -eq 2 ] ;;
  esac
}

# --------------------------------------------------------------------------
msg "1/8  Conferindo o que precisa existir"
for prog in nginx node; do
  command -v "$prog" >/dev/null || erro "$prog não está instalado"
done
node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)' \
  || erro "Node 20 ou mais novo é necessário (achei $(node -v))"
[ -d "$DESTINO" ] || erro "a pasta $DESTINO não existe — ponha o projeto lá primeiro"
[ -f "$DESTINO/server.js" ] || erro "$DESTINO não parece o projeto (falta server.js)"

echo "    projeto  : $DESTINO"
echo "    dono     : $USUARIO:$GRUPO"
echo "    porta    : $PORTA"
echo "    domínio  : $DOMINIO"
[ -n "$TRABALHO" ] && echo "    trabalho : $TRABALHO (não indexado)" || echo "    trabalho : (nenhum)"

getent group  "$GRUPO"   >/dev/null || { msg "criando o grupo $GRUPO";   addgroup --system "$GRUPO"; }
id "$USUARIO" >/dev/null 2>&1 || {
  msg "criando o usuário $USUARIO"
  adduser --system --ingroup "$GRUPO" --home "$DESTINO" --no-create-home "$USUARIO"
}

# --------------------------------------------------------------------------
msg "2/8  Dependências e permissões"
cd "$DESTINO"
# `npm ci` instala EXATAMENTE as versões travadas no package-lock.json — é o
# certo em produção. Sem o lock ele falha de cara; aí cai para o install, com
# aviso, em vez de parar a subida inteira por isso.
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  aviso "     sem package-lock.json — usando npm install (as versões podem variar)"
  npm install --omit=dev
fi
mkdir -p data backups assets/img/uploads "$RAIZ_ACME"
chown -R "$USUARIO:$GRUPO" "$DESTINO"
# O banco guarda a senha do painel: ninguém além do dono precisa lê-lo.
chmod 750 data backups
find data -name '*.db' -exec chmod 640 {} \; 2>/dev/null || true

# --------------------------------------------------------------------------
msg "3/8  Primeiro conteúdo (cria o banco e gera as páginas)"
sudo -u "$USUARIO" node server.js --publicar

# --------------------------------------------------------------------------
msg "4/8  Serviço do systemd"
# O .service do repositório é um MOLDE: o caminho e o dono reais entram aqui,
# a partir do que foi passado na linha de comando. Assim não há dois lugares
# dizendo onde o projeto mora — e nenhum deles ficando para trás.
sed -e "s#__DESTINO__#${DESTINO}#g" \
    -e "s#__USUARIO__#${USUARIO}#g" \
    -e "s#__GRUPO__#${GRUPO}#g" \
    -e "s#__PORTA__#${PORTA}#g" \
    "$DESTINO/${APP}.service" > "/etc/systemd/system/${APP}.service"
chmod 644 "/etc/systemd/system/${APP}.service"
systemctl daemon-reload
systemctl enable "$APP" >/dev/null
systemctl restart "$APP"
sleep 2
systemctl is-active --quiet "$APP" || {
  journalctl -u "$APP" -n 25 --no-pager
  erro "o serviço não subiu — veja o log acima"
}
echo "    serviço no ar em 127.0.0.1:$PORTA"

# --------------------------------------------------------------------------
# GERADOR DOS BLOCOS DO NGINX
#
#   $1 domínio   $2 principal|trabalho   $3 sim|nao (tem certificado)
#
# Um gerador só para os dois papéis: o que muda é o canônico (o principal
# manda o www para o domínio raiz) e o noindex (só o de trabalho tem).
# ---------------------------------------------------------------------------
escrever_conf() {
  local dom="$1" papel="$2" comHttps="$3"
  local arq="/etc/nginx/sites-available/${dom}.conf"

  {
    cat <<CAB
# ==========================================================================
#  ${dom} — ${papel} · ${APP}
#  GERADO por nginx/criar_site.sh — editar aqui é perder na próxima execução.
#  Projeto: ${DESTINO}   ·   app em 127.0.0.1:${PORTA}
CAB
    if [ "$papel" = "trabalho" ]; then
      cat <<'CAB'
#
#  NÃO É INDEXADO: dois endereços com o mesmo conteúdo dividem a autoridade no
#  Google. O X-Robots-Tag vale mais que o robots.txt porque acompanha TODA
#  resposta, inclusive as que o robô já tinha guardado.
CAB
    fi
    echo "# =========================================================================="

    # ------------------------------------------------------------ porta 80
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    if [ "$papel" = "principal" ] && ehDominioRaiz "$dom"; then
      echo "    server_name ${dom} www.${dom};"
    else
      echo "    server_name ${dom};"
    fi
    echo "    location /.well-known/acme-challenge/ { root ${RAIZ_ACME}; }"

    if [ "$comHttps" = "sim" ]; then
      echo '    location / { return 301 https://$host$request_uri; }'
      echo "}"
    else
      # Sem certificado ainda: serve pelo HTTP mesmo, senão o site ficaria fora
      # do ar entre a criação e a emissão.
      [ "$papel" = "trabalho" ] && echo '    add_header X-Robots-Tag "noindex, nofollow" always;'
      echo "    client_max_body_size 12m;"
      corpo_proxy
      echo "}"
    fi

    # AQUI HAVIA UM `return`, E ELE CRIAVA UM IMPASSE SEM SAÍDA.
    #
    # `{ … } > arquivo` é grupo, não subshell: um `return` lá dentro sai da
    # FUNÇÃO INTEIRA, pulando o `ln -sf` que liga o bloco em sites-enabled, lá
    # no fim. Sem certificado — ou seja, em toda primeira instalação — o
    # arquivo era escrito em sites-available e nunca ligado.
    #
    # E o efeito se mordia: sem link o nginx não carrega o bloco; sem o bloco
    # o desafio do ACME dá 404; sem o desafio não sai certificado; e o link só
    # nascia se já houvesse certificado. Nenhum site novo subiria jamais.
    #
    # `nginx -t` não pegava porque nada estava quebrado — só ausente.
    if [ "$comHttps" = "sim" ]; then

    # ------------------------------------------------- www → domínio raiz
    if [ "$papel" = "principal" ] && ehDominioRaiz "$dom"; then
      cat <<WWW

# Um endereço canônico só: com www e sem www indexados, o Google divide a
# autoridade entre os dois.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name www.${dom};
    ssl_certificate     /etc/letsencrypt/live/${dom}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${dom}/privkey.pem;
    return 301 https://${dom}\$request_uri;
}
WWW
    fi

    # ----------------------------------------------------------- porta 443
    cat <<SSL

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${dom};

    ssl_certificate     /etc/letsencrypt/live/${dom}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${dom}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # O HSTS quem emite é o app — ele sabe quando a conexão veio por HTTPS.
    # Repetir aqui mandaria o cabeçalho duas vezes.
SSL
    [ "$papel" = "trabalho" ] && echo '    add_header X-Robots-Tag "noindex, nofollow" always;'
    cat <<SSL2

    client_max_body_size 12m;
    access_log /var/log/nginx/${APP}-${papel}.access.log;
    error_log  /var/log/nginx/${APP}-${papel}.error.log;

    gzip on;
    gzip_vary on;
    gzip_min_length 512;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

    # Login passa pelo limitador da borda: mais barato barrar aqui do que
    # acordar o Node. A trava do próprio app continua valendo.
    location = /api/login {
        limit_req zone=${APP}_login burst=4 nodelay;
        proxy_pass http://127.0.0.1:${PORTA};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
SSL2
    echo ""
    corpo_proxy
    cat <<FIM
    location @caiu { root ${DESTINO}; try_files /manutencao.html =503; internal; }

    location ~ /\\.                                       { deny all; }
    location ~* \\.(db|db-wal|db-shm|sh|service|env|log)\$ { deny all; }
}
FIM
    fi
  } > "$arq"

  # A linha que o `return` pulava. Nada acima dela pode sair da função.
  ln -sf "$arq" "/etc/nginx/sites-enabled/${dom}.conf"
}

# O bloco de proxy é igual em toda parte — inclusive o X-Real-IP, que é o
# cabeçalho que o app LÊ para a trava de senha. Diferente do X-Forwarded-For,
# que o nginx apenas acrescenta (e por isso carrega texto do próprio
# visitante), este aqui ele SOBRESCREVE a cada requisição.
corpo_proxy() {
  cat <<PROXY
    location / {
        proxy_pass http://127.0.0.1:${PORTA};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
        proxy_intercept_errors on;
        error_page 502 503 504 = @caiu;
    }
PROXY
}

# --------------------------------------------------------------------------
msg "5/8  nginx"

# A zona do limitador vai para conf.d e existe SEMPRE, independente de qual
# bloco de site esteja ativo. Ver o comentário dentro do arquivo.
# O NOME DA ZONA E GLOBAL NO NGINX, e este servidor hospeda varios sites.
# Dois arquivos declarando `zone=cw_login` fazem o nginx recusar a
# configuracao INTEIRA — derruba o site novo E impede recarregar os que ja
# estavam no ar. Aconteceu ao clonar este projeto de outro: a substituicao
# trocou o nome do app mas nao o prefixo da zona.
# Por isso a zona e DERIVADA de $APP na instalacao, e nao escrita a mao.
sed "s/__APP__/${APP}/g" "$DESTINO/nginx/${APP}-limites.conf" > "/etc/nginx/conf.d/${APP}-limites.conf"
chmod 644 "/etc/nginx/conf.d/${APP}-limites.conf"

if temCertificado "$DOMINIO"; then
  escrever_conf "$DOMINIO" principal sim; echo "    ${DOMINIO}: HTTPS (certificado já existe)"
else
  escrever_conf "$DOMINIO" principal nao; echo "    ${DOMINIO}: provisório em HTTP"
fi
if [ -n "$TRABALHO" ]; then
  if temCertificado "$TRABALHO"; then
    escrever_conf "$TRABALHO" trabalho sim; echo "    ${TRABALHO}: HTTPS (certificado já existe)"
  else
    escrever_conf "$TRABALHO" trabalho nao; echo "    ${TRABALHO}: provisório em HTTP"
  fi
fi

nginx -t || erro "a configuração do nginx tem erro — nada foi recarregado"
systemctl reload nginx || erro "o nginx não recarregou — veja: systemctl status nginx"

# ESCREVER O ARQUIVO NÃO É O MESMO QUE O NGINX LER O ARQUIVO.
#
# `nginx -t` só diz que nada está QUEBRADO. Um bloco que o nginx sequer inclui
# passa no teste, recarrega sem reclamar, e o site simplesmente não existe —
# quem responde é o default_server, com 404. Foi o que aconteceu aqui: horas
# perdidas em DNS, firewall e certbot por causa de um arquivo que estava no
# disco e fora do alcance do nginx.
#
# `nginx -T` (maiúsculo) despeja a configuração REALMENTE montada. Se o
# server_name não aparece lá, não adianta nada do resto.
confirmarBlocoAtivo() {
  local dom="$1"
  local montada
  montada=$(nginx -T 2>/dev/null) || { aviso "    não consegui ler a configuração montada"; return 0; }
  printf '%s' "$montada" | grep -qE "server_name[^;]*\b${dom//./\\.}\b" && return 0

  aviso ""
  aviso "  ✖ o bloco de ${dom} está no disco mas o nginx NÃO o carrega."
  aviso "    O arquivo foi escrito e o link criado, mas ele está fora da"
  aviso "    configuração montada — por isso quem responde é o site padrão."
  aviso ""
  aviso "    A causa quase sempre é o include do nginx.conf não alcançar a pasta:"
  aviso "      grep -n include /etc/nginx/nginx.conf"
  aviso "      ls -la /etc/nginx/sites-enabled/"
  aviso ""
  aviso "    Se o include apontar só para conf.d, ligue o bloco lá:"
  aviso "      ln -sfn /etc/nginx/sites-available/${dom}.conf /etc/nginx/conf.d/${dom}.conf"
  aviso "      nginx -t && systemctl reload nginx"
  return 1
}

BLOCOS_ATIVOS=1
for dom in "$DOMINIO" ${TRABALHO:+$TRABALHO}; do
  confirmarBlocoAtivo "$dom" || BLOCOS_ATIVOS=0
done
# `if`, não `[ … ] && echo`: com `set -e`, um `&&` cujo teste dá falso é a
# última coisa que o shell avalia — e o script morre aqui, silencioso, sem
# chegar às etapas que explicariam o problema.
if [ "$BLOCOS_ATIVOS" -eq 1 ]; then
  echo "    o nginx carrega os blocos deste site"
fi

# --------------------------------------------------------------------------
# Sem bloco carregado não existe certificado possível: o desafio do ACME é
# servido POR ESSE bloco. Pedir mesmo assim só gasta o limite semanal do Let's
# Encrypt e enche o log de um erro cuja causa está uma etapa atrás.
if [ "$COM_TLS" -eq 1 ] && [ "$BLOCOS_ATIVOS" -eq 0 ]; then
  msg "6/8  Certificado TLS — pulado"
  aviso "    O nginx não carrega o bloco deste site (veja a etapa 5). Enquanto"
  aviso "    isso não for resolvido, o desafio do certbot vai dar 404 sempre."
  COM_TLS=0
fi
if [ "$COM_TLS" -eq 1 ]; then
  msg "6/8  Certificado TLS"
  command -v certbot >/dev/null || erro "certbot não está instalado (apt install -y certbot)"

  # ------------------------------------------------------------------------
  # ENSAIO DO DESAFIO, ANTES DE PEDIR O CERTIFICADO.
  #
  # O Let's Encrypt tem LIMITE de tentativas por semana. Descobrir que o
  # caminho do desafio devolve 404 gastando uma emissão de verdade é caro — e
  # foi o que aconteceu na primeira subida: o certbot criou o arquivo, a
  # autoridade pediu, e alguma outra coisa no nginx respondeu 404.
  #
  # Aqui a gente escreve um arquivo igual ao que o certbot escreveria e pede
  # ele PELO NOME PÚBLICO, do próprio servidor. Se não vier de volta, o
  # problema é de configuração, não de certificado — e dizer isso agora poupa
  # a tentativa e a caçada.
  ensaiarDesafio() {
    local dom="$1"
    local nome="ensaio-$$-$(date +%s)"
    local arq="${RAIZ_ACME}/.well-known/acme-challenge/${nome}"
    mkdir -p "$(dirname "$arq")"
    echo "ensaio-criar-site" > "$arq"
    chmod 644 "$arq"
    local url="http://${dom}/.well-known/acme-challenge/${nome}"
    local corpo status
    corpo=$(curl -s --max-time 10 "$url" 2>/dev/null || true)
    status=$(codigo "$url" 10)
    rm -f "$arq"
    [ "$corpo" = "ensaio-criar-site" ] && return 0

    # Não passou. Listar as quatro causas possíveis não ajuda ninguém — dá para
    # saber QUAL é, e dizer só ela.
    local ip; ip=$(getent hosts "$dom" 2>/dev/null | awk '{print $1}' | head -1)
    aviso "    $dom: o caminho do desafio NÃO responde (HTTP ${status})."
    if [ -z "$ip" ]; then
      aviso "      O nome não resolve. Falta o registro A apontando para este servidor."
    elif ! enderecosDaMaquina | grep -qx "$ip"; then
      aviso "      Resolve para ${ip}, que NÃO é endereço desta máquina."
      aviso "      Ou o registro A está errado, ou há um proxy na frente — a nuvem"
      aviso "      laranja do Cloudflare intercepta o desafio. Endereços daqui:"
      enderecosDaMaquina | grep -v '^127\.' | grep -v ':' | sed 's/^/        /'
    elif [ "$status" = "000" ]; then
      aviso "      Nada atendeu na porta 80 — firewall fechado ou nginx parado:"
      aviso "        ufw allow 'Nginx Full'   e   systemctl status nginx"
    elif [ "$status" = "404" ]; then
      # Refaz o mesmo pedido forçando o destino para 127.0.0.1. A rede sai da
      # conta: é o nginx DESTA máquina respondendo, com o mesmo cabeçalho Host.
      # Comparar as duas respostas separa "a configuração daqui está errada" de
      # "tem alguma coisa entre a internet e nós".
      echo "ensaio-criar-site" > "$arq"; chmod 644 "$arq"
      local local_corpo
      local_corpo=$(curl -s --max-time 10 --resolve "${dom}:80:127.0.0.1" "$url" 2>/dev/null || true)
      rm -f "$arq"
      aviso "      O DNS está certo — ${ip} é endereço desta máquina — e veio 404."
      if [ "$local_corpo" = "ensaio-criar-site" ]; then
        aviso "      Mas pedindo direto ao nginx daqui FUNCIONA. Então a configuração"
        aviso "      está boa e alguma coisa atende antes: proxy, CDN, ou outra"
        aviso "      máquina respondendo por este IP."
      else
        aviso "      E pedindo direto ao nginx daqui falha igual — ou seja, é a"
        aviso "      configuração desta máquina, sem envolver rede. Veja qual bloco"
        aviso "      atendeu (com sudo, e sem descartar o erro):"
        aviso "        sudo nginx -T 2>&1 | grep -n -B3 -A10 '$dom'"
        aviso "        ls -la /etc/nginx/sites-enabled/"
        aviso "      e confirme que o nginx enxerga o webroot:"
        aviso "        ls -la ${RAIZ_ACME}/.well-known/acme-challenge/"
      fi
    else
      aviso "      Resposta inesperada. Veja qual bloco atendeu:"
      aviso "        sudo nginx -T 2>&1 | grep -n -B3 -A10 '$dom'"
    fi
    return 1
  }

  # Só entram nesta lista os domínios que PASSARAM no ensaio. O certbot não é
  # chamado para os outros: o Let's Encrypt limita tentativas por semana, e
  # insistir num domínio que já se sabe quebrado gasta o limite à toa — que foi
  # o que o ensaio veio evitar.
  PODE_TLS=""
  for dom in "$DOMINIO" ${TRABALHO:+$TRABALHO}; do
    if temCertificado "$dom"; then PODE_TLS="$PODE_TLS $dom"; continue; fi
    if ensaiarDesafio "$dom"; then
      echo "    $dom: o caminho do desafio responde"
      PODE_TLS="$PODE_TLS $dom"
    else
      aviso "      → não vou pedir certificado para $dom. Corrija e rode de novo."
    fi
  done

  # `certonly --webroot`: emite e NÃO ENCOSTA na configuração do nginx. Com
  # `--nginx`, o certbot reescreve os blocos do jeito dele e come os cabeçalhos
  # e as regras deste projeto.
  #
  # Um certificado POR ENDEREÇO, não um só com os dois: se o subdomínio de
  # trabalho sair do ar, a renovação do site do cliente não para junto.
  for dom in $PODE_TLS; do
    if temCertificado "$dom"; then echo "    $dom: já tem certificado"; continue; fi
    extra=""
    [ "$dom" = "$DOMINIO" ] && ehDominioRaiz "$dom" && extra="-d www.${dom}"
    if certbot certonly --webroot -w "$RAIZ_ACME" -d "$dom" $extra \
         --non-interactive --agree-tos -m "$EMAIL_TLS"; then
      bom "    $dom: certificado emitido"
    else
      aviso "    $dom: não consegui emitir — o DNS já aponta para este servidor?"
      aviso "      confira com:  dig +short $dom"
    fi
  done

  msg "7/8  Configuração definitiva, agora com HTTPS"
  temCertificado "$DOMINIO" && { escrever_conf "$DOMINIO" principal sim; echo "    ${DOMINIO}: HTTPS ligado"; } \
                            || aviso "    ${DOMINIO}: segue em HTTP (sem certificado)"
  if [ -n "$TRABALHO" ]; then
    temCertificado "$TRABALHO" && { escrever_conf "$TRABALHO" trabalho sim; echo "    ${TRABALHO}: HTTPS ligado"; } \
                               || aviso "    ${TRABALHO}: segue em HTTP (sem certificado)"
  fi

  # ENQUANTO NÃO HÁ CERTIFICADO, `https://` MOSTRA O CERTIFICADO DE OUTRO SITE.
  #
  # Sem bloco na 443 para este nome, o nginx atende com o PRIMEIRO bloco 443 que
  # existir na máquina — e o navegador acusa ERR_CERT_COMMON_NAME_INVALID
  # citando um domínio alheio. Parece invasão ou configuração trocada; é só
  # ausência. Dizer isso aqui evita o susto e a caçada.
  for dom in "$DOMINIO" ${TRABALHO:+$TRABALHO}; do
    if ! temCertificado "$dom"; then
      aviso "    atenção: até o certificado sair, use http://${dom} — o https vai"
      aviso "    mostrar aviso de segurança com o nome de outro site desta máquina."
    fi
  done

  nginx -t || erro "a configuração definitiva tem erro — o provisório continua no ar"
  systemctl reload nginx

  # A renovação é automática, mas só serve se o nginx recarregar depois —
  # senão o certificado novo fica no disco e o vencido continua sendo servido.
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh
  echo "    gancho de recarga na renovação instalado"
else
  msg "6/8 e 7/8  TLS pulado (--sem-tls) — o site está em HTTP"
fi

# --------------------------------------------------------------------------
msg "8/8  Conferindo"

falhou=0
appNoAr=1
for alvo in "/" "/servicos/" "/vitrine/" "/orcamento/" "/privacidade/"; do
  cod=$(codigo "http://127.0.0.1:${PORTA}${alvo}")
  printf "    %-46s %s
" "127.0.0.1:${PORTA}${alvo}" "${cod:-sem resposta}"
  [ "$cod" = "200" ] || { falhou=1; [ "$cod" = "000" ] && appNoAr=0; }
done

if [ "$appNoAr" -eq 0 ]; then
  # SEM ISTO O SCRIPT MENTIA. Quando o app não responde, o teste do banco
  # também dá 000 — e a mensagem "o banco está sendo servido!" aparecia,
  # mandando procurar uma falha de segurança que não existe. O que existe é
  # um app fora do ar.
  aviso ""
  aviso "  O app não respondeu em 127.0.0.1:${PORTA}. Isso explica TODAS as"
  aviso "  linhas acima — inclusive as de baixo, que dependem dele."
  aviso "  Veja o que houve:"
  echo  "      systemctl status ${APP} --no-pager"
  echo  "      journalctl -u ${APP} -n 50 --no-pager"
else
  # O banco NÃO pode sair pela web: é onde mora a senha do painel.
  cod=$(codigo "http://127.0.0.1:${PORTA}/data/site.db")
  printf "    %-46s %s (tem de ser 404)
" "o banco pela web" "${cod:-sem resposta}"
  if [ "$cod" != "404" ]; then
    falhou=1
    printf "[1;31m    ✖ o banco NÃO está protegido — respondeu %s[0m
" "$cod"
  fi
fi

# E de fora, pelo nome público — é ali que mora o erro de certificado e de proxy.
for dom in "$DOMINIO" ${TRABALHO:+$TRABALHO}; do
  cod=$(codigo "https://${dom}/" 12)
  case "$cod" in
    200) printf "    %-46s %s
" "https://${dom}/" "$cod" ;;
    000|"") printf "    %-46s %s
" "https://${dom}/" "sem resposta (certificado ainda não emitido?)" ;;
    *)   printf "    %-46s %s
" "https://${dom}/" "$cod" ;;
  esac
done

[ -f "$DESTINO/verificar.sh" ] && bash "$DESTINO/verificar.sh" || true

echo
if [ "$falhou" -eq 0 ]; then bom "  Pronto."; else aviso "  Subiu com pendências — veja acima."; fi
cat <<FIM

  Site do cliente : https://${DOMINIO}
$([ -n "$TRABALHO" ] && echo "  Trabalho        : https://${TRABALHO}   (não indexado)")
  Painel          : https://${DOMINIO}/admin/
  Projeto         : ${DESTINO}   (dono ${USUARIO}:${GRUPO})

  SENHA INICIAL DO PAINEL: borda-admin
  Troque no primeiro acesso — ela é pública no repositório.

FIM
