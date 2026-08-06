-- ==========================================================================
--  02 — esquema do /restrito da Borda Tudo. Roda como o papel `bordatudo`:
--
--      psql -U bordatudo -d bordatudo_producao -f sql/02-esquema.sql
--
--  Idempotente: rodar de novo não apaga nem duplica nada.
--
--  O QUE NÃO ESTÁ AQUI: textos do site, serviços, vitrine e dúvidas. Isso
--  continua no SQLite (data/site.db), junto do publish. Os dois bancos convivem
--  no mesmo processo sem se falarem — e é isso que faz o SITE continuar no ar
--  quando o PostgreSQL cai.
--
--  ------------------------------------------------------------------
--  O DOMÍNIO, EM UMA PASSADA
--
--  Bordado se mede em PONTO. Cada DESENHO tem uma pontuação fixa — quantos
--  pontos a máquina dá para bordar aquele desenho UMA vez. O que se cobra e o
--  que se produz é quantidade × pontuação.
--
--  Hoje o operador anota isso no papel: cliente, desenho, quantidade,
--  pontuação, e some na mão. Depois o Eduardo copia para a folha dele e marca
--  um X no canto para não somar duas vezes. As duas contas são feitas à mão, e
--  o X é o único controle de que a folha já foi lida.
--
--  Este esquema existe para tirar as duas contas da mão e o X do canto:
--    · a pontuação vem do cadastro do desenho, não da memória de quem anota;
--    · o total de pontos é calculado, nunca digitado;
--    · a ficha é lida uma vez só porque tem identidade, não um X a lápis.
--  ==========================================================================

-- --------------------------------------------------------------------------
--  QUEM ENTRA
--
--  `operador` abre e fecha as próprias fichas e não vê o resto.
--  `admin` vê tudo, junta lotes e mexe nos cadastros.
--
--  A separação não é hierarquia: é que a tela do operador precisa ser rápida e
--  ter poucos botões. Quem está na máquina não quer navegar num sistema.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id         BIGSERIAL PRIMARY KEY,
  usuario    TEXT NOT NULL UNIQUE,
  nome       TEXT NOT NULL DEFAULT '',
  senha_hash TEXT NOT NULL,
  papel      TEXT NOT NULL DEFAULT 'operador'
             CHECK (papel IN ('admin', 'operador')),
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
--  CADASTROS
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id        BIGSERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  telefone  TEXT NOT NULL DEFAULT '',
  observacao TEXT NOT NULL DEFAULT '',
  ativo     BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- `lower(nome)` no índice: sem isso "Marcela" e "marcela" viram dois clientes,
-- e o relatório do mês mostra a mesma pessoa em duas linhas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_nome ON clientes (lower(nome));

-- --------------------------------------------------------------------------
--  DESENHOS — o coração do cadastro
--
--  A `pontuacao` é quantos pontos a máquina dá para bordar o desenho UMA vez.
--  Está aqui, e não na ficha, porque é propriedade do desenho: "RECIFE1 tem
--  9484 pontos" é verdade hoje e amanhã, para qualquer peça e qualquer
--  operador.
--
--  É o campo que mais evita erro. Digitado a cada ficha, "9484" vira "9848" e
--  ninguém confere — o número não tem como parecer errado.
--
--  O desenho pertence a um cliente porque na prática é assim: a arte é dele.
--  `cliente_id` aceita NULO para o desenho genérico, que qualquer um usa.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS desenhos (
  id         BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
  nome       TEXT NOT NULL,
  pontuacao  INTEGER NOT NULL CHECK (pontuacao > 0),
  observacao TEXT NOT NULL DEFAULT '',
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_desenhos_cliente ON desenhos (cliente_id, nome);
-- Mesmo nome para o mesmo cliente é o mesmo desenho. Clientes diferentes podem
-- ter desenhos de mesmo nome (todo mundo tem um "LOGO").
CREATE UNIQUE INDEX IF NOT EXISTS ux_desenhos_cliente_nome
  ON desenhos (COALESCE(cliente_id, 0), lower(nome));

-- Mercadoria: camisa, calça, bolso, jaleco, manga, aba… Lista cadastrada para
-- o operador ESCOLHER. Campo livre viraria "camisa", "camiseta" e "Camisa" —
-- e o relatório por produto deixa de existir.
CREATE TABLE IF NOT EXISTS mercadorias (
  id        BIGSERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  ativo     BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mercadorias_nome ON mercadorias (lower(nome));

-- Cor/variação. Campo próprio, e não texto solto na observação, porque é por
-- ela que se fecha a conta: 1500 abas = 100 pretas + 500 brancas + 300 bege +
-- 200 marrom + 300 cinzas. Sem a cor separada não dá para saber o que falta.
CREATE TABLE IF NOT EXISTS cores (
  id        BIGSERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  ativo     BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cores_nome ON cores (lower(nome));

-- --------------------------------------------------------------------------
--  MÁQUINAS — e o QR colado nelas
--
--  O `token` vai dentro do QR code que fica colado no equipamento. Escanear
--  abre a tela do operador já sabendo em qual máquina ele está.
--
--  O TOKEN IDENTIFICA, NÃO AUTENTICA. Ele está impresso num adesivo à vista de
--  todos: qualquer pessoa que passe pela fábrica fotografa. Tratá-lo como
--  senha seria dar acesso ao sistema a quem tem uma câmera. Quem entra continua
--  sendo o operador, com o login dele — o QR só responde "qual máquina".
--
--  Por isso ele é aleatório mas não é segredo, e trocá-lo (`rodar token`) só
--  serve para invalidar adesivos antigos, não para expulsar ninguém.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maquinas (
  id        BIGSERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  cabecas   SMALLINT NOT NULL DEFAULT 1,   -- quantas cabeças a máquina tem
  ativo     BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_maquinas_nome ON maquinas (lower(nome));

-- --------------------------------------------------------------------------
--  JORNADA — o "INÍCIO DE PRODUÇÃO"
--
--  Separada da ficha de propósito. A ficha responde "o que foi bordado"; a
--  jornada responde "quem esteve aqui e por quanto tempo". A folha de papel
--  tem um campo "Horas Extras" no alto justamente porque as duas perguntas
--  existem e são diferentes.
--
--  Uma jornada aberta por operador por vez. `fim` nulo é jornada em aberto —
--  e é o que a tela usa para saber se mostra "Iniciar produção" ou "Encerrar".
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jornadas (
  id          BIGSERIAL PRIMARY KEY,
  usuario_id  BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  inicio      TIMESTAMPTZ NOT NULL DEFAULT now(),
  fim         TIMESTAMPTZ,
  observacao  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_jornadas_usuario ON jornadas (usuario_id, inicio DESC);
-- Uma aberta por operador. O índice PARCIAL é o que garante isso no banco: sem
-- ele, dois cliques no botão criariam duas jornadas e as horas do dia sairiam
-- dobradas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_jornada_aberta
  ON jornadas (usuario_id) WHERE fim IS NULL;

-- --------------------------------------------------------------------------
--  FICHA — o registro de produção
--
--  Nasce ABERTA (cliente + desenho + máquina) e é fechada com a quantidade.
--  A hora de início e a de fim são do RELÓGIO, não digitadas: é o que faz o
--  tempo por peça ser um dado e não uma lembrança.
--
--  `pontuacao` é COPIADA do desenho na abertura, não lida por join na hora de
--  mostrar. Parece redundância e não é: se amanhã alguém corrigir a pontuação
--  do desenho, as fichas de ontem têm de continuar contando o que contaram —
--  senão o relatório do mês passado muda sozinho, depois de a nota ter sido
--  emitida.
--
--  `total_pontos` é coluna GERADA: quantidade × pontuação, calculada pelo
--  banco. Não existe caminho para alguém gravar um total que não fecha com as
--  duas parcelas — que é exatamente o erro que a soma à mão produz.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fichas (
  id            BIGSERIAL PRIMARY KEY,
  usuario_id    BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  jornada_id    BIGINT REFERENCES jornadas(id) ON DELETE SET NULL,
  maquina_id    BIGINT REFERENCES maquinas(id) ON DELETE SET NULL,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  desenho_id    BIGINT NOT NULL REFERENCES desenhos(id) ON DELETE RESTRICT,

  pontuacao     INTEGER NOT NULL CHECK (pontuacao > 0),   -- retrato do desenho
  quantidade    INTEGER CHECK (quantidade IS NULL OR quantidade > 0),
  total_pontos  BIGINT GENERATED ALWAYS AS (COALESCE(quantidade, 0)::bigint * pontuacao) STORED,

  mercadoria_id BIGINT REFERENCES mercadorias(id) ON DELETE SET NULL,
  cor_id        BIGINT REFERENCES cores(id) ON DELETE SET NULL,
  observacao    TEXT NOT NULL DEFAULT '',

  aberta_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  fechada_em    TIMESTAMPTZ,
  situacao      TEXT NOT NULL DEFAULT 'aberta'
                CHECK (situacao IN ('aberta', 'fechada', 'cancelada')),

  lote_id       BIGINT,   -- preenchido pelo administrativo na amálgama
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_fichas_usuario  ON fichas (usuario_id, aberta_em DESC);
CREATE INDEX IF NOT EXISTS ix_fichas_cliente  ON fichas (cliente_id, aberta_em DESC);
CREATE INDEX IF NOT EXISTS ix_fichas_lote     ON fichas (lote_id);
CREATE INDEX IF NOT EXISTS ix_fichas_situacao ON fichas (situacao, aberta_em DESC);

-- Uma ficha aberta por operador. Mesmo motivo da jornada: sem isto, abrir a
-- ficha duas vezes sem fechar deixa duas em aberto e o operador fecha a errada.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ficha_aberta
  ON fichas (usuario_id) WHERE situacao = 'aberta';

-- Ficha fechada TEM de ter quantidade e hora de fim. Sem esta trava, um fechar
-- que falhasse no meio deixaria a ficha "fechada" valendo zero peça — e ela
-- sairia do painel de pendências sem nunca ter sido contada.
ALTER TABLE fichas DROP CONSTRAINT IF EXISTS ck_ficha_fechada;
ALTER TABLE fichas ADD CONSTRAINT ck_ficha_fechada CHECK (
  situacao <> 'fechada' OR (quantidade IS NOT NULL AND fechada_em IS NOT NULL)
);

-- --------------------------------------------------------------------------
--  LOTE — a amálgama
--
--  É o corte do cliente: "1500 abas". As fichas dos vários operadores são
--  penduradas nele pelo administrativo, e aí se sabe quanto já saiu e quanto
--  falta — inclusive por cor.
--
--  `quantidade_prevista` é o que o cliente mandou. Fica NULO enquanto ninguém
--  souber: é comum o corte chegar e a contagem vir depois. Nulo significa "não
--  sei", e é diferente de zero.
--
--  O lote NÃO guarda soma. O total sai das fichas, sempre. Guardar um total no
--  lote criaria duas verdades, e a que estivesse errada seria justamente a que
--  alguém leria na hora de fazer a nota.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lotes (
  id                  BIGSERIAL PRIMARY KEY,
  cliente_id          BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  codigo              TEXT NOT NULL UNIQUE,          -- LOTE-2026-0001
  descricao           TEXT NOT NULL DEFAULT '',      -- "1500 abas"
  quantidade_prevista INTEGER CHECK (quantidade_prevista IS NULL OR quantidade_prevista > 0),
  entrada_em          DATE,
  situacao            TEXT NOT NULL DEFAULT 'aberto'
                      CHECK (situacao IN ('aberto', 'fechado', 'faturado')),
  nota                TEXT NOT NULL DEFAULT '',      -- número da nota, quando emitida
  observacao          TEXT NOT NULL DEFAULT '',
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  alterado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_lotes_cliente ON lotes (cliente_id, criado_em DESC);

-- A chave estrangeira da ficha para o lote só pode ser criada agora, porque
-- `fichas` nasce antes de `lotes` no arquivo.
ALTER TABLE fichas DROP CONSTRAINT IF EXISTS fk_fichas_lote;
ALTER TABLE fichas ADD CONSTRAINT fk_fichas_lote
  FOREIGN KEY (lote_id) REFERENCES lotes(id) ON DELETE SET NULL;

-- `alterado_em` mantido pelo BANCO, não pela aplicação: toda tela que grava
-- teria de lembrar de atualizar, e a que esquecesse deixaria o campo mentindo.
CREATE OR REPLACE FUNCTION toca_alterado_em() RETURNS TRIGGER AS $$
BEGIN NEW.alterado_em = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_lotes_alterado ON lotes;
CREATE TRIGGER tg_lotes_alterado BEFORE UPDATE ON lotes
  FOR EACH ROW EXECUTE FUNCTION toca_alterado_em();

\echo '  esquema aplicado'
