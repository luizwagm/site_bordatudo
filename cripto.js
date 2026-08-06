/* ==========================================================================
   cripto.js — proteção dos dados sensíveis no banco (LGPD)

   O QUE ISTO RESOLVE

   O banco guarda nome, telefone, e-mail e CPF de quem procura imóvel, mais o
   dado pessoal SENSÍVEL (art. 5º, II da LGPD). Até aqui tudo isso estava em
   texto puro: quem conseguisse o arquivo do banco, um dump esquecido numa
   pasta, ou acesso de leitura ao Postgres, leva a carteira de clientes inteira
   — que numa imobiliária é o ativo, e vale para o concorrente.

   Agora esses campos são cifrados PELA APLICAÇÃO, antes de chegarem ao banco.
   A chave NÃO mora no banco — mora no ambiente do serviço (/etc/imobiliaria.env).
   A consequência prática é a que o cliente pediu:

     · o dump do pg_dump sai cifrado. Restaurar num servidor COM a chave
       funciona normalmente; restaurar sem a chave devolve dados inertes.
     · quem lê o banco por fora (um SELECT, um backup vazado) vê texto cifrado.
     · quem está logado no sistema vê tudo certo, na tela e na impressão —
       porque a decifragem acontece no caminho de leitura da aplicação.

   COMO É CIFRADO

   AES-256-GCM. GCM é cifra AUTENTICADA: além de esconder, ela detecta
   adulteração. Se alguém editar um CPF direto no banco, a decifragem falha em
   vez de devolver lixo silenciosamente — num valor de proposta, lixo silencioso é
   pior que erro.

   Cada valor usa um IV (vetor de inicialização) ALEATÓRIO próprio. É isso que
   faz dois leads com o mesmo telefone terem textos cifrados diferentes —
   sem isso, dava para descobrir quem compartilha telefone só comparando o
   banco, sem nunca decifrar nada.

   FORMATO

     enc:1:<iv em base64>:<tag em base64>:<cifrado em base64>

   O prefixo "enc:" é o que permite ao sistema saber, olhando o valor, se ele
   já está cifrado. Isso importa em três momentos: durante a migração (parte
   dos registros já convertida, parte não), ao restaurar um backup antigo em
   texto puro, e para nunca cifrar duas vezes o mesmo valor.

   O "1" é a versão da chave. Não é enfeite: quando a chave for trocada um dia,
   é ele que diz com qual chave cada registro foi escrito, permitindo a virada
   sem parar o sistema.
   ========================================================================== */
const crypto = require("node:crypto");

const PREFIXO = "enc:";
const VERSAO_ATUAL = "1";
const ALGORITMO = "aes-256-gcm";

let CHAVES = null;          // { "1": Buffer(32), ... }
let ERRO_CHAVE = "";

/* --------------------------- carregar a chave ----------------------------
   DADOS_CHAVE traz 32 bytes em base64. Gerar com:
       openssl rand -base64 32
   DADOS_CHAVE_ANTERIOR (opcional) guarda a chave velha durante uma rotação:
   o sistema continua LENDO o que foi escrito com ela, mas só ESCREVE com a
   atual. */
function carregarChaves() {
  if (CHAVES) return CHAVES;
  const mapa = {};
  const ler = (valor, rotulo) => {
    const b = Buffer.from(String(valor || ""), "base64");
    if (b.length !== 32) throw new Error(`${rotulo} precisa ter 32 bytes em base64 (gere com: openssl rand -base64 32)`);
    return b;
  };
  try {
    if (!process.env.DADOS_CHAVE) throw new Error("DADOS_CHAVE não está definida no ambiente");
    mapa[VERSAO_ATUAL] = ler(process.env.DADOS_CHAVE, "DADOS_CHAVE");
    if (process.env.DADOS_CHAVE_ANTERIOR) mapa["0"] = ler(process.env.DADOS_CHAVE_ANTERIOR, "DADOS_CHAVE_ANTERIOR");
    CHAVES = mapa;
    ERRO_CHAVE = "";
  } catch (e) {
    ERRO_CHAVE = e.message;
    CHAVES = null;
  }
  return CHAVES;
}

const chaveConfigurada = () => !!carregarChaves();
const erroChave = () => { carregarChaves(); return ERRO_CHAVE; };

/* ------------------------------- cifrar ---------------------------------- */
const jaCifrado = (v) => typeof v === "string" && v.startsWith(PREFIXO);

function cifrar(valor) {
  // nulo e vazio continuam nulo e vazio: cifrar "nada" só gastaria espaço e
  // ainda revelaria, pelo tamanho, que o campo estava em branco
  if (valor === null || valor === undefined || valor === "") return valor;
  if (jaCifrado(valor)) return valor;                    // idempotente

  const chaves = carregarChaves();
  if (!chaves) throw new Error("não posso gravar dado sensível sem a chave: " + ERRO_CHAVE);

  const iv = crypto.randomBytes(12);                     // 12 bytes é o tamanho recomendado para GCM
  const c = crypto.createCipheriv(ALGORITMO, chaves[VERSAO_ATUAL], iv);
  const cifrado = Buffer.concat([c.update(String(valor), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${PREFIXO}${VERSAO_ATUAL}:${iv.toString("base64")}:${tag.toString("base64")}:${cifrado.toString("base64")}`;
}

/* ------------------------------ decifrar --------------------------------- */
/* Valor que NÃO está no formato cifrado volta como está. É o que permite ao
   sistema funcionar durante a migração e ao restaurar um backup anterior a
   ela: registros já convertidos e ainda não convertidos convivem. */
function decifrar(valor) {
  if (!jaCifrado(valor)) return valor;

  const partes = valor.split(":");
  if (partes.length !== 5) return valor;                 // não é nosso formato
  const [, versao, ivB64, tagB64, dadosB64] = partes;

  const chaves = carregarChaves();
  if (!chaves || !chaves[versao]) {
    /* Sem a chave certa não há o que fazer — e é exatamente o comportamento
       desejado num backup vazado. Devolvemos um marcador em vez de estourar:
       assim a tela abre, mostra que aquele campo está protegido, e o resto do
       cadastro continua utilizável. Estourar deixaria o sistema inteiro
       inacessível por causa de uma chave errada. */
    return "[protegido]";
  }
  try {
    const d = crypto.createDecipheriv(ALGORITMO, chaves[versao], Buffer.from(ivB64, "base64"));
    d.setAuthTag(Buffer.from(tagB64, "base64"));
    return d.update(Buffer.from(dadosB64, "base64"), undefined, "utf8") + d.final("utf8");
  } catch {
    /* Chegou aqui = a autenticação do GCM falhou: o valor foi adulterado no
       banco, ou foi escrito com outra chave. Não devolvemos o conteúdo. */
    return "[protegido]";
  }
}

/* ==========================================================================
   IMPRESSÃO DIGITAL — busca exata sobre campo cifrado

   Um valor cifrado com IV aleatório não pode ser comparado no SQL: o mesmo CPF
   gera textos diferentes a cada gravação. Para o caso "achar a pessoa por
   este CPF exato", guardamos ao lado um HMAC-SHA256 do valor normalizado.

   HMAC (com a chave), e não hash puro: um SHA256 de CPF é reversível na
   prática — são 11 dígitos, um computador testa todos em segundos. Com a
   chave, quem tiver só o banco não consegue montar essa tabela.

   Serve para igualdade, não para busca parcial. A busca parcial que a recepção
   usa continua funcionando porque a aplicação decifra e filtra em memória.
   ========================================================================== */
function digitos(v) { return String(v || "").replace(/\D+/g, ""); }

function impressaoDigital(valor) {
  const limpo = digitos(valor);
  if (!limpo) return null;
  const chaves = carregarChaves();
  if (!chaves) return null;
  return crypto.createHmac("sha256", chaves[VERSAO_ATUAL]).update(limpo).digest("hex");
}

module.exports = {
  cifrar, decifrar, jaCifrado, impressaoDigital,
  chaveConfigurada, erroChave, PREFIXO, digitos,
};
