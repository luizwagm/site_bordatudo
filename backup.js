/* ==========================================================================
   backup.js — cópia de segurança automática do banco

   POR QUE EXISTE: todo o site vive num arquivo só, `data/site.db` — textos,
   modalidades, equipe, matérias do blog, a senha do painel. Sem cópia, um
   disco com defeito, um `rm` errado ou uma pasta sincronizada de forma
   atrapalhada levam tudo junto, e não há de onde voltar. É a única falta da
   lista cuja consequência é irreversível.

   COMO FAZ: usa `VACUUM INTO`, que é o backup ONLINE do próprio SQLite. Ele
   produz uma cópia consistente mesmo com o site em uso e gravando — ao
   contrário de copiar o arquivo com `cp`, que pode pegar um estado partido,
   porque parte do que foi escrito ainda está no arquivo `-wal`, ao lado.

   Depois de gerar, a cópia é ABERTA e passa pelo `integrity_check`: backup que
   ninguém testa não é backup, é esperança. Se vier corrompida, o arquivo é
   apagado e o erro aparece no log — melhor não ter cópia do que confiar numa
   que não presta.

   Roda dentro do próprio Node, sem cron: assim funciona igual no servidor, na
   sua máquina e em qualquer lugar que rode `node server.js`. A cada hora ele
   pergunta "já passou o intervalo desde a última cópia?". Isso sobrevive a
   reinício: se a máquina estava desligada na hora marcada, a cópia sai no
   próximo boot em vez de ser pulada — que é o que aconteceria com um cron.

   Versão do Forms: só SQLite. O BemEstar tem também um dump do PostgreSQL
   porque lá existe o sistema de gestão; aqui não há /restrito.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const { abrirBanco } = require("./db");

const CARIMBO = () => new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");

/* Uma cópia verificada do banco. Devolve {ok, arquivo, bytes, erro}. */
function copiarBanco(origem, destinoDir) {
  const nome = path.basename(origem, ".db");
  let arquivo = "";
  let db = null, copia = null;
  try {
    if (!fs.existsSync(origem)) return { ok: false, erro: "banco ainda não existe" };
    fs.mkdirSync(destinoDir, { recursive: true });
    /* O carimbo tem precisão de segundo. Duas cópias no mesmo segundo (um
       backup manual logo depois do automático) cairiam no mesmo nome, e o
       VACUUM INTO se RECUSA a sobrescrever — então desempata com sufixo. */
    const base = `${nome}.${CARIMBO()}`;
    arquivo = path.join(destinoDir, `${base}.db`);
    for (let i = 2; fs.existsSync(arquivo) && i < 100; i++) arquivo = path.join(destinoDir, `${base}-${i}.db`);

    db = abrirBanco(origem);
    // VACUUM INTO exige caminho com barras normais, inclusive no Windows
    db.exec(`VACUUM INTO '${arquivo.split(path.sep).join("/").replace(/'/g, "''")}'`);
    db.close();
    db = null;

    // a cópia presta? abre e confere antes de considerá-la válida
    copia = abrirBanco(arquivo);
    const r = copia.prepare("PRAGMA integrity_check").get();
    const veredito = r ? (r.integrity_check || Object.values(r)[0]) : "";
    copia.close();
    copia = null;
    if (String(veredito).toLowerCase() !== "ok") {
      fs.unlinkSync(arquivo);
      return { ok: false, erro: "cópia corrompida (" + veredito + ")" };
    }
    return { ok: true, arquivo, bytes: fs.statSync(arquivo).size };
  } catch (e) {
    try { if (db) db.close(); } catch {}
    try { if (copia) copia.close(); } catch {}
    try { if (arquivo && fs.existsSync(arquivo)) fs.unlinkSync(arquivo); } catch {}
    return { ok: false, erro: e.message };
  }
}

/* Mantém só as N cópias mais recentes. Sem isto, a pasta cresce para sempre. */
function limparAntigos(destinoDir, nomeBanco, manter) {
  try {
    const arquivos = fs.readdirSync(destinoDir)
      .filter((f) => f.startsWith(nomeBanco + ".") && f.endsWith(".db"))
      .map((f) => ({ f, t: fs.statSync(path.join(destinoDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    let removidos = 0;
    for (const velho of arquivos.slice(manter)) { fs.unlinkSync(path.join(destinoDir, velho.f)); removidos++; }
    return removidos;
  } catch { return 0; }
}

/* Quando foi a última cópia (ms) — 0 se nunca houve. */
function ultimaCopia(destinoDir, nomeBanco) {
  try {
    return fs.readdirSync(destinoDir)
      .filter((f) => f.startsWith(nomeBanco + ".") && f.endsWith(".db"))
      .reduce((max, f) => Math.max(max, fs.statSync(path.join(destinoDir, f)).mtimeMs), 0);
  } catch { return 0; }
}

/* Uma rodada de backup de todos os bancos configurados. */
function rodarBackup(cfg, motivo) {
  const feitos = [];
  for (const origem of cfg.bancos) {
    const nome = path.basename(origem, ".db");
    const r = copiarBanco(origem, cfg.destino);
    if (r.ok) {
      const removidos = limparAntigos(cfg.destino, nome, cfg.manter);
      const kb = Math.max(1, Math.round(r.bytes / 1024));
      console.log(`  · backup ${motivo}: ${path.basename(r.arquivo)} (${kb} KB)${removidos ? ` · ${removidos} antigo(s) removido(s)` : ""}`);
      feitos.push({ banco: nome, arquivo: r.arquivo, bytes: r.bytes });
    } else if (r.erro !== "banco ainda não existe") {
      console.error(`  ✖ backup de ${nome} FALHOU: ${r.erro}`);
    }
  }
  return feitos;
}

/* Situação atual, para o painel e o verificar.sh mostrarem. */
function statusBackup(cfg) {
  const bancos = cfg.bancos.map((origem) => {
    const nome = path.basename(origem, ".db");
    const t = ultimaCopia(cfg.destino, nome);
    let copias = 0;
    try { copias = fs.readdirSync(cfg.destino).filter((f) => f.startsWith(nome + ".") && f.endsWith(".db")).length; } catch {}
    return { banco: nome, motor: "SQLite",
      ultimo: t ? new Date(t).toISOString() : null,
      horasAtras: t ? (Date.now() - t) / 3600e3 : null, copias };
  });
  return { destino: cfg.destino, intervaloHoras: cfg.intervaloHoras, manter: cfg.manter, bancos };
}

/* Liga a rotina. Chamado uma vez no boot do server.js. */
function agendarBackups(opcoes) {
  const cfg = {
    destino: opcoes.destino,
    bancos: (opcoes.bancos || []).filter(Boolean),
    manter: opcoes.manter || 30,
    intervaloHoras: opcoes.intervaloHoras || 24,
  };
  fs.mkdirSync(cfg.destino, { recursive: true });

  const vencido = () => cfg.bancos.some((origem) => {
    const t = ultimaCopia(cfg.destino, path.basename(origem, ".db"));
    return !t || (Date.now() - t) > cfg.intervaloHoras * 3600e3;
  });

  /* No boot, espera 20s antes de copiar: o backup não pode atrasar a subida do
     site. O `unref` impede que estes temporizadores segurem o processo aberto
     na hora de encerrar. */
  setTimeout(() => { if (vencido()) rodarBackup(cfg, "de boot"); }, 20_000).unref();
  setInterval(() => { if (vencido()) rodarBackup(cfg, "diário"); }, 3600e3).unref();

  console.log(`  · backup automático: a cada ${cfg.intervaloHoras}h em ${path.relative(process.cwd(), cfg.destino) || cfg.destino} (mantém ${cfg.manter})`);
  return { cfg, rodarAgora: (motivo) => rodarBackup(cfg, motivo || "manual"), status: () => statusBackup(cfg) };
}

module.exports = { agendarBackups, rodarBackup, statusBackup, copiarBanco };
