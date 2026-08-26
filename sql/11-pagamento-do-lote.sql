-- ============================================================================
--  O PAGAMENTO DO LOTE VEM DA NOTA
--
--  O caixa já sabia quem pagou o quê: a nota junta lotes e vai sendo quitada
--  pelos lançamentos. Mas a TELA DO LOTE continuava lendo `lotes.pago_em` — a
--  marcação manual, anterior ao financeiro. Resultado: registrar o
--  recebimento no financeiro deixava o lote dizendo "a receber", e a cobrança
--  ia atrás de dinheiro que já tinha entrado.
--
--  A saída NÃO é copiar a data da nota para o lote. O comentário do arquivo
--  09 já dizia por quê: dois lugares guardando o mesmo fato divergem no
--  primeiro estorno — a nota desquita e o carimbo do lote fica mentindo, com
--  a aparência de verdade.
--
--  Aqui o pagamento do lote é DERIVADO. Uma consulta só, que todas as telas
--  usam, e que responde três coisas diferentes que antes se confundiam:
--
--    · a nota deste lote (se houver) e o saldo dela;
--    · se ele está PAGO — a nota quitou, ou alguém marcou à mão antes do
--      financeiro existir;
--    · DE ONDE vem essa resposta ('nota' ou 'manual'), porque quem confere
--      precisa saber onde mexer para corrigir.
--
--  Pagamento PARCIAL não deixa lote nenhum pago. A nota é do cliente, não da
--  peça: com três lotes e metade do valor recebido, não há como dizer qual
--  metade foi paga — e escolher uma no chute faria a cobrança perdoar um lote
--  que ninguém quitou.
--
--  `lotes.pago_em` continua existindo e continua valendo para os lotes
--  antigos, que nunca entraram numa nota. Apagá-lo perderia o histórico; é o
--  que a versão 09 já tinha decidido.
-- ============================================================================

CREATE OR REPLACE VIEW lote_pagamento AS
WITH valor_do_lote AS (
  SELECT l.id AS lote_id,
         COALESCE((SELECT SUM(f.total_valor) FROM fichas f
                    WHERE f.lote_id = l.id AND f.situacao = 'fechada'), 0) AS valor
    FROM lotes l
),
conta_da_nota AS (
  SELECT n.id AS nota_id,
         n.codigo,
         n.situacao,
         n.vencimento,
         -- o MESMO cálculo do servidor: soma dos lotes, menos desconto, mais
         -- acréscimo. Divergir daqui faria a tela do lote e a do financeiro
         -- discordarem sobre a mesma nota.
         COALESCE((SELECT SUM(v.valor) FROM nota_lotes nl
                     JOIN valor_do_lote v ON v.lote_id = nl.lote_id
                    WHERE nl.nota_id = n.id), 0)
           - n.desconto + n.acrescimo AS valor,
         -- entradas menos... NÃO: devolução AUMENTA o que falta (o dinheiro
         -- voltou ao cliente). Somar aqui é o erro que faz a nota parecer
         -- quitada depois de um estorno.
         COALESCE((SELECT SUM(la.valor) FROM lancamentos la
                    WHERE la.nota_id = n.id AND la.tipo = 'entrada'
                      AND la.cancelado_em IS NULL), 0) AS pago,
         COALESCE((SELECT SUM(la.valor) FROM lancamentos la
                    WHERE la.nota_id = n.id AND la.tipo = 'saida'
                      AND la.cancelado_em IS NULL), 0) AS devolvido,
         -- a data do último recebimento que entrou: é ela que vira "pago em".
         (SELECT MAX(la.ocorrido_em) FROM lancamentos la
           WHERE la.nota_id = n.id AND la.tipo = 'entrada'
             AND la.cancelado_em IS NULL) AS ultimo_recebimento
    FROM notas n
)
SELECT l.id                                   AS lote_id,
       c.nota_id,
       c.codigo                               AS nota_codigo,
       c.situacao                             AS nota_situacao,
       c.vencimento                           AS nota_vencimento,
       c.valor                                AS nota_valor,
       c.pago                                 AS nota_pago,
       c.devolvido                            AS nota_devolvido,
       ROUND(c.valor - c.pago + c.devolvido, 2) AS nota_saldo,
       -- nota cancelada não quita nada: ela deixou de ser cobrança.
       (c.nota_id IS NOT NULL AND c.situacao <> 'cancelada'
        AND ROUND(c.valor - c.pago + c.devolvido, 2) <= 0.004) AS nota_quitada,
       CASE
         WHEN c.nota_id IS NOT NULL AND c.situacao <> 'cancelada'
              AND ROUND(c.valor - c.pago + c.devolvido, 2) <= 0.004 THEN TRUE
         -- a marcação manual só responde por quem NÃO está em nota: dentro de
         -- uma nota, quem manda é o caixa.
         WHEN c.nota_id IS NULL AND l.pago_em IS NOT NULL THEN TRUE
         ELSE FALSE
       END AS pago,
       CASE
         WHEN c.nota_id IS NOT NULL AND c.situacao <> 'cancelada'
              AND ROUND(c.valor - c.pago + c.devolvido, 2) <= 0.004
           THEN COALESCE(c.ultimo_recebimento, l.pago_em)
         WHEN c.nota_id IS NULL THEN l.pago_em
         ELSE NULL
       END AS pago_em,
       CASE
         WHEN c.nota_id IS NOT NULL AND c.situacao <> 'cancelada'
              AND ROUND(c.valor - c.pago + c.devolvido, 2) <= 0.004 THEN 'nota'
         WHEN c.nota_id IS NULL AND l.pago_em IS NOT NULL THEN 'manual'
         ELSE NULL
       END AS origem
  FROM lotes l
  LEFT JOIN nota_lotes nl ON nl.lote_id = l.id
  LEFT JOIN conta_da_nota c ON c.nota_id = nl.nota_id;

COMMENT ON VIEW lote_pagamento IS
  'Pagamento do lote DERIVADO da nota (fonte viva) com queda para lotes.pago_em '
  'nos lotes que nunca entraram em nota. Nunca guarde este resultado: dois '
  'lugares com o mesmo fato divergem no primeiro estorno.';
