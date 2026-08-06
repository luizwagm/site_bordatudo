# Borda Tudo

Site institucional + **controle de produção** (`/restrito`) da Borda Tudo —
Bordados Computadorizados, Caruaru-PE.

São duas coisas no mesmo processo, com bancos separados:

| Parte | O que é | Onde grava |
|---|---|---|
| **Site** (`/`) | páginas estáticas, reescritas na publicação | SQLite `data/site.db` |
| **Painel** (`/admin/`) | edita textos, fotos e vitrine do site | SQLite `data/site.db` |
| **Produção** (`/restrito`) | fichas, lotes, amálgama, nota | PostgreSQL `bordatudo_producao` |

O `/restrito` usa Postgres porque é dado de faturamento: precisa de transação,
de coluna calculada pelo banco e de índice que **impede** o registro errado de
existir. O site continua em SQLite porque é conteúdo, não dinheiro.

> **Agora o site está TRAVADO em construção.** Quem visita vê uma página de aviso
> com o caminho para o WhatsApp; nada do site é servido, e **nem o painel abre o
> site** enquanto a trava estiver de pé. As páginas continuam todas gravadas —
> só não saem. O que está no ar é o `/restrito`.

---

## Situação do site

Em **Painel → Situação do site**, três estados:

| Estado | O visitante vê | Para quando |
|---|---|---|
| **Site no ar** | o site | depois do lançamento |
| **Em construção** | `construcao.html` — "nosso site está sendo bordado" | antes de o site existir |
| **Em manutenção** | `manutencao.html` — "voltamos já" | quando ele já esteve no ar |

A diferença não é enfeite: manutenção **promete que o site volta**, e prometer
volta de um site que nunca subiu é a primeira impressão que a empresa dá.

**Acima dos três está a TRAVA.** `TRAVA_CONSTRUCAO` no `server.js` é uma
constante, não uma configuração: enquanto for `true`, escolher "Site no ar" no
painel **não** abre o site. Configuração se muda sem querer, e o efeito de mudar
esta é o site inteiro aparecer antes da hora — por isso sair dela leva commit,
versão e deploy. O painel avisa que está travado, para ninguém passar a tarde
procurando defeito no servidor.

Fora do ar, as páginas respondem **503** (e não 200) para o Google entender que
aquilo não é a home — senão o aviso fica indexado semanas depois do lançamento.
O `/admin`, o `/restrito`, os `assets` e o favicon continuam servindo: sem o
painel não haveria como voltar atrás, e a produção da fábrica não para porque o
site institucional parou.

---

## O que o /restrito substitui

A folha de papel onde cada operador anotava cliente, desenho, pontuação e
quantidade — e somava de cabeça no fim do turno.

Três operações manuais viraram impossíveis de errar:

| No papel | No sistema |
|---|---|
| a pontuação era decorada e escrita à mão | é **copiada do desenho** na hora de abrir a ficha |
| o total era multiplicado de cabeça | é **coluna gerada pelo Postgres** — nem por SQL dá para escrever outro valor |
| o "X" no canto marcava o que já tinha entrado na nota | o vínculo **ficha → lote** é uma coluna, e lote faturado tranca |

### O dia do operador

1. **INÍCIO DE PRODUÇÃO** — abre a jornada. Clicar duas vezes não abre duas.
2. **ABRIR FICHA** — cliente → desenho (só os daquele cliente) → a pontuação
   aparece na tela. A máquina vem do **QR colado nela**.
3. **FECHAR FICHA** — quantidade de peças, mercadoria e cor. O total em pontos
   aparece **enquanto se digita**, antes de confirmar.

Só existe uma ficha aberta por operador, e a produção não encerra com ficha
aberta.

### O dia do administrativo

- **Produção** — tudo que saiu das máquinas, com filtro por período, operador e
  cliente, e a marca de quem ainda está **fora de lote**.
- **Lotes e amálgama** — o lote é o serviço do cliente; as fichas são os
  pedaços. "1500 abas" fecha somando 100 pretas + 500 brancas + 300 bege + …,
  feitas por várias pessoas em vários dias. A tela mostra a quebra por cor, por
  mercadoria e por operador, e quanto falta.
- **Nota** — marcar como faturado exige o número da nota. Depois disso o lote
  não aceita mais mexer nas fichas.
- **Recibo** — cada lote imprime um recibo com marca d'água, cabeçalho da
  empresa, dados do cliente, a produção ficha por ficha, a composição por cor,
  mercadoria e operador, e **duas linhas de assinatura**. Abre em aba própria,
  em **retrato** ou **paisagem** — a orientação é escolhida no botão, não só na
  janela de impressão, porque é ela que define margens, marca d'água e largura
  da tabela.

### Cadastros

Um item do menu que abre quatro telas:

| Tela | O que tem |
|---|---|
| **Clientes** | lista paginada com busca por nome, documento, telefone, e-mail ou cidade; cadastro com CNPJ/CPF (o que vai para a nota) e o resumo de quanto o cliente já rendeu |
| **Desenhos** | lista paginada com busca e **miniatura**; cadastro com cliente, pontuação e **uma ou mais fotos** |
| **Mercadorias, cores e máquinas** | três abas — listas de palavras que nascem uma vez e quase não mudam. A cor tem um campo de **tom**, que vira a bolinha da lista: "Bege" escrito não distingue dois beges na mesma remessa |
| **Usuários** | criar, editar e redefinir senha, tudo pela tela |

**A senha nasce provisória.** O sistema gera **seis números** — para se ditar por
telefone e digitar no teclado do celular preso à máquina — e ela serve para
abrir a porta **uma vez**: no primeiro acesso a pessoa é obrigada a trocar, e o
servidor recusa qualquer outra rota até lá. A senha passou pelas mãos de quem
cadastrou; ela não pode valer como senha de verdade nem por um turno.

**As fotos do desenho** ficam em `data/desenhos/`, **fora** de `assets/`, e só
saem por uma rota que exige sessão. O desenho é propriedade do cliente: em
`assets/` bastaria acertar o nome do arquivo para baixar o bordado de qualquer
um, sem login. O que chega é conferido pela **assinatura do arquivo**, não pela
extensão — um `.png` que na verdade é HTML é recusado.

---

## Instalação do /restrito

> **Para subir no servidor, o roteiro completo está em [SUBIR.md](SUBIR.md)** —
> com o que conferir a cada passo. O que vem abaixo é o resumo, e serve para a
> máquina de quem desenvolve.

O banco é criado por você, no seu terminal — eu nunca peço senha de superusuário.

```bash
psql -U postgres -f sql/01-criar-banco.sql      # troque a senha dentro do arquivo antes
```

Ponha no `.env` da raiz (que **não** vai para o git):

```
PGPASSWORD=<a senha que você escolheu>
DADOS_CHAVE=<32 bytes em hex — gere com: openssl rand -hex 32>
```

> **Perder `DADOS_CHAVE` é perder os dados cifrados para sempre.** Guarde-a fora
> do servidor.

Depois:

```bash
node sql/rodar.cjs 02-esquema.sql
node sql/rodar.cjs 04-cadastros.sql
node sql/03-dados-de-teste.cjs --gravar
node criar-usuario.cjs eduardo admin "Eduardo"
```

O `criar-usuario.cjs` cria o **primeiro administrador** — antes dele não há
ninguém para entrar no painel. Do segundo em diante, é tudo pela tela:
**Cadastros → Usuários → Novo**. O script fica no projeto só para isso e para o
caso de ficar todo mundo trancado do lado de fora.

A senha é sempre **gerada** — no script e no painel, pela mesma função — e
mostrada **uma vez**. Ninguém, nem o administrador, lê a senha de outra pessoa
depois: para atender "esqueci a senha", use **redefinir senha**, que gera outra
e derruba as sessões daquela conta.

### Quando os dados de verdade chegarem

Os cadastros que vieram das fotos (clientes, desenhos, mercadorias) e as
máquinas MAQ 01–04 são **de teste**. Para zerar tudo, produção inclusive:

```bash
node sql/03-dados-de-teste.cjs --limpar-tudo
```

> **As pontuações são chute**, menos RECIFE1 (9.484) e RECIFE2 (34.422), que
> vieram da foto. Bordado se cobra por ponto: confira TODAS antes de faturar em
> cima delas.

---

## QR das máquinas

Cadastre a máquina em **Cadastros → Máquinas** e imprima:

```
/restrito/etiquetas              todas as máquinas ativas
/restrito/etiquetas?maquina=3    só uma
```

Recorte e cole na máquina. Quem lê o código cai na tela de produção já com a
máquina escolhida.

O QR **identifica, não autentica**: quem escaneia ainda precisa estar logado.
Um adesivo fotografado não dá acesso a nada. Se um adesivo se perder, use
**trocar QR** — o antigo deixa de valer na hora.

---

## Rodar

```bash
npm start                    # site + painel + /restrito na porta 5193
npm test                     # as duas suítes (247 + 47 conferências)
node backup.js agora         # cópia dos DOIS bancos (site.db + pg_dump)
```

`testar-restrito.cjs` sobe o servidor numa porta própria, cria os registros dela
com prefixo `ZZ QA` e apaga **por id** no fim. Se morrer no meio, os restos
ficam visíveis com esse prefixo e somem na próxima execução — ou com
`node testar-restrito.cjs --limpar`.

`testar-site.cjs` roda contra um **banco descartável** (`SITE_DB`) numa pasta
temporária: não encosta no `data/site.db` do cliente e não precisa da senha do
painel.

---

## Operação no servidor

Roteiro de primeira subida: **[SUBIR.md](SUBIR.md)**.

```bash
./deploy.sh                  # atualiza (backup dos DOIS bancos + migrações)
./verificar.sh               # confere que subiu
systemctl status bordatudo
journalctl -u bordatudo -n 50
```

---

## Duas coisas para saber antes de doer

**A trava de senha é por IP.** Cinco erros do mesmo endereço em 15 minutos
fecham por 15 minutos. Na fábrica todo mundo sai pelo mesmo IP público: se
algumas pessoas errarem a senha na mesma manhã, a loja inteira fica de fora.
Se isso acontecer na prática, os números estão em `limitador.js` (`ipMax`,
`ipJanelaMin`) e vale afrouxar o balde do IP mantendo o da conta.

**Cadastro nunca é apagado, é desativado.** Um cliente removido sumiria dos
relatórios de três meses atrás. Ele sai da lista de escolha e continua no
histórico.

---

Desenvolvido por [Luiz Augusto](https://luizaugust.me).
