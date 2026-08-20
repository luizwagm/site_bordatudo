# Borda Tudo

Site institucional + **controle de produção** (`/restrito`) da Borda Tudo —
Bordados Computadorizados, Caruaru-PE.

**Versão 1.21.0** · Node ≥ 20 · porta 5193 · `npm test` → **632 conferências**.

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
  não aceita mais mexer nas fichas. Da própria tela do lote, **Abrir nota**
  emite a nota do financeiro com o cliente e o lote já escolhidos, sem sair
  dali — é a mesma rota do menu Financeiro, só que sem ter de reencontrar o
  lote numa lista onde eles se distinguem apenas pelo código.
- **Serviço que já foi feito** — nota antiga, ou avulsa. Em **Abrir ficha**, e
  só para o administrador, há *Lançar bordado de outra data*: a ficha nasce com
  a data escolhida, **fecha no dia dela** (e não no de hoje, que é de onde sai
  todo o relatório) e **não entra em jornada nenhuma** — não é hora trabalhada
  agora. A data só anda para trás. O mesmo botão existe dentro do lote, já com
  o cliente travado no dele.
- **Valor que falta** — o desenho que o operador cadastra nasce **sem preço**, e
  a ficha herda o nulo. Isso vale **zero** na soma da nota, e zero soma sem
  reclamar. A composição do lote tem uma coluna **Valor**, um aviso em laranja
  contando quantas fichas estão *a definir*, e o botão que preenche na hora —
  com a opção de gravar o preço também no cadastro do desenho, para a próxima
  ficha já nascer com valor. **Só o administrador** vê e preenche isso.
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
| **Desenhos** | lista paginada com busca e **miniatura**; cadastro com cliente, pontuação e **uma ou mais fotos — anexadas já na criação**, sem ter de gravar e reabrir |
| **Mercadorias, cores e máquinas** | três abas — listas de palavras que nascem uma vez e quase não mudam. A cor tem um campo de **tom**, que vira a bolinha da lista: "Bege" escrito não distingue dois beges na mesma remessa |
| **Usuários** | criar, editar e redefinir senha, tudo pela tela |

**A senha nasce provisória.** O sistema gera **seis números** — para se ditar por
telefone e digitar no teclado do celular preso à máquina — e ela serve para
abrir a porta **uma vez**: no primeiro acesso a pessoa é obrigada a trocar, e o
servidor recusa qualquer outra rota até lá. A senha passou pelas mãos de quem
cadastrou; ela não pode valer como senha de verdade nem por um turno.

**A imagem entra junto com o cadastro.** No desenho novo ela fica numa fila em
memória, com miniatura na tela, e sobe assim que o cadastro devolve o id — é
como a arte chega de verdade: colada de uma conversa, junto com o serviço. Se o
cadastro for recusado a modal não fecha e a fila continua ali; se uma imagem
falhar, o desenho não se perde por causa dela, e a que ficou de fora é dita
pelo nome.

**As fotos do desenho** ficam em `data/desenhos/`, **fora** de `assets/`, e só
saem por uma rota que exige sessão. O desenho é propriedade do cliente: em
`assets/` bastaria acertar o nome do arquivo para baixar o bordado de qualquer
um, sem login. O que chega é conferido pela **assinatura do arquivo**, não pela
extensão — um `.png` que na verdade é HTML é recusado.

---

## Financeiro

Depois que o lote fecha, o dinheiro tem três passos: **lote → nota →
lançamentos**.

| Peça | O que é |
|---|---|
| **Nota** | agrupa um ou mais lotes de um cliente. Tem código próprio (`NOTA-2026-0001`), número da nota fiscal, vencimento, desconto e acréscimo |
| **Lançamento** | uma linha por movimento de dinheiro, entrada ou saída, com recibo numerado quando é de nota |
| **Caixa** | o extrato da fábrica: o que o cliente pagou e o que a fábrica gastou |

**O valor da nota não é coluna.** Ele é a soma dos lotes, que somam as fichas.
Guardar um total criaria um segundo lugar para a mesma verdade — e no dia em que
uma ficha fosse corrigida, a nota continuaria dizendo o valor antigo sem que
nada avisasse. Pelo mesmo motivo **não existe situação "paga"**: a quitação é
calculada (valor menos o que entrou), e por isso não tem como mentir.

**Um lote entra em UMA nota.** É um índice único no banco. Sem ele, o mesmo
serviço poderia ser cobrado duas vezes — e a segunda cobrança pareceria tão
legítima quanto a primeira.

**Entrada e saída vivem na mesma tabela**, com a nota como coluna opcional.
Separar em duas faria "quanto entrou no mês" depender de qual consulta se usou.
O valor é **sempre positivo**; o sinal vem do tipo.

**Não se apaga lançamento.** `cancelado_em` marca e a linha fica: um recibo já
entregue ao cliente precisa continuar tendo lastro.

**Salário não tem nota.** É restrição no banco: um lançamento com nota é do
cliente, um com funcionário é da folha. Juntos, o salário apareceria no extrato
que o cliente recebe. Qual categoria pede funcionário é uma **coluna** da
categoria — não a palavra "Salários" escrita no servidor, que quebraria no dia
em que alguém a renomeasse para "Folha" pela própria tela.

---

## Somar fichas

Várias fichas de um lote podem virar uma só, para a nota sair enxuta. A ficha
absorvida vira situação **`somada`** — não é apagada:

- o **recibo já impresso continua conferível**, porque as parcelas ainda existem;
- **clique errado tem volta**: remover a ficha somada devolve as parcelas ao
  estado anterior;
- a **produção do operador não some do histórico** — e é por ela que se paga.

Ficha somada não pode estar em lote, e o banco recusa se tentarem.

---

## Horas do operador

Cada pessoa tem um **expediente** combinado, guardado em uma coluna JSONB com
dois formatos possíveis:

```
{"tipo":"fixo",  "dias":{"1":{"entrada":"07:30","saida":"17:00"}}}
{"tipo":"horas", "dias":{"1":{"horas":8}, "6":{"horas":4}}}
```

**Dia ausente = não trabalha.** É a distinção que catorze colunas separadas não
saberiam expressar, e é ela que faz o relatório saber que a falta de sábado não
é falta.

Daí saem a tela **Minhas horas** (o dia e o calendário do mês, para o operador)
e a tela **Horários** (a equipe inteira, com saldo, cor por pessoa e correção de
jornada, para o escritório).

> A ficha retroativa **não entra em jornada**: hora de trabalho é medida por
> relógio, não digitada.

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
DADOS_CHAVE=<32 bytes em BASE64 — gere com: openssl rand -base64 32>
```

> **Perder `DADOS_CHAVE` é perder os dados cifrados para sempre.** Guarde-a fora
> do servidor.

Depois:

```bash
node sql/rodar.cjs 02-esquema.sql
node sql/rodar.cjs 04-cadastros.sql
node sql/rodar.cjs 05-senha-provisoria.sql
node sql/rodar.cjs 06-preco-pagamento-dono.sql
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
npm test                     # as TRÊS suítes (501 + 84 + 47 = 632 conferências)
node backup.js agora         # cópia dos DOIS bancos (site.db + pg_dump)
```

| Suíte | Porta padrão | Confere |
|---|---|---|
| `testar-restrito.cjs` | 5199 | produção, lotes, cadastros, papéis, tempo real |
| `testar-financeiro.cjs` | 5197 | notas, lançamentos, caixa e salário |
| `testar-site.cjs` | 5198 | a trava e os três estados do site |

> **As portas padrão de duas delas colidem com produção de outros projetos**
> (5198 e 5197). A suíte se recusa a rodar se a porta estiver ocupada — o que a
> trava sempre que o vizinho está no ar. Contorne com `PORTA_TESTE_SITE=` e
> `PORTA_TESTE_FIN=`, ou mude os padrões para uma faixa reservada.

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

**Excluir e desativar são coisas diferentes, e há um botão para cada.**
Cadastro que nunca foi usado é engano de digitação: **excluir** apaga de vez.
Cadastro já usado está dentro de uma ficha que virou nota — esse o sistema
recusa excluir, dizendo quantos vínculos tem ("está em 2 desenhos, 3 fichas de
produção e 1 lote"), e só deixa **desativar**: sai da lista de escolha e
continua no histórico. Vale para clientes, desenhos, mercadorias, cores,
máquinas, usuários e lotes.

> Para **cor, mercadoria, máquina e lote** essa checagem é a ÚNICA proteção: no
> banco essas chaves são `ON DELETE SET NULL`, então sem ela apagar uma cor
> apagaria a cor de todas as fichas antigas em silêncio, e a composição do lote
> — que sustenta a nota — sairia errada sem ninguém perceber.

**Máquina desativada tem o QR invalidado.** O adesivo colado nela deixa de valer
na hora, e reativar exige imprimir etiqueta nova: um adesivo que passou meses
fora de uso pode ter ido parar em qualquer lugar.

**Lote só é apagado vazio.** Tire as fichas em "Juntar fichas" antes.

**A tela de Produção abre mostrando TUDO**, do mais recente para o mais antigo.
Abas de 7, 15 e 30 dias para os recortes de sempre; os campos de data para o
resto; "Limpar filtro" volta a tudo. As abas e as datas escrevem no MESMO
período — digitar à mão o intervalo de uma aba acende essa aba, e um intervalo
que não corresponde a nenhuma mostra "Período escolhido". Duas fontes para o
mesmo recorte fariam a tela dizer uma coisa e os números serem de outra.

**Todas as onze tabelas do sistema paginam**, com a mesma barra: quantas linhas
de quantas, o seletor de 10/20/50/100 por página e as setas. A barra aparece em
qualquer tabela com conteúdo — numa de cinco linhas ela é só a contagem, sem
setas: uma barra que às vezes existe e às vezes não obriga quem usa a descobrir
a regra.

> **Dois mecanismos, um desenho.** Produção, lotes, clientes e desenhos paginam
> no SERVIDOR — crescem sem limite e não cabem na memória do celular preso à
> máquina. As outras sete paginam no navegador, sobre listas que já chegam
> inteiras porque a tela precisa delas para os totais. O que não pode haver é
> duas BARRAS: `fatiar()` devolve o mesmo envelope que o servidor manda, e daí
> para baixo tudo é igual.

> **OS TOTAIS NUNCA SÃO DA PÁGINA.** Fichas, peças, pontos, a quebra por
> operador e o caixa dos lotes são contados pelo banco sobre o filtro inteiro.
> Virar a página não muda nenhum deles — e é por isso que o rodapé da tabela
> diz "Total do período" e "Total do lote", e não "Total": uma linha "Total"
> embaixo de vinte fichas, valendo por quatrocentas, é a leitura errada mais
> fácil de fazer numa tabela paginada.

**O preço é do escritório e não sai para o operador.** O desenho tem preço por
peça, e a API o REMOVE da resposta quando quem pergunta não é administrador —
não é um campo escondido por CSS. A ficha guarda uma CÓPIA do preço no momento
da abertura, como já fazia com a pontuação: reajustar um desenho hoje não pode
mudar o valor de uma ficha que já virou nota no mês passado.

**O operador cadastra desenho, e só isso.** A arte nova chega junto com o
serviço, fora do horário do escritório, e a ficha não abre sem desenho. Sem
essa porta, o que acontece na prática é o operador pendurar a produção num
desenho parecido — e isso envenena o relatório sem deixar rastro. Ele **cria**
e anexa imagem; **não altera nem exclui**, e o desenho nasce **sem preço**, o
que o põe na lista "sem preço" do administrador.

**Pago e faturado são fatos diferentes.** `situacao = faturado` é nota emitida;
`pago_em` é dinheiro recebido. Um lote faturado e não pago é o estado normal do
mês inteiro — é o que se cobra. Se "pago" fosse mais um valor de `situacao`,
marcar o pagamento apagaria o "faturado" e a pergunta "o que já saiu e ainda não
entrou?" deixaria de ter resposta.

**A conta de dono não está na lista de usuários — e nenhuma tela a toca.** Um
papel acima de administrador, para manutenção. Não é criada, alterada,
desativada, apagada nem tem senha redefinida pelo painel: `criar-usuario.cjs
--dono` é a única porta, e a senha dela só troca por lá. Só pode existir uma, e
quem garante é um índice único no banco.

> Esconder não é proteger. Se a conta apenas sumisse da lista, um `DELETE
> /restrito/api/usuarios/1` ainda a apagaria — e o id 1 é o primeiro palpite de
> qualquer um. As rotas de usuário respondem **404** para ela: para quem está de
> fora, ela não existe.

**As telas se atualizam sozinhas.** Uma conexão aberta (`EventSource`) avisa
todos os aparelhos quando um cadastro é gravado. O aviso leva **só o assunto**
("desenhos mudou"), nunca o dado: cada tela vai buscar pela rota normal e recebe
o que o papel dela permite — é o que impede o preço de chegar ao navegador do
operador por outro caminho.

> Isso vive na memória do processo. No dia em que o sistema rodar em mais de um
> processo, cada um avisaria só os seus; a correção é o `LISTEN/NOTIFY` do
> próprio PostgreSQL, não um servidor a mais.

**Cadastro apagado com a tela aberta não derruba mais a ficha.** A tela guarda
as listas em memória o turno inteiro. Se alguém apagar uma cor no escritório
nesse meio-tempo, o operador tinha a ficha recusada pelo banco com
`violates foreign key constraint` — e lia **"erro interno"** justamente ao
fechar uma ficha, com a peça bordada e a quantidade contada. Aconteceu seis
vezes em produção, 07 e 08/08/2026. Agora vem uma frase ("essa cor não existe
mais — escolha de novo"), a tela recarrega as listas sozinha, e a ficha
**continua aberta**: a recusa não a deixa pela metade.

> A mensagem é o remendo; o conserto é o aviso. Apagar e desativar cadastro
> passaram a avisar as telas abertas, o que fecha a janela em que a lista velha
> existe em vez de só tratar o sintoma.

---

## Documentação

Documentação completa em [`docs/`](docs/), gerada a partir da análise do código
e do banco em execução:

| Documento | Conteúdo |
|---|---|
| [Documentação Técnica](docs/documentacao-tecnica.pdf) | Arquitetura, a trava de construção, APIs, segurança, deploy, testes e pontos de atenção |
| [Documentação de Produto](docs/documentacao-produto.pdf) | O problema do papel, personas, fluxos, regras de negócio e requisitos |
| [Documentação de Banco de Dados](docs/documentacao-banco-de-dados.pdf) | 21 tabelas, diagrama ER, as regras que o banco impõe, migrações e recomendações |
| [Documentação de Protótipo](docs/documentacao-prototipo.pdf) | Identidade visual, telas, componentes, estados e navegação |

Roteiro de instalação em [`SUBIR.md`](SUBIR.md) — 10 passos, com o que conferir
em cada um.

> Os PDFs refletem a versão **1.21.0**. Ao subir versão que mude arquitetura,
> banco ou telas, vale regerá-los.

---

Desenvolvido por [Luiz Augusto](https://luizaugust.me).
