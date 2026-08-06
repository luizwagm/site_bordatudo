-- ==========================================================================
--  01 — cria o papel e o banco do /restrito.
--
--  RODE COMO SUPERUSUÁRIO, VOCÊ MESMO, no seu terminal:
--
--      psql -U postgres -f sql/01-criar-banco.sql
--
--  Depois ponha a senha que você escolheu no `.env` da raiz do projeto:
--      PGPASSWORD=<a senha>
--      DADOS_CHAVE=<32 bytes em hex — gere com: openssl rand -hex 32>
--
--  TROQUE A SENHA ABAIXO ANTES DE RODAR. Ela está aqui como texto visível de
--  propósito: senha em arquivo versionado é senha pública. Este arquivo é o
--  roteiro, não o cofre.
-- ==========================================================================

CREATE ROLE bordatudo WITH LOGIN PASSWORD 'troque-esta-senha';

-- O papel NÃO é superusuário e não cria banco: se a aplicação for
-- comprometida, o estrago para no banco dela.
ALTER ROLE bordatudo NOSUPERUSER NOCREATEDB NOCREATEROLE;

CREATE DATABASE bordatudo_producao OWNER bordatudo ENCODING 'UTF8';

\echo '  banco bordatudo_producao criado'
\echo '  agora: psql -U bordatudo -d bordatudo_producao -f sql/02-esquema.sql'
