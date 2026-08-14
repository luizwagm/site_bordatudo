-- ==========================================================================
--  09 — FINANCEIRO: notas do cliente e caixa da fábrica
--
--  Roda como o papel `bordatudo`:
--      npm run banco:esquema     (ou psql -f sql/09-financeiro.sql)
--
--  Idempotente: pode rodar de novo sem estragar nada.
--
--  ==========================================================================
--  O DESENHO, EM UMA FRASE
--
--    lote → nota → lançamentos
--
--  A NOTA é do cliente: junta um ou mais lotes, tem um valor, e vai sendo
--  quitada aos poucos. O CAIXA é da fábrica: entra o que o cliente paga e sai
--  o que a fábrica gasta.
--
--  E os dois vivem na MESMA tabela de lançamentos, com a nota como coluna
--  opcional. A alternativa — uma tabela de pagamentos e outra de despesas —
--  parece mais arrumada e cria um problema imediato: "quanto entrou este mês"
--  passa a exigir somar duas tabelas com regras diferentes, e no dia em que uma
--  ganhar uma coluna que a outra não tem, o total do mês depende de qual
--  consulta se usou. Dinheiro que entra e dinheiro que sai são o mesmo tipo de
--  fato; o que muda é o sinal e o motivo.
--  ==========================================================================

-- --------------------------------------------------------------------------
--  NOTAS
--
--  O VALOR DA NOTA NÃO É COLUNA. Ele é a soma dos lotes que ela agrupa, e os
--  lotes somam as fichas. Guardar um total aqui criaria um segundo lugar para
--  a mesma verdade — e no dia em que uma ficha fosse corrigida, a nota
--  continuaria dizendo o valor antigo sem que nada avisasse.
--
--  O que É coluna são os AJUSTES: desconto e acréscimo combinados com o
--  cliente. Eles não saem de ficha nenhuma, então precisam morar em algum
--  lugar, e o lugar é a nota.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notas (
  id           BIGSERIAL PRIMARY KEY,
  codigo       TEXT NOT NULL UNIQUE,                -- NOTA-2026-0001
  cliente_id   BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  numero_nf    TEXT NOT NULL DEFAULT '',            -- o número da nota fiscal de verdade
  emitida_em   DATE NOT NULL DEFAULT CURRENT_DATE,
  vencimento   DATE,
  desconto     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
  acrescimo    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (acrescimo >= 0),
  observacao   TEXT NOT NULL DEFAULT '',
  -- `cancelada` existe e `paga` NÃO existe: se "paga" fosse uma situação
  -- guardada, ela poderia discordar da soma dos pagamentos. A quitação é
  -- CALCULADA — valor menos o que entrou — e por isso não tem como mentir.
  situacao     TEXT NOT NULL DEFAULT 'aberta'
               CHECK (situacao IN ('aberta', 'cancelada')),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  alterado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_notas_cliente ON notas(cliente_id, emitida_em DESC);

-- --------------------------------------------------------------------------
--  QUAIS LOTES ESTÃO EM QUAL NOTA
--
--  `lote_id` é ÚNICO, e é essa restrição que carrega a regra de negócio: um
--  lote entra em UMA nota. Sem ela, o mesmo serviço poderia ser cobrado duas
--  vezes — e a segunda cobrança pareceria tão legítima quanto a primeira.
--
--  A tabela é de ligação, e não uma coluna `nota_id` em `lotes`, porque a
--  chave estrangeira na direção certa é o que permite apagar a nota sem tocar
--  no lote: `ON DELETE CASCADE` aqui desfaz o vínculo, não o trabalho.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nota_lotes (
  nota_id  BIGINT NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
  lote_id  BIGINT NOT NULL REFERENCES lotes(id) ON DELETE CASCADE UNIQUE,
  PRIMARY KEY (nota_id, lote_id)
);
CREATE INDEX IF NOT EXISTS ix_nota_lotes_nota ON nota_lotes(nota_id);

-- --------------------------------------------------------------------------
--  LANÇAMENTOS — o caixa
--
--  Uma linha por movimento de dinheiro. `tipo` diz a direção, `categoria` diz
--  o motivo, e `nota_id` liga ao cliente quando o movimento é dele.
--
--    entrada + recebimento  → o cliente pagou (tem nota)
--    saida   + devolucao    → estorno ao cliente (tem nota)
--    entrada + outra        → dinheiro que entrou sem nota
--    saida   + despesa      → linha, energia, aluguel, salário (sem nota)
--
--  O VALOR É SEMPRE POSITIVO. O sinal vem de `tipo`, nunca do número. Valor
--  negativo num livro-caixa é a porta pela qual uma despesa vira receita por
--  engano de digitação, e a soma do mês fecha sem ninguém notar.
--
--  NÃO SE APAGA LANÇAMENTO. `cancelado_em` marca; a linha fica. Um recibo já
--  entregue ao cliente precisa continuar tendo lastro no sistema, e um caixa
--  em que se pode apagar linha é um caixa que não serve de prova de nada.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lancamentos (
  id            BIGSERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  categoria     TEXT NOT NULL DEFAULT 'outra',
  nota_id       BIGINT REFERENCES notas(id) ON DELETE RESTRICT,
  cliente_id    BIGINT REFERENCES clientes(id) ON DELETE RESTRICT,
  valor         NUMERIC(14,2) NOT NULL CHECK (valor > 0),
  forma         TEXT NOT NULL DEFAULT 'pix',
  ocorrido_em   DATE NOT NULL DEFAULT CURRENT_DATE,
  descricao     TEXT NOT NULL DEFAULT '',
  -- Código do recibo, gerado só quando o movimento é de uma nota. É o número
  -- que o cliente tem no papel e usa para perguntar depois.
  recibo        TEXT UNIQUE,
  criado_por    BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelado_em  TIMESTAMPTZ,
  cancelado_por BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_cancelamento TEXT NOT NULL DEFAULT '',

  -- Movimento de nota tem de ter nota; despesa da fábrica não pode ter.
  -- A trava vive no banco porque a tela não é o único caminho até esta tabela.
  CONSTRAINT ck_lanc_nota_coerente CHECK (
    (categoria IN ('recebimento', 'devolucao') AND nota_id IS NOT NULL) OR
    (categoria NOT IN ('recebimento', 'devolucao') AND nota_id IS NULL)
  ),
  -- Recebimento entra, devolução sai. Trocado, o saldo da nota anda para o
  -- lado errado e o cliente é cobrado do que já devolveram a ele.
  CONSTRAINT ck_lanc_direcao CHECK (
    (categoria = 'recebimento' AND tipo = 'entrada') OR
    (categoria = 'devolucao'   AND tipo = 'saida')   OR
    (categoria NOT IN ('recebimento', 'devolucao'))
  )
);
CREATE INDEX IF NOT EXISTS ix_lanc_nota ON lancamentos(nota_id) WHERE nota_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lanc_data ON lancamentos(ocorrido_em DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_lanc_vivos ON lancamentos(ocorrido_em DESC)
  WHERE cancelado_em IS NULL;

-- --------------------------------------------------------------------------
--  CATEGORIAS DE DESPESA — cadastráveis, não fixas no código
--
--  A fábrica gasta com o que a fábrica gasta, e isso muda. Uma lista fixa no
--  código obriga a me chamar para acrescentar "manutenção de máquina".
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias_despesa (
  id     BIGSERIAL PRIMARY KEY,
  nome   TEXT NOT NULL UNIQUE,
  ativo  BOOLEAN NOT NULL DEFAULT TRUE,
  ordem  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO categorias_despesa (nome, ordem) VALUES
  ('Linha e material', 10), ('Energia', 20), ('Aluguel', 30),
  ('Salários', 40), ('Manutenção de máquina', 50), ('Impostos', 60),
  ('Transporte', 70), ('Outras', 99)
ON CONFLICT (nome) DO NOTHING;

-- --------------------------------------------------------------------------
--  O QUE JÁ ESTAVA MARCADO COMO PAGO
--
--  `lotes.pago_em` existe desde a versão 06 e alguns lotes já o têm
--  preenchido. Apagar a coluna perderia essa informação; deixá-la viva ao lado
--  do novo modelo criaria dois lugares dizendo se o lote foi pago — e eles
--  divergiriam no primeiro pagamento parcial.
--
--  A coluna FICA, como registro histórico, e o comentário diz que ela não
--  manda mais. A migração dos valores para o novo modelo não é feita aqui, de
--  propósito: ela precisa saber a QUE NOTA cada lote pertence, e essa decisão
--  é do escritório, não de um script. A tela de Financeiro mostra os lotes com
--  `pago_em` antigo e sem nota, para que sejam agrupados à mão uma vez.
-- --------------------------------------------------------------------------
COMMENT ON COLUMN lotes.pago_em IS
  'HISTÓRICO. Marcação antiga de pagamento, anterior ao financeiro por nota. '
  'Quem manda agora são as tabelas notas e lancamentos. Não escrever mais aqui.';
