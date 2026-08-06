-- ==========================================================================
--  04 — clientes com dados de nota, cor com o tom de verdade, e fotos do
--       desenho.
--
--      node sql/rodar.cjs 04-cadastros.sql
--
--  Roda quantas vezes quiser: tudo aqui é IF NOT EXISTS ou DROP antes de
--  criar. Migração que só funciona uma vez é migração que ninguém tem coragem
--  de rodar no servidor.
-- ==========================================================================

-- ---------------------------------------------------------------- clientes --
-- O fluxo do sistema termina em EMITIR A NOTA, e a nota precisa do documento.
-- Sem estes campos, na hora de faturar alguém teria de sair procurando o CNPJ
-- em outro lugar — que é exatamente o tipo de ida e volta que o sistema existe
-- para acabar.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS documento TEXT NOT NULL DEFAULT '';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email     TEXT NOT NULL DEFAULT '';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cidade    TEXT NOT NULL DEFAULT '';

-- Busca por nome sem diferenciar maiúscula. Sem o índice, a lista paginada
-- varre a tabela inteira a cada tecla digitada.
CREATE INDEX IF NOT EXISTS ix_clientes_nome ON clientes (lower(nome));

-- ------------------------------------------------------------------- cores --
-- A cor ganha o TOM. "Bege" escrito não distingue dois beges diferentes na
-- mesma remessa; a bolinha na tela distingue.
ALTER TABLE cores ADD COLUMN IF NOT EXISTS hex TEXT NOT NULL DEFAULT '';

-- Vazio continua valendo: cor cadastrada antes disto não pode virar inválida
-- de uma hora para outra só porque a coluna nasceu depois dela.
ALTER TABLE cores DROP CONSTRAINT IF EXISTS ck_cores_hex;
ALTER TABLE cores ADD CONSTRAINT ck_cores_hex
  CHECK (hex = '' OR hex ~ '^#[0-9a-f]{6}$');

-- ---------------------------------------------------------------- desenhos --
CREATE INDEX IF NOT EXISTS ix_desenhos_nome ON desenhos (lower(nome));

-- Foto do desenho: TABELA PRÓPRIA, não coluna.
-- Uma coluna `foto` obrigaria a escolher uma; uma coluna com lista dentro
-- (JSON, texto separado por vírgula) tornaria impossível apagar UMA foto sem
-- reescrever as outras — e é aí que se perde a errada.
CREATE TABLE IF NOT EXISTS desenho_fotos (
  id         BIGSERIAL PRIMARY KEY,
  desenho_id BIGINT NOT NULL REFERENCES desenhos(id) ON DELETE CASCADE,
  arquivo    TEXT NOT NULL,                 -- nome dentro de data/desenhos/
  legenda    TEXT NOT NULL DEFAULT '',
  ordem      SMALLINT NOT NULL DEFAULT 0,   -- a primeira é a que aparece na lista
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CASCADE aqui e RESTRICT nas fichas: o desenho quase nunca é apagado (é
-- desativado), mas se um dia for, uma linha de foto órfã apontaria para um
-- arquivo que ninguém mais sabe de quem é.
CREATE INDEX IF NOT EXISTS ix_desenho_fotos ON desenho_fotos (desenho_id, ordem, id);

\echo '  04 aplicado: clientes com documento, cores com tom, fotos de desenho'
