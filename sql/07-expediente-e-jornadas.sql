-- ==========================================================================
--  07 — expediente do operador e o que a tela de horários precisa.
--
--  Roda como o papel `bordatudo`:
--      npm run banco:esquema     (ou psql -f sql/07-expediente-e-jornadas.sql)
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ==========================================================================

-- --------------------------------------------------------------------------
--  EXPEDIENTE — em UMA coluna JSONB, e não em sete pares de colunas.
--
--  A fábrica tem dois jeitos de combinar hora, e os dois convivem:
--
--    · HORÁRIO FIXO   — "entra 7h30, sai 17h, segunda a sexta". É o do
--                       operador de bancada, que bate ponto.
--    · HORAS POR DIA  — "8 horas na segunda, 4 no sábado", sem dizer quando.
--                       É o de quem tem hora combinada mas entra quando dá.
--
--  Sete pares de colunas (entrada_seg, saida_seg, …) dariam catorze campos que
--  só fazem sentido juntos, e um oitavo dia de semana nunca vai existir. Pior:
--  metade deles ficaria NULA em todo operador do segundo tipo, e "NULO" não
--  distingue "não trabalha nesse dia" de "trabalha sem hora marcada".
--
--  O formato guardado é:
--     {"tipo":"fixo",  "dias":{"1":{"entrada":"07:30","saida":"17:00"}, ...}}
--     {"tipo":"horas", "dias":{"1":{"horas":8}, "6":{"horas":4}}}
--
--  Dia da semana: 0=domingo … 6=sábado, o mesmo do `getDay()` do JavaScript e
--  do `EXTRACT(DOW)` do Postgres. Usar a mesma numeração dos dois lados evita a
--  conversão que sempre erra por um.
--
--  DIA AUSENTE = NÃO TRABALHA. É a diferença que as catorze colunas não sabiam
--  expressar, e é ela que faz o relatório saber que a falta de sábado não é
--  falta.
-- --------------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS expediente JSONB;

-- A trava vive no BANCO porque a tela não é o único caminho: o dia em que
-- alguém corrigir um operador por SQL, o formato continua garantido. Sem ela,
-- um `{"tipo":"fixa"}` com uma letra a mais passaria e a tela de horários
-- calcularia em cima de lixo, sem erro visível.
--  SEM O OPERADOR `?` DO JSONB, de propósito. O natural aqui seria
--  `expediente ? 'tipo'` ("a chave existe"), mas a camada de banco deste
--  projeto traduz `?` em `$1` — ela fala o dialeto de parâmetro do SQLite. O
--  operador do Postgres e o marcador de parâmetro são o mesmo caractere, e o
--  arquivo morria com "erro de sintaxe em ou próximo a $1".
--
--  `->>` devolve NULO quando a chave não existe, então `IN (…)` já cobre as
--  duas coisas: chave ausente e valor inválido.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ck_usuarios_expediente;
ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_expediente CHECK (
  expediente IS NULL OR (
    jsonb_typeof(expediente) = 'object'
    AND expediente ->> 'tipo' IN ('fixo', 'horas')
    AND (expediente -> 'dias' IS NULL OR jsonb_typeof(expediente -> 'dias') = 'object')
  )
);

-- --------------------------------------------------------------------------
--  JORNADAS — o que faltava para a tela de horários ser confiável.
--
--  O FIM NÃO PODE SER ANTES DO INÍCIO. Sem isto, uma correção de hora digitada
--  errada não quebra nada visível: o total daquele dia fica NEGATIVO e some
--  dentro da soma do mês, puxando-a para baixo sem que nenhuma linha pareça
--  errada. É o mesmo raciocínio da `ck_ficha_ordem_do_tempo`.
-- --------------------------------------------------------------------------
ALTER TABLE jornadas DROP CONSTRAINT IF EXISTS ck_jornada_ordem_do_tempo;
ALTER TABLE jornadas ADD CONSTRAINT ck_jornada_ordem_do_tempo
  CHECK (fim IS NULL OR fim >= inicio);

-- O QUE **NÃO** ENTRA AQUI, e por quê:
--
--   · uma jornada aberta por pessoa  → já existe, `ux_jornada_aberta`
--   · busca por usuário e período    → já existe, `ix_jornadas_usuario`
--
-- Eu havia escrito os dois com nomes novos. O Postgres aceitou de bom grado e
-- ficaram DUPLICADOS: mesma coluna, mesma condição, dois nomes. Índice
-- duplicado não dá erro nem resultado errado — só cobra escrita a mais em toda
-- inserção, calado, para sempre. Conferir `pg_indexes` antes de criar custa
-- dez segundos.
