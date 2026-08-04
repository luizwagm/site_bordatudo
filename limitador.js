/* ==========================================================================
   limitador.js — freio contra ataque de senha

   O que já existia nos três sites era uma trava por IP: cinco erros do mesmo
   endereço e ele ficava 15 minutos de fora. Isso segura o roteiro caseiro
   apontado para o painel, e só. Quatro brechas ficavam abertas:

   1. ATAQUE DISTRIBUÍDO. A conta é uma só; os IPs, não. Com trinta máquinas —
      uma botnet alugada, ou só uma lista de proxies — o atacante ganha trinta
      orçamentos de cinco tentativas e a trava nunca dispara, porque nenhum IP
      isolado chega ao limite. É a brecha mais séria, e a que este arquivo
      fecha com o balde POR CONTA.

   2. REINÍCIO ZERAVA TUDO. A contagem morava só na memória do processo. O
      servidor reinicia sozinho de madrugada (o `unattended-upgrades` do
      Debian) e reinicia a cada deploy: bastava esperar para o orçamento voltar
      inteiro, todo dia. Agora a contagem é gravada em disco e sobrevive.

   3. ERRO RESPONDIA NA HORA. Sem espera entre as tentativas, o atacante usava
      o orçamento na velocidade da rede. Agora cada erro empurra a próxima
      tentativa para mais longe — 1s, 2s, 4s, 8s… — e o custo cresce sozinho.

   4. TROCA DE SENHA SEM FREIO. O endereço que troca a senha também recebe a
      senha ATUAL, então também é um lugar onde se pode adivinhar. Estava sem
      limite nenhum.

   O PREÇO DO BALDE POR CONTA, dito na cara: se qualquer um pudesse travar a
   conta, o atacante deixaria de tentar entrar e passaria a trancar o dono do
   lado de fora — negação de serviço, mais fácil que invadir. Por isso o balde
   da conta NÃO vale para IP que já acertou a senha antes: quem entra da
   máquina de sempre continua entrando enquanto o ataque acontece. O balde do
   IP, esse, vale para todo mundo, sempre — inclusive para o IP conhecido, que
   senão viraria um passe livre caso fosse ele o comprometido.

   Sem dependências: guarda em JSON, para servir igual aos três sites,
   independentemente de o banco ser SQLite ou PostgreSQL.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");

/* Os números. Poucos e explicados, para poder discutir cada um.

   O balde da CONTA é mais frouxo que o do IP de propósito: ele soma os erros
   do mundo inteiro, e uma pessoa distraída errando de casa, do trabalho e do
   celular não pode trancar a própria conta. Dez erros em meia hora, vindos de
   endereços diferentes, não é distração — é ataque.

   Medido na suíte: um ataque de 24h trocando de IP a cada tentativa cai de
   60 para 15 tentativas por hora. */
const PADRAO = {
  ipMax: 5, ipJanelaMin: 15,          // 5 erros do mesmo IP → 15 min de fora
  contaMax: 10, contaJanelaMin: 30,   // 10 erros na mesma conta → 30 min de fora
  esperaBaseS: 1, esperaTetoS: 30,    // espera entre tentativas: 1s dobrando até 30s
  lembrarIpBomDias: 30,               // por quanto tempo um IP que acertou é "conhecido"
};

const MIN = 60_000;
const DIA = 24 * 60 * MIN;

function criarLimitador({ arquivo, regras = {}, agora = () => Date.now() } = {}) {
  const R = { ...PADRAO, ...regras };

  /* `falhas` guarda um registro por chave ("painel:ip:1.2.3.4"), com quantos
     erros, quando foi o último e até quando o bloqueio vale.
     `ipsBons` guarda quando cada IP acertou a senha pela última vez. */
  let falhas = new Map();
  let ipsBons = new Map();

  /* ---------------------------- disco --------------------------------- */
  function carregar() {
    if (!arquivo) return;
    try {
      const d = JSON.parse(fs.readFileSync(arquivo, "utf8"));
      falhas = new Map(Object.entries(d.falhas || {}));
      ipsBons = new Map(Object.entries(d.ipsBons || {}));
      limpar();
    } catch { /* arquivo ausente ou corrompido: começa vazio, sem derrubar o site */ }
  }

  /* A gravação é adiada e agrupada: uma rajada de tentativas não pode virar
     uma rajada de escritas em disco. O `unref` impede que este timer segure o
     processo aberto na hora de encerrar. */
  let pendente = null;
  function agendarGravacao() {
    if (!arquivo || pendente) return;
    pendente = setTimeout(() => { pendente = null; gravar(); }, 2000);
    if (pendente.unref) pendente.unref();
  }
  function gravar() {
    if (!arquivo) return;
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      const tmp = arquivo + ".tmp";
      /* Grava em arquivo temporário e só então renomeia: se faltar energia no
         meio, o arquivo bom continua inteiro em vez de virar metade. */
      fs.writeFileSync(tmp, JSON.stringify({
        falhas: Object.fromEntries(falhas), ipsBons: Object.fromEntries(ipsBons),
      }));
      fs.renameSync(tmp, arquivo);
    } catch { /* não vale derrubar o login por causa do disco */ }
  }

  /* --------------------------- faxina --------------------------------- */
  function limpar() {
    const t = agora();
    for (const [k, v] of falhas) if (t > v.ate + R.ipJanelaMin * MIN) falhas.delete(k);
    for (const [ip, ts] of ipsBons) if (t - ts > R.lembrarIpBomDias * DIA) ipsBons.delete(ip);
  }

  /* --------------------------- os baldes ------------------------------ */
  const chaveIp = (escopo, ip) => `${escopo}|ip|${ip}`;
  const chaveConta = (escopo, conta) => `${escopo}|conta|${String(conta).toLowerCase()}`;

  function ler(chave) {
    const v = falhas.get(chave);
    if (!v) return null;
    if (agora() > v.ate) { falhas.delete(chave); return null; }   // janela venceu
    return v;
  }

  function somar(chave, janelaMin) {
    const v = falhas.get(chave);
    const t = agora();
    const n = v && t <= v.ate ? v.n + 1 : 1;
    falhas.set(chave, { n, ultimo: t, ate: t + janelaMin * MIN });
    return n;
  }

  /* A espera cresce dobrando: 1s, 2s, 4s… até o teto. O primeiro erro não
     espera nada — quem só digitou errado não pode ser castigado. */
  function esperaApos(n) {
    if (n < 2) return 0;
    return Math.min(R.esperaBaseS * 2 ** (n - 2), R.esperaTetoS);
  }

  const segundos = (ms) => Math.max(1, Math.ceil(ms / 1000));

  return {
    carregar, gravar, limpar,

    /* Chamado ANTES de conferir a senha. Devolve `{ ok }` ou o motivo e
       quantos segundos faltam. */
    verificar(escopo, ip, conta) {
      const t = agora();

      const vIp = ler(chaveIp(escopo, ip));
      if (vIp) {
        if (vIp.n >= R.ipMax)
          return { ok: false, esperar: segundos(vIp.ate - t), motivo: "ip",
            mensagem: `Muitas tentativas deste endereço. Tente de novo em ${Math.ceil((vIp.ate - t) / MIN)} min.` };
        /* Ainda dentro do orçamento, mas cedo demais desde o último erro. */
        const faltam = vIp.ultimo + esperaApos(vIp.n) * 1000 - t;
        if (faltam > 0)
          return { ok: false, esperar: segundos(faltam), motivo: "espera",
            mensagem: `Aguarde ${segundos(faltam)}s antes de tentar de novo.` };
      }

      /* O balde da conta não alcança quem já entrou daqui antes — é o que
         impede o ataque de virar tranca contra o próprio dono. */
      if (conta && !ipsBons.has(ip)) {
        const vC = ler(chaveConta(escopo, conta));
        if (vC && vC.n >= R.contaMax)
          return { ok: false, esperar: segundos(vC.ate - t), motivo: "conta",
            mensagem: `Esta conta recebeu tentativas demais e está temporariamente bloqueada. Tente de novo em ${Math.ceil((vC.ate - t) / MIN)} min.` };
      }

      return { ok: true };
    },

    /* Senha errada. */
    errou(escopo, ip, conta) {
      somar(chaveIp(escopo, ip), R.ipJanelaMin);
      if (conta) somar(chaveConta(escopo, conta), R.contaJanelaMin);
      agendarGravacao();
    },

    /* Senha certa: zera o IP, promove-o a conhecido e alivia a conta.

       A conta é zerada junto porque o dono acabou de provar quem é — deixar o
       balde cheio manteria o bloqueio de pé contra ele mesmo, vindo de um IP
       novo, que é o caso de quem viaja ou troca de operadora. */
    acertou(escopo, ip, conta) {
      falhas.delete(chaveIp(escopo, ip));
      if (conta) falhas.delete(chaveConta(escopo, conta));
      ipsBons.set(ip, agora());
      agendarGravacao();
    },

    /* Só para os testes e para diagnóstico. */
    estado: () => ({ falhas: new Map(falhas), ipsBons: new Map(ipsBons) }),
  };
}

module.exports = { criarLimitador, PADRAO };
