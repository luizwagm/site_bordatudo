-- ==========================================================================
--  10 — a quem foi paga a despesa
--
--  Roda como o papel `bordatudo`:
--      npm run banco:esquema     (ou psql -f sql/10-funcionario-no-lancamento.sql)
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  A COLUNA `funcionario_id` — e por que ela NÃO é `cliente_id` de novo
--
--  `lancamentos` já tem `cliente_id`: é de quem veio o dinheiro. `funcionario_id`
--  é para quem ele foi. São perguntas diferentes e vivem em colunas diferentes,
--  porque no dia em que a fábrica pagar salário a alguém que também é cliente,
--  uma coluna só teria de escolher qual das duas verdades guardar.
--
--  `ON DELETE SET NULL` e não RESTRICT: desligar quem saiu da fábrica não pode
--  travar por causa de um salário pago ano passado, e o lançamento tem de
--  continuar existindo com ou sem o vínculo — ele é dinheiro que saiu do caixa.
-- --------------------------------------------------------------------------
ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS funcionario_id BIGINT
  REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_lanc_funcionario ON lancamentos(funcionario_id, ocorrido_em DESC)
  WHERE funcionario_id IS NOT NULL;

-- --------------------------------------------------------------------------
--  SALÁRIO NÃO É COISA DE NOTA
--
--  Um lançamento com nota é do cliente; um com funcionário é da folha. Ter os
--  dois na mesma linha faria o salário aparecer no extrato que o cliente
--  recebe — e é o tipo de vazamento que ninguém procura porque ninguém imagina.
-- --------------------------------------------------------------------------
ALTER TABLE lancamentos DROP CONSTRAINT IF EXISTS ck_lanc_funcionario_sem_nota;
ALTER TABLE lancamentos ADD CONSTRAINT ck_lanc_funcionario_sem_nota
  CHECK (funcionario_id IS NULL OR nota_id IS NULL);

-- --------------------------------------------------------------------------
--  QUAL CATEGORIA PEDE UM NOME — uma COLUNA, não a palavra "Salários" no código
--
--  O pedido era "quando a categoria for salários, escolher o funcionário".
--  Escrever `if (categoria === 'Salários')` no servidor funcionaria hoje e
--  quebraria no dia em que alguém renomeasse a categoria para "Folha" pela
--  própria tela de cadastro — sem erro nenhum, só o campo que deixa de
--  aparecer. E teria de me chamar para acrescentar "Vale transporte" ou
--  "Adiantamento", que são exatamente o mesmo caso.
--
--  Com a coluna, quem cadastra a categoria decide, e a regra fica onde a
--  categoria mora.
-- --------------------------------------------------------------------------
ALTER TABLE categorias_despesa ADD COLUMN IF NOT EXISTS pede_funcionario BOOLEAN
  NOT NULL DEFAULT FALSE;

UPDATE categorias_despesa SET pede_funcionario = TRUE WHERE nome = 'Salários';
