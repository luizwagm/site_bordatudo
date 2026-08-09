# Subir a Borda Tudo — passo a passo

Do servidor vazio ao `/restrito` funcionando. **O site fica em construção**; quem
sobe agora é o sistema de produção.

Cada passo tem como **conferir** antes de ir para o próximo. Se um deles não der
o resultado descrito, pare ali — o erro só fica mais caro depois.

> As senhas de superusuário são digitadas **por você**, no seu terminal. Não
> preciso delas em lugar nenhum, e não as guardo.

---

## O que você vai precisar antes de começar

- acesso `ssh` ao servidor, com `sudo`
- o domínio `bordatudo.com` apontando para o IP do servidor (registro A)
- 20 minutos

---

## 1. Instalar o PostgreSQL

```bash
sudo apt update && sudo apt install -y postgresql postgresql-client
```

**Conferir** — tem de dizer `active (exited)` ou `active (running)`:

```bash
systemctl status postgresql@*-main --no-pager
```

> Repare no `@*-main`. A unit chamada só `postgresql` é uma **fachada**: ela
> termina com sucesso em um segundo e não diz nada sobre o banco estar de pé.
> Perguntar a ela é como perguntar ao interruptor se a lâmpada acendeu.

---

## 2. Criar o papel e o banco

O arquivo `sql/01-criar-banco.sql` é o roteiro. **Escolha uma senha e troque
dentro dele antes de rodar** — a que está lá é `troque-esta-senha`, visível de
propósito, porque senha em arquivo versionado é senha pública.

```bash
cd /var/www/projetos/Borda-Tudo
nano sql/01-criar-banco.sql          # troque a senha na linha CREATE ROLE
sudo -u postgres psql -f sql/01-criar-banco.sql
```

**Conferir** — tem de listar `bordatudo_producao`:

```bash
sudo -u postgres psql -lqt | cut -d'|' -f1 | grep bordatudo
```

---

## 3. Guardar as credenciais fora do projeto

Duas linhas, num arquivo que só o serviço lê:

```bash
sudo install -o root -g deploy -m 640 /dev/null /etc/bordatudo.env
sudo nano /etc/bordatudo.env
```

Conteúdo:

```
PGPASSWORD=<a senha que você escolheu no passo 2>
DADOS_CHAVE=<cole aqui o resultado de: openssl rand -base64 32>
```

O `640` com o grupo do serviço é o ponto: o processo lê, e nenhum outro usuário
da máquina lê. Não use `Environment=` dentro da unit — o conteúdo de uma unit
aparece para qualquer um com `systemctl cat`.

> **`DADOS_CHAVE` perdida é dado cifrado perdido para sempre.** Guarde uma cópia
> **fora do servidor**, hoje. Não existe recuperação.

**Conferir**:

```bash
sudo stat -c '%a %U:%G' /etc/bordatudo.env      # tem de sair: 640 root:deploy
sudo grep -c . /etc/bordatudo.env               # tem de sair: 2
```

---

## 4. Criar as tabelas

```bash
node sql/rodar.cjs 02-esquema.sql
node sql/rodar.cjs 04-cadastros.sql
node sql/rodar.cjs 05-senha-provisoria.sql
node sql/rodar.cjs 06-preco-pagamento-dono.sql
```

Rodar de novo não faz mal: os quatro arquivos são `IF NOT EXISTS`.

O `06` traz o **preço** do desenho, o **valor** da ficha, a data de **pagamento**
do lote e o papel de **dono**. Sem ele o sistema sobe e quebra na primeira tela
que fala em dinheiro — a coluna simplesmente não existe.

**Conferir** — tem de listar 10 tabelas:

```bash
sudo -u postgres psql -d bordatudo_producao -c '\dt'
```

---

## 5. Dados para o sistema não nascer vazio

```bash
node sql/03-dados-de-teste.cjs --gravar
```

Entram os clientes, desenhos e mercadorias lidos das fotos das planilhas, mais
4 máquinas inventadas (MAQ 01 a 04).

> **As pontuações são chute**, menos RECIFE1 (9.484) e RECIFE2 (34.422), que
> vieram da foto. Bordado se cobra por ponto: **confira todas** antes de faturar
> em cima delas.

Quando os dados de verdade chegarem, `node sql/03-dados-de-teste.cjs
--limpar-tudo` zera tudo, produção inclusive.

---

## 6. O primeiro administrador

```bash
node criar-usuario.cjs eduardo admin "Eduardo"
```

A senha é **gerada** com **seis números**, aparece uma vez e não aparece mais.
Anote antes de fechar o terminal.

Ela é de **uso único**: no primeiro acesso o sistema exige a troca e **não deixa
fazer mais nada** antes disso. É o que impede que a senha que passou pelas mãos
de quem cadastrou continue valendo como senha de verdade.

Deste ponto em diante, usuário se cria **pela tela**: Cadastros → Usuários →
Novo. Este comando existe só para o primeiro administrador e para o caso de
ficar todo mundo trancado do lado de fora.

### 6b. A conta de dono

```bash
node criar-usuario.cjs --dono <seu-login> "Seu Nome"
```

Uma conta acima de administrador, para manutenção do sistema. Ela **não aparece
na lista de usuários** e **nenhuma tela a altera, desativa, apaga ou redefine** —
este comando é a única porta.

- **Só pode existir uma.** Quem garante é um índice único no banco, não uma
  conferência do programa: duas execuções ao mesmo tempo passariam por qualquer
  `if`, e o banco recusa a segunda.
- A senha é **longa e sorteada**, não os seis dígitos das outras. Como ela não
  pode ser trocada pela tela, seis dígitos ficariam valendo para sempre numa
  conta com poder sobre tudo. Guarde num gerenciador de senhas.
- Para **trocar a senha**, rode o mesmo comando de novo.

> Crie **antes** de o cliente começar a usar. O comando continua funcionando
> depois, mas criar a conta de manutenção no meio de um dia de produção é mexer
> no sistema com gente dentro.

---

## 7. Instalar o serviço

```bash
sudo ./nginx/criar_site.sh bordatudo.com
```

Ele monta o nginx, a unit do systemd e pede o certificado. Se preferir instalar
a unit à mão, o cabeçalho do `bordatudo.service` traz o `sed` pronto.

**Conferir** — tem de dizer `active (running)`, e o `EnvironmentFile` tem de
aparecer:

```bash
systemctl status bordatudo --no-pager
systemctl cat bordatudo | grep EnvironmentFile
```

Se subiu e caiu segundos depois com `status=5/TRAP`, alguém pôs
`MemoryDenyWriteExecute=yes` na unit: essa trava mata o V8 e **não** é erro de
rede nem de banco.

---

## 8. Conferir tudo de uma vez

```bash
./verificar.sh
```

O que tem de aparecer:

- `situação do site  EM CONSTRUÇÃO — o visitante vê a página de aviso`
- o bloco **Banco do /restrito (PostgreSQL)** com as contagens das 6 tabelas
- nenhuma linha `ATENÇÃO: nenhum administrador ativo`

---

## 9. Provar pela internet

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://bordatudo.com/          # 503
curl -s https://bordatudo.com/ | grep -c 'sendo bordado'                 # 1
curl -s -o /dev/null -w '%{http_code}\n' https://bordatudo.com/restrito  # 200
```

Depois entre em `https://bordatudo.com/restrito`. Na **primeira vez** o sistema
vai pedir a troca da senha de seis números — troque, e ele continua de onde
parou, sem entrar de novo.

Aí faça o caminho inteiro uma vez: **INÍCIO DE PRODUÇÃO → ABRIR FICHA → FECHAR
FICHA**. É a única prova que vale.

> Use uma ficha própria para o teste e **cancele-a** depois — ficha cancelada
> não conta na produção nem entra em lote.

---

## 10. Imprimir os QR das máquinas

Entre no `/restrito` como administrador e abra:

```
https://bordatudo.com/restrito/etiquetas
```

Imprima, recorte e cole cada etiqueta na máquina. Quem ler o código com o
celular cai na tela de produção já com a máquina escolhida.

Antes de colar, renomeie MAQ 01–04 para os nomes que a fábrica usa, em
Cadastros → Máquinas. O nome impresso é o que o operador confere no alto da
tela para saber que leu o adesivo certo.

---

## Depois: atualizar

```bash
sudo ./deploy.sh
```

Ele faz, nesta ordem: backup do `site.db` → **dump do Postgres** → inventário →
para o serviço → tira banco e fotos do caminho do git → `git pull` →
dependências → **migrações do `sql/`** → devolve tudo → sobe → confere que nada
sumiu.

Se o `pg_dump` falhar, o deploy **para** — o `/restrito` é dado de faturamento e
não se atualiza sem cópia. Para forçar (por sua conta):
`SEM_BACKUP_PG=1 sudo ./deploy.sh`.

---

## Backup

O serviço tira uma cópia por dia dos **dois** bancos, na pasta `backups/`:
`site.<data>.db` (SQLite) e `bordatudo_producao.<data>.sql` (`pg_dump`). Guarda
as 30 últimas.

Cópia agora:

```bash
node backup.js agora
node backup.js status
```

**Backup que nunca foi restaurado não é backup.** Teste uma vez, num banco
descartável — leva dois minutos e é o que separa "tenho backup" de "tenho
backup que funciona":

```bash
sudo -u postgres createdb bordatudo_teste_restauro
sudo -u postgres psql -d bordatudo_teste_restauro -f backups/bordatudo_producao.<data>.sql
sudo -u postgres psql -d bordatudo_teste_restauro -c 'SELECT COUNT(*) FROM fichas'
sudo -u postgres dropdb bordatudo_teste_restauro
```

A pasta `backups/` fica **no mesmo disco** do banco. Isso protege contra erro
humano e atualização malfeita, mas **não** contra o disco morrer. Copiar a pasta
para fora do servidor uma vez por semana é o que fecha essa porta.

---

## Quando o site for lançado

O site está **travado** em construção: nem o painel o abre. A trava é uma
constante no `server.js` (`TRAVA_CONSTRUCAO`), e não uma configuração, porque
configuração se muda sem querer — e o efeito de mudar esta é o site inteiro
aparecer antes da hora.

Para lançar:

1. `TRAVA_CONSTRUCAO = false` no `server.js`;
2. painel → **Situação do site** → *Site no ar*;
3. suba a versão e `sudo ./deploy.sh`.

Volta na hora. As páginas estiveram gravadas o tempo todo.

Antes de lançar, preencha o **CNPJ** no painel: hoje está `0`, e por isso ele
não sai no rodapé do site nem no recibo do lote.
