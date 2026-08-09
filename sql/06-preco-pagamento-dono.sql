-- ==========================================================================
--  06 — preço do desenho, valor da ficha, lote pago e a conta de dono.
--
--      node sql/rodar.cjs 06-preco-pagamento-dono.sql
--
--  Roda quantas vezes quiser.
--
--  Quatro assuntos num arquivo só porque são a mesma mudança vista de ângulos
--  diferentes: o sistema deixa de contar apenas PONTO e passa a contar
--  DINHEIRO. Ponto é produção; dinheiro é o que vira nota, o que entra na
--  conta e o que nem todo mundo pode ver.
-- ==========================================================================

-- ------------------------------------------------------------------------
--  PREÇO — propriedade do DESENHO, igual à pontuação
--
--  Mesma razão que pôs a pontuação aqui e não na ficha: "RECIFE1 custa X" é
--  verdade para qualquer peça e qualquer operador. Digitado a cada ficha,
--  vira um preço por operador e a nota do mês sai com três valores para o
--  mesmo bordado.
--
--  NULO É DIFERENTE DE ZERO, e a diferença importa: nulo é "ainda não
--  precificado" — o desenho que o operador acabou de cadastrar na correria
--  do turno; zero seria "de graça". Sem essa distinção não há como o
--  administrador achar o que falta precificar, e o preço em branco viraria
--  R$ 0,00 em silêncio dentro de um lote faturado.
-- ------------------------------------------------------------------------
ALTER TABLE desenhos ADD COLUMN IF NOT EXISTS preco NUMERIC(12,2)
  CHECK (preco IS NULL OR preco >= 0);

COMMENT ON COLUMN desenhos.preco IS
  'Preço por peça. NULO = ainda não precificado (é o que o admin procura). Nunca sai para operador.';

-- Achar rápido o que falta precificar. Índice PARCIAL: só as linhas nulas
-- entram nele, e são justamente as que a tela do administrador procura.
CREATE INDEX IF NOT EXISTS ix_desenhos_sem_preco ON desenhos (nome) WHERE preco IS NULL;

-- ------------------------------------------------------------------------
--  VALOR DA FICHA — retrato, não consulta
--
--  `preco_unitario` é COPIADO do desenho na abertura da ficha, exatamente
--  como a `pontuacao` já era. O motivo é o mesmo e vale ainda mais aqui:
--  corrigir o preço de um desenho hoje NÃO PODE mudar o valor de fichas que
--  já viraram nota no mês passado. Um join na hora de mostrar faria o
--  histórico financeiro se reescrever sozinho a cada reajuste.
--
--  `total_valor` é GERADO pelo banco. Não existe caminho — nem por SQL
--  direto — para gravar um total que não fecha com quantidade × preço. É a
--  mesma trava que `total_pontos` já tem, e pela mesma razão: soma à mão é
--  onde o erro entra.
-- ------------------------------------------------------------------------
ALTER TABLE fichas ADD COLUMN IF NOT EXISTS preco_unitario NUMERIC(12,2)
  CHECK (preco_unitario IS NULL OR preco_unitario >= 0);

ALTER TABLE fichas ADD COLUMN IF NOT EXISTS total_valor NUMERIC(14,2)
  GENERATED ALWAYS AS (COALESCE(quantidade, 0)::numeric * COALESCE(preco_unitario, 0)) STORED;

-- ------------------------------------------------------------------------
--  A HORA CORRIGIDA NÃO PODE FICAR AO CONTRÁRIO
--
--  O administrador passa a poder mexer em `aberta_em` e `fechada_em` — é o
--  conserto do operador que esqueceu de fechar a ficha e fechou às 18h o que
--  terminou às 14h. Mexer nisso à mão abre uma porta que não existia: fim
--  ANTES do início.
--
--  Sem esta trava o estrago é silencioso. A ficha continua somando peça e
--  ponto normalmente; o que quebra é o tempo por peça — que fica negativo,
--  entra na média do dia e derruba o indicador do operador sem que nada na
--  tela pareça errado.
-- ------------------------------------------------------------------------
ALTER TABLE fichas DROP CONSTRAINT IF EXISTS ck_ficha_ordem_do_tempo;
ALTER TABLE fichas ADD CONSTRAINT ck_ficha_ordem_do_tempo CHECK (
  fechada_em IS NULL OR aberta_em IS NULL OR fechada_em >= aberta_em
);

-- ------------------------------------------------------------------------
--  LOTE PAGO — um fato NOVO, não um quarto estado
--
--  A tentação é acrescentar 'pago' ao lado de 'faturado' em `situacao`. Seria
--  errado: nota emitida e dinheiro recebido são dois fatos que convivem. Um
--  lote faturado e não pago é a situação mais comum que existe — é o que se
--  cobra. Com um estado só, marcar "pago" APAGARIA o "faturado", e a pergunta
--  "o que já foi faturado e ainda não entrou?" — que é a razão de existir da
--  integração financeira — deixaria de ter resposta.
--
--  Data, e não booleano, porque a pergunta seguinte é sempre "quando".
-- ------------------------------------------------------------------------
ALTER TABLE lotes ADD COLUMN IF NOT EXISTS pago_em DATE;

COMMENT ON COLUMN lotes.pago_em IS
  'Quando o dinheiro entrou. Independe de situacao=faturado: faturado e não pago é o normal.';

-- A consulta do financeiro é "faturado e ainda não pago". Índice parcial de
-- novo: só as linhas que interessam à cobrança entram nele.
CREATE INDEX IF NOT EXISTS ix_lotes_a_receber
  ON lotes (cliente_id, criado_em DESC) WHERE pago_em IS NULL;

-- ------------------------------------------------------------------------
--  A CONTA DE DONO
--
--  Um papel acima de `admin`, para manutenção do sistema. Ela não aparece na
--  lista de usuários e não é criada, editada, promovida, desativada nem
--  apagada por nenhuma tela — só pelo terminal do servidor.
--
--  Por que um PAPEL e não uma marca (`is_dono BOOLEAN`) num admin: porque as
--  telas decidem o que mostrar pelo papel, e um admin marcado continuaria
--  aparecendo em toda consulta que filtra por `papel = 'admin'` — inclusive
--  na lista que ele precisa não estar. Papel próprio faz o esconder ser a
--  regra, e não uma exceção que alguém esquece de repetir na próxima consulta.
--
--  ATENÇÃO ao ler o código: TODA verificação de permissão passou a ser
--  `ehAdmin(sessao)`, e não `papel === 'admin'`. Uma comparação literal que
--  sobrevivesse em algum canto TRANCARIA O DONO PARA FORA justamente da tela
--  que ele foi criado para consertar.
-- ------------------------------------------------------------------------
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_papel_check;
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ck_usuarios_papel;
ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_papel
  CHECK (papel IN ('dono', 'admin', 'operador'));

-- SÓ UMA CONTA DE DONO. A garantia é do BANCO, não da aplicação: a checagem
-- em JavaScript perde para duas execuções do `criar-usuario.cjs` ao mesmo
-- tempo, e "duas contas com poder sobre tudo, uma delas esquecida" é o
-- oposto do que esta conta existe para ser.
--
-- Índice único sobre a própria coluna, restrito às linhas de dono: como todas
-- valem 'dono', a unicidade da coluna significa uma linha só.
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_um_dono
  ON usuarios (papel) WHERE papel = 'dono';

\echo '  06 aplicado: preço, valor da ficha, lote pago e a conta de dono'
