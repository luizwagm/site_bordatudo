-- ============================================================================
--  12 — PAGAMENTO DO CLIENTE: um dinheiro, várias notas
--
--  Roda como o papel `bordatudo` (o deploy roda todos os sql/NN-*.sql em
--  ordem). Idempotente.
--
--  O PEDIDO: o cliente paga "por conta" — R$ 400 em dinheiro, depois R$ 200 no
--  PIX — e o escritório não quer abrir nota por nota calculando quanto vai em
--  cada uma. O sistema distribui da nota mais antiga para a mais nova.
--
--  O DESENHO: o pagamento continua virando lançamentos POR NOTA — a trava
--  `ck_lanc_nota_coerente` (sql/09) exige nota em todo recebimento, e é por
--  nota que o saldo é calculado. Os pedaços de um mesmo dinheiro ficam ligados
--  pelo GRUPO (PG-2026-0001): é ele que vira UM recibo para o cliente, dizendo
--  "recebemos R$ 200,00 — R$ 164,20 na nota A, R$ 35,80 na nota B".
--
--  Sem o grupo, quem pagou R$ 200 sairia com dois papéis de R$ 164,20 e
--  R$ 35,80 — números que ele não reconhece, porque não foi isso que pagou.
--
--  Lançamento avulso (pago direto na nota) continua com grupo NULL.
-- ============================================================================

ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS grupo TEXT;

CREATE INDEX IF NOT EXISTS ix_lanc_grupo ON lancamentos(grupo) WHERE grupo IS NOT NULL;

COMMENT ON COLUMN lancamentos.grupo IS
  'PG-AAAA-NNNN: os lançamentos de UM pagamento do cliente distribuído entre '
  'notas (da mais antiga para a mais nova). NULL = lançamento feito na nota.';
