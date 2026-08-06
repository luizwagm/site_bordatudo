-- ==========================================================================
--  05 — senha provisória: a primeira senha é de uso único.
--
--      node sql/rodar.cjs 05-senha-provisoria.sql
--
--  A senha que o sistema gera para alguém entrar pela primeira vez é curta e
--  fácil de ditar por telefone — e passa pelas mãos de quem cadastrou. Ela
--  serve para ABRIR A PORTA UMA VEZ, não para ser a senha da pessoa.
--
--  A coluna abaixo é o que transforma essa intenção em regra: enquanto ela for
--  verdadeira, o sistema não deixa a pessoa fazer mais nada além de trocar a
--  senha. Sem ela, "troque na primeira vez" seria um pedido — e pedido, numa
--  fábrica em dia de correria, é o que ninguém faz.
--
--  Roda quantas vezes quiser.
-- ==========================================================================

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_provisoria BOOLEAN NOT NULL DEFAULT FALSE;

-- Quem JÁ ESTÁ no sistema não é obrigado a trocar: essas senhas já foram
-- escolhidas por quem as usa. A regra vale de agora em diante — para quem for
-- cadastrado ou tiver a senha redefinida.
COMMENT ON COLUMN usuarios.senha_provisoria IS
  'TRUE enquanto a senha for a de uso único gerada no cadastro ou na redefinição';

\echo '  05 aplicado: senha provisória'
