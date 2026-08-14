-- ==========================================================================
--  08 — somar fichas de um lote numa só
--
--  Roda como o papel `bordatudo`:
--      npm run banco:esquema     (ou psql -f sql/08-somar-fichas.sql)
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  A SITUAÇÃO 'somada' — por que não apagar a ficha absorvida
--
--  O caminho fácil seria DELETE nas fichas que entraram na soma. Ele é
--  irreversível, e este sistema imprime documento que o cliente assina e que
--  vira nota fiscal. Três coisas quebram com o DELETE:
--
--    1. um recibo JÁ IMPRESSO deixa de poder ser conferido contra o sistema;
--    2. um clique errado não tem volta;
--    3. a produção do operador — quantas peças ele fez naquele dia — some do
--       histórico dele, e é por ela que se paga.
--
--  Com uma situação própria, a linha continua existindo e some de TODAS as
--  contas, porque o sistema inteiro soma `WHERE situacao = 'fechada'`. É a
--  mesma ideia de "desativar em vez de apagar" que o resto do projeto já usa.
-- --------------------------------------------------------------------------
ALTER TABLE fichas DROP CONSTRAINT IF EXISTS fichas_situacao_check;
ALTER TABLE fichas ADD CONSTRAINT fichas_situacao_check
  CHECK (situacao IN ('aberta', 'fechada', 'cancelada', 'somada'));

-- --------------------------------------------------------------------------
--  DE ONDE VEIO E PARA ONDE FOI
--
--  `somada_em_id` aponta da ficha absorvida para a ficha que a absorveu.
--  Sem ele, "esta ficha está somada" seria uma informação sem endereço: dá
--  para ver que ela saiu de circulação, e não onde as peças dela foram parar.
--
--  `ON DELETE SET NULL` e não CASCADE: se um dia a ficha somada for apagada,
--  as originais VOLTAM a ficar sem destino em vez de sumirem junto. Numa
--  cadeia de referência, CASCADE é como um apagar se transforma em três.
-- --------------------------------------------------------------------------
ALTER TABLE fichas ADD COLUMN IF NOT EXISTS somada_em_id BIGINT
  REFERENCES fichas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_fichas_somada_em ON fichas(somada_em_id)
  WHERE somada_em_id IS NOT NULL;

-- --------------------------------------------------------------------------
--  OS OPERADORES DA FICHA SOMADA
--
--  `usuario_id` é uma chave estrangeira: aponta para UM operador, e continua
--  apontando (o mais antigo dos que entraram), porque a coluna é NOT NULL e
--  porque toda ficha precisa de um responsável.
--
--  Mas uma ficha somada foi feita por várias pessoas, e o recibo tem de dizer
--  isso. `operadores` guarda os nomes concatenados por vírgula, no momento da
--  soma. É TEXTO CONGELADO de propósito, pelo mesmo motivo que `pontuacao` e
--  `preco_unitario` são cópias: se alguém corrigir o nome de um operador ano
--  que vem, o recibo já assinado não pode mudar.
--
--  Nulo em ficha normal. A tela mostra `operadores` quando existe e o nome do
--  operador quando não — sem um terceiro estado para tratar.
-- --------------------------------------------------------------------------
ALTER TABLE fichas ADD COLUMN IF NOT EXISTS operadores TEXT;

-- --------------------------------------------------------------------------
--  O QUE A SOMA ABSORVEU, EM DETALHE
--
--  JSONB com uma entrada por ficha original: id, operador, peças, pontuação,
--  preço e data. É o que permite reconstruir a conta seis meses depois, quando
--  alguém perguntar "por que esta ficha tem 5.406 pontos por peça se nenhum
--  desenho tem esse número?".
--
--  A resposta é a média ponderada, e sem este registro ela seria indefensável.
-- --------------------------------------------------------------------------
ALTER TABLE fichas ADD COLUMN IF NOT EXISTS soma_de JSONB;

-- --------------------------------------------------------------------------
--  UMA FICHA SOMADA NÃO PODE ESTAR EM LOTE
--
--  Ela saiu de circulação; se continuasse com `lote_id`, apareceria na tela do
--  lote e na contagem de fichas — que é justamente o que a soma veio resolver.
--  A trava vive no banco porque a tela não é o único caminho até esta coluna.
-- --------------------------------------------------------------------------
ALTER TABLE fichas DROP CONSTRAINT IF EXISTS ck_ficha_somada_sem_lote;
ALTER TABLE fichas ADD CONSTRAINT ck_ficha_somada_sem_lote
  CHECK (situacao <> 'somada' OR lote_id IS NULL);
