#!/usr/bin/env node
// auto.mjs — Orchestrator semua phase via command eksternal
// Behavior: kalau error → SKIP & lanjut (default). Bisa paksa stop lewat STOP_ON_FAIL=1

import 'dotenv/config';
import { spawn } from 'node:child_process';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
};

// ===== Konfigurasi Phases =====
const DEFAULT_PHASES = 'faucet,swap,stake,unstake,deposit,point';
const PHASES = (process.env.AUTO_PHASES || DEFAULT_PHASES)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Map command default (bisa override via ENV)
const CMDS = {
  faucet:  process.env.FAUCET_CMD  || 'node faucet.mjs',
  swap:    process.env.SWAP_CMD    || 'node swap.mjs',
  stake:   process.env.STAKE_CMD   || 'node stake.mjs',
  unstake: process.env.UNSTAKE_CMD || 'node unstake.mjs',
  deposit: process.env.DEPOSIT_CMD || 'node deposit.mjs',
  borrow:  process.env.BORROW_CMD  || 'node borrow.mjs',
  repay:   process.env.REPAY_CMD   || 'node repay.mjs',
  point:   process.env.POINT_CMD   || 'node point.mjs',
};

// Delay setelah tiap phase (ms)
const DELAYS = {
  faucet:  num(process.env.DELAY_AFTER_FAUCET_MS, 3000),
  swap:    num(process.env.DELAY_AFTER_SWAP_MS,   2000),
  stake:   num(process.env.DELAY_AFTER_STAKE_MS,  1500),
  unstake: num(process.env.DELAY_AFTER_UNSTAKE_MS,1000),
  deposit: num(process.env.DELAY_AFTER_DEPOSIT_MS,1500),
  borrow:  num(process.env.DELAY_AFTER_BORROW_MS, 1500),
  repay:   num(process.env.DELAY_AFTER_REPAY_MS,  1500),
  point:   num(process.env.DELAY_AFTER_POINT_MS,  0),
};

// Retry global & per-phase
const RETRY_GLOBAL_MAX    = int(process.env.RETRY_MAX, 1);         // 1 = tanpa retry
const RETRY_BACKOFF_MS    = int(process.env.RETRY_BACKOFF_MS, 3000);
const RETRY_BACKOFF_MODE  = String(process.env.RETRY_BACKOFF_MODE || 'linear'); // linear|exponential
const RETRY_BACKOFF_MULT  = num(process.env.RETRY_BACKOFF_MULT, 1.8);

// Timeout per-phase (ms). 0 = no timeout
const TIMEOUTS = {
  faucet:  int(process.env.TIMEOUT_FAUCET_MS,  0),
  swap:    int(process.env.TIMEOUT_SWAP_MS,    0),
  stake:   int(process.env.TIMEOUT_STAKE_MS,   0),
  unstake: int(process.env.TIMEOUT_UNSTAKE_MS, 0),
  deposit: int(process.env.TIMEOUT_DEPOSIT_MS, 0),
  borrow:  int(process.env.TIMEOUT_BORROW_MS,  0),
  repay:   int(process.env.TIMEOUT_REPAY_MS,   0),
  point:   int(process.env.TIMEOUT_POINT_MS,   0),
};

// === Control: default lanjut saat gagal ===
// Bisa paksa berhenti kalau ada gagal: export STOP_ON_FAIL=1
const STOP_ON_FAIL = truthy(process.env.STOP_ON_FAIL);

// Per-phase override retry count (opsional), contoh di .env:
// RETRY_PHASE_stake=3
const PER_PHASE_RETRY = {};
for (const ph of Object.keys(CMDS)) {
  const key = `RETRY_PHASE_${ph}`;
  if (process.env[key] !== undefined) PER_PHASE_RETRY[ph] = int(process.env[key], RETRY_GLOBAL_MAX);
}

// ===== Utils =====
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d=0){ const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function truthy(v){ return ['1','true','yes','y','on'].includes(String(v||'').toLowerCase()); }

async function runCmd(cmd, timeoutMs=0){
  return new Promise((resolve, reject) => {
    log.info('$', cmd);
    const p = spawn(cmd, { stdio: 'inherit', shell: true });

    let killedByTimeout = false;
    let to = null;
    if (timeoutMs > 0) {
      to = setTimeout(() => {
        killedByTimeout = true;
        log.warn(`Phase command timeout after ${timeoutMs}ms, killing...`);
        try { p.kill('SIGKILL'); } catch {}
      }, timeoutMs);
    }

    p.on('error', (err) => {
      if (to) clearTimeout(to);
      reject(err);
    });

    p.on('exit', (code) => {
      if (to) clearTimeout(to);
      if (killedByTimeout) return reject(new Error('timeout'));
      if (code === 0) return resolve();
      reject(new Error(`exit ${code}`));
    });
  });
}

async function runPhase(ph){
  const cmd = CMDS[ph];
  if (!cmd) {
    log.warn(`skip unknown phase: ${ph}`);
    return { ok: true, tries: 0, error: null };
  }

  const retryMax = PER_PHASE_RETRY[ph] ?? RETRY_GLOBAL_MAX;
  let attempt = 0;
  let errLast = null;
  let backoff = RETRY_BACKOFF_MS;

  while (attempt < Math.max(1, retryMax)) {
    attempt++;
    log.info(`=== PHASE: ${ph} (attempt ${attempt}/${Math.max(1, retryMax)}) ===`);
    try {
      await runCmd(cmd, TIMEOUTS[ph] || 0);
      return { ok: true, tries: attempt, error: null };
    } catch (e) {
      errLast = e;
      log.error(`Phase "${ph}" failed:`, e?.message || e);
      if (attempt >= Math.max(1, retryMax)) break;

      // Hitung backoff berikutnya
      if (RETRY_BACKOFF_MODE === 'exponential') {
        await sleep(backoff);
        backoff = Math.ceil(backoff * (RETRY_BACKOFF_MULT > 1 ? RETRY_BACKOFF_MULT : 2));
      } else {
        await sleep(backoff);
      }
      log.info(`[retry] re-run phase "${ph}" after backoff...`);
    }
  }
  return { ok: false, tries: attempt, error: errLast };
}

(async () => {
  log.info('Auto runner — phases:', PHASES.join(' -> '));

  const results = [];

  for (const ph of PHASES) {
    const res = await runPhase(ph);
    results.push({ phase: ph, ...res });

    if (!res.ok) {
      log.warn(`SKIP: Phase "${ph}" gagal setelah ${res.tries} attempt → lanjut ke phase berikutnya…`);
      if (STOP_ON_FAIL) {
        log.error('STOP_ON_FAIL=1 → menghentikan run sekarang.');
        printSummary(results);
        // Exit dengan kode 1 jika dipaksa stop
        process.exit(1);
      }
    }

    const d = DELAYS[ph] || 0;
    if (d > 0) {
      log.info(`delay ${d}ms setelah phase ${ph}...`);
      await sleep(d);
    }
  }

  printSummary(results);
  // Selalu exit 0 (supaya cron/CI nggak mark failed kalau ada phase yang skip)
  process.exit(0);
})().catch(e => {
  log.error('FATAL:', e.message);
  // meskipun fatal di level orchestrator, tetap exit 0 agar sesuai “jgn stop”
  process.exit(0);
});

// ===== Summary nice print =====
function printSummary(results){
  const ok = results.filter(r => r.ok).map(r => r.phase);
  const fail = results.filter(r => !r.ok).map(r => `${r.phase} (${r.error?.message || 'error'})`);
  console.log('\n====== SUMMARY ======');
  console.log('Sukses :', ok.length ? ok.join(', ') : '-');
  console.log('Gagal  :', fail.length ? fail.join(', ') : '-');
  console.log('=====================\n');
}
