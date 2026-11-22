-- ============================================================================
-- HISTÓRICO DAS FICHAS (1.28.0)
--
-- Pedido de 19/11/2026: "tem fichas sumindo — é um problema sério". Até aqui o
-- banco não guardava QUEM cancelou, removeu ou tirou uma ficha de um lote, nem
-- QUANDO. Depois que acontecia, não havia como explicar.
--
-- Cada coisa que muda o destino de uma ficha vira uma linha aqui:
--   aberta, fechada, corrigida, cancelada, removida, devolvida (a parcela que
--   volta quando a soma é removida), somada (a parcela absorvida), soma_criada,
--   entrou_no_lote, saiu_do_lote.
--
-- `ficha_id` SEM chave estrangeira, de propósito: a linha mais importante desta
-- tabela é a da ficha REMOVIDA, e uma FK a apagaria junto (CASCADE) ou
-- impediria a remoção (RESTRICT). O retrato da ficha removida vai em `detalhe`.
--
-- `usuario_nome` é TEXTO copiado na hora, e não só o id: o nome de quem fez
-- tem de continuar legível mesmo que a conta seja renomeada ou desativada.
-- Quando o administrador está usando a conta de outra pessoa, o nome diz os
-- dois ("Ana (na conta de João)") — o histórico não pode culpar o operador
-- pelo que o administrador fez na conta dele.
-- ============================================================================
CREATE TABLE IF NOT EXISTS fichas_historico (
  id            BIGSERIAL PRIMARY KEY,
  ficha_id      BIGINT NOT NULL,
  acao          TEXT NOT NULL,
  detalhe       JSONB NOT NULL DEFAULT '{}'::jsonb,
  usuario_id    BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome  TEXT NOT NULL DEFAULT '',
  em            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_hist_ficha ON fichas_historico (ficha_id, em);
CREATE INDEX IF NOT EXISTS ix_hist_em    ON fichas_historico (em DESC);
CREATE INDEX IF NOT EXISTS ix_hist_acao  ON fichas_historico (acao, em DESC);
