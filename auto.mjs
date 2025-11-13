#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
};

const DEFAULT_PHASES = 'faucet,swap,stake,unstake,deposit,point';
const PHASES_CFG = (process.env.AUTO_PHASES || DEFAULT_PHASES)
  .split(',').map(s => s.trim()).filter(Boolean);

// Add additional commands (wdsui, sui, reff) as requested
const CMDS = {
  faucet:  process.env.FAUCET_CMD  || 'node faucet.mjs',
  swap:    process.env.SWAP_CMD    || 'node swap.mjs',
  stake:   process.env.STAKE_CMD   || 'node stake.mjs',
  unstake: process.env.UNSTAKE_CMD || 'node unstake.mjs',
  deposit: process.env.DEPOSIT_CMD || 'node deposit.mjs',
  borrow:  process.env.BORROW_CMD  || 'node borrow.mjs',
  repay:   process.env.REPAY_CMD   || 'node repay.mjs',
  point:   process.env.POINT_CMD   || 'node point.mjs',
  wdsui:   process.env.WDSUI_CMD   || 'node wdsui.mjs',
  sui:     process.env.SUI_CMD     || 'node sui.mjs',
  reff:    process.env.REFF_CMD    || 'node reff.mjs',
};

const POINT_CMD = process.env.POINT_CMD || 'node point.mjs';
const DETECT_FROM_POINTS = truthy(process.env.DETECT_FROM_POINTS ?? '1');

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

const GLOBAL_SUCCESS_DELAY_MS = num(process.env.SUCCESS_DELAY_MS_GLOBAL, 5000);
function successDelayFor(ph){
  const envKey = `SUCCESS_DELAY_MS_${ph.toUpperCase()}`;
  return num(process.env[envKey], GLOBAL_SUCCESS_DELAY_MS);
}

const RETRY_GLOBAL_MAX    = int(process.env.RETRY_MAX, 1);
const RETRY_BACKOFF_MS    = int(process.env.RETRY_BACKOFF_MS, 3000);
const RETRY_BACKOFF_MODE  = String(process.env.RETRY_BACKOFF_MODE || 'linear');
const RETRY_BACKOFF_MULT  = num(process.env.RETRY_BACKOFF_MULT, 1.8);

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

const STOP_ON_FAIL = truthy(process.env.STOP_ON_FAIL);

// Per-phase override retry
const PER_PHASE_RETRY = {};
for (const ph of Object.keys(CMDS)) {
  const key = `RETRY_PHASE_${ph}`;
  if (process.env[key] !== undefined) PER_PHASE_RETRY[ph] = int(process.env[key], RETRY_GLOBAL_MAX);
}

// ===== ACCOUNTS & PARALLELISM (NEW) =====
// Allow flexible ACCOUNT formats and inject PRIVATE_KEY / SUI_PRIVATE_KEY for child processes
const PRIVATE_KEY_ENV_NAME = process.env.PRIVATE_KEY_ENV_NAME || 'PRIVATE_KEY';
const SUI_PRIVATE_KEY_ENV_NAME = process.env.SUI_PRIVATE_KEY_ENV_NAME || 'SUI_PRIVATE_KEY';

// Helper: parse one account token (item can be: id, id=key, id=/path, rawKey)
function parseAccountToken(item, idx) {
  const eq = item.indexOf('=');
  if (eq === -1) {
    const v = item;
    const looksLikeKey = /^edpk[A-Za-z0-9]+$/.test(v) || /^[0-9a-f]{64,}$/i.test(v) || v.length > 40 || v.startsWith('suiprivkey');
    if (looksLikeKey) return { id: `acct-${idx+1}`, key: v, keyFile: null };
    return { id: v, key: null, keyFile: null };
  }
  const id = item.slice(0, eq).trim() || `acct-${idx+1}`;
  const val = item.slice(eq + 1).trim();
  if (!val) return { id, key: null, keyFile: null };
  if (val.startsWith('/') || val.startsWith('./')) return { id, key: null, keyFile: val };
  return { id, key: val, keyFile: null };
}

// Build ACCOUNTS array from either ACCOUNTS_FILE or ACCOUNTS env
let ACCOUNTS = [];
if (process.env.ACCOUNTS_FILE) {
  try {
    const raw = fs.readFileSync(process.env.ACCOUNTS_FILE, 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    ACCOUNTS = raw.map((line, idx) => {
      // allow lines like "id=key" or just key
      return parseAccountToken(line, idx);
    });
  } catch (e) {
    log.error(`Gagal baca ACCOUNTS_FILE="${process.env.ACCOUNTS_FILE}":`, e.message || e);
    process.exit(1);
  }
} else {
  const ACCOUNTS_RAW = (process.env.ACCOUNTS || '').split(',').map(s=>s.trim()).filter(Boolean);
  ACCOUNTS = ACCOUNTS_RAW.map((item, idx) => parseAccountToken(item, idx));
}

// Legacy: allow INPUT file containing keys (one per line) — if provided and ACCOUNTS empty, load it
if (!ACCOUNTS.length && process.env.INPUT) {
  try {
    const raw = fs.readFileSync(process.env.INPUT, 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (raw.length) ACCOUNTS = raw.map((line, idx) => parseAccountToken(line, idx));
  } catch (e) {
    // ignore if not present
  }
}

const PARALLELISM = int(process.env.PARALLELISM, 1); // used only if no inline keys/files (else forced to 1)

// ===== Utils =====
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d=0){ const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function truthy(v){ return ['1','true','yes','y','on'].includes(String(v||'').toLowerCase()); }

// === DAILY ENSURE ===
const DAILY_ENSURE_TX = truthy(process.env.DAILY_ENSURE_TX ?? '1');
const DAILY_MIN_TX    = int(process.env.DAILY_MIN_TX, 1);
const DAILY_PHASES    = (process.env.DAILY_PHASES || 'faucet,swap,stake,unstake')
  .split(',').map(s=>s.trim()).filter(Boolean);
const STATE_FILE      = process.env.DAILY_STATE_FILE || path.join('.cache','auto-daily.json');

function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive:true }); }
function todayJakarta(){
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });
  return s.slice(0,10);
}
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(st){ ensureDir(STATE_FILE); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }
function hasDailyDone(st, day, phase, addr='*'){ return !!st?.[day]?.[addr]?.[phase]; }
function markDailyDone(st, day, phase, addr='*'){ st[day] ??= {}; st[day][addr] ??= {}; st[day][addr][phase] = true; return st; }

// === map badge key → phase ===
function mapKeyToPhase(keyLower){
  if (keyLower.includes('swap')) return 'swap';
  if (keyLower.includes('unstake') || keyLower.includes('redeem')) return 'unstake';
  if (keyLower.includes('stake')) return 'stake';
  if (keyLower.includes('deposit')) return 'deposit';
  if (keyLower.includes('mint')) return 'faucet';
  return null;
}

// ---- child execution helpers ----
async function execCapture(cmd, timeoutMs=0, envOverrides={}){
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { shell: true, env: Object.assign({}, process.env, envOverrides) });
    let out = '', err = '';
    let killedByTimeout = false;
    let to = null;

    if (timeoutMs > 0) {
      to = setTimeout(() => {
        killedByTimeout = true;
        try { p.kill('SIGKILL'); } catch {}
      }, timeoutMs);
    }

    p.stdout.on('data', d => out += String(d));
    p.stderr.on('data', d => err += String(d));

    p.on('error', e => {
      if (to) clearTimeout(to);
      reject(e);
    });
    p.on('exit', code => {
      if (to) clearTimeout(to);
      if (killedByTimeout) return reject(new Error('timeout'));
      if (code === 0) return resolve(out || '');
      resolve(out || err || '');
    });
  });
}

async function runCmd(cmd, timeoutMs=0, envOverrides = {}){
  return new Promise((resolve, reject) => {
    log.info('$', cmd);
    const env = Object.assign({}, process.env, envOverrides);
    const p = spawn(cmd, { stdio: 'inherit', shell: true, env });

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

async function runOneAttempt(ph, envOverrides={}){ return runCmd(CMDS[ph], TIMEOUTS[ph] || 0, envOverrides); }

async function runWithRetries(ph, retryMax, envOverrides = {}){
  let attempt = 0;
  let errLast = null;
  let backoff = RETRY_BACKOFF_MS;

  while (attempt < Math.max(1, retryMax)) {
    attempt++;
    try {
      log.debug(`[${ph}] attempt ${attempt}/${Math.max(1, retryMax)}`);
      await runOneAttempt(ph, envOverrides);
      return { ok: true, attempts: attempt, error: null };
    } catch (e) {
      errLast = e;
      log.warn(`[${ph}] attempt ${attempt} failed: ${e?.message || e}`);
      if (attempt >= Math.max(1, retryMax)) break;
      if (RETRY_BACKOFF_MODE === 'exponential') {
        await sleep(backoff);
        backoff = Math.ceil(backoff * (RETRY_BACKOFF_MULT > 1 ? RETRY_BACKOFF_MULT : 2));
      } else {
        await sleep(RETRY_BACKOFF_MS);
      }
      log.info(`[${ph}] retrying...`);
    }
  }
  return { ok: false, attempts: attempt, error: errLast };
}

async function detectTimesFromPoint(envOverrides={}) {
  const out = await execCapture(POINT_CMD, TIMEOUTS.point || 0, envOverrides);
  const lines = out.split(/\r?\n/);

  const timesMap = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };
  const progMap  = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };
  const needMap  = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };

  const re = /•\s+(.*?)\s+\[([^\]]+)\]\s+(\d+)\/(\d+)/i;

  for (const raw of lines) {
    const m = re.exec(raw);
    if (!m) continue;
    const key = m[2];
    const a = Number(m[3]);
    const b = Number(m[4]);
    const phase = mapKeyToPhase(String(key).toLowerCase());
    if (!phase) continue;
    progMap[phase] = Math.max(progMap[phase], a);
    needMap[phase] = Math.max(needMap[phase], b);
  }

  for (const ph of Object.keys(timesMap)) {
    const remaining = Math.max(0, (needMap[ph] || 0) - (progMap[ph] || 0));
    timesMap[ph] = remaining;
  }

  log.info('[detect] from point.mjs → remaining:', JSON.stringify(timesMap));
  return timesMap;
}

async function runPhase(ph, repsTarget, successDelay, retryMax, envOverrides={}) {
  if (!CMDS[ph]) {
    log.warn(`skip unknown phase: ${ph}`);
    return { ok: true, tries: 0, repsSuccess: 0, repsTarget: 0, error: null };
  }
  if (repsTarget <= 0) {
    log.info(`=== PHASE: ${ph} — remaining 0 → skip ===`);
    return { ok: true, tries: 0, repsSuccess: 0, repsTarget, error: null };
  }

  log.info(`=== PHASE: ${ph} — target ${repsTarget}× (retry/rep=${Math.max(1, retryMax)}, successDelay=${successDelay}ms) ===`);

  let repsSuccess = 0;
  let repsTried = 0;
  let lastErr = null;

  while (repsSuccess < repsTarget) {
    repsTried++;
    log.info(`[${ph}] repetition ${repsSuccess + 1}/${repsTarget}`);

    const res = await runWithRetries(ph, retryMax, envOverrides);
    if (res.ok) {
      repsSuccess++;
      if (repsSuccess < repsTarget && successDelay > 0) {
        log.info(`[${ph}] success. Delay ${successDelay}ms sebelum repetition berikutnya...`);
        await sleep(successDelay);
      }
    } else {
      lastErr = res.error;
      log.error(`[${ph}] repetition gagal setelah ${res.attempts} attempt.`);
      break;
    }
  }

  const phaseOk = repsSuccess === repsTarget;
  return { ok: phaseOk, tries: repsTried, repsSuccess, repsTarget, error: phaseOk ? null : lastErr };
}

function printSummary(results){
  const ok = results.filter(r => r.ok).map(r => `${r.phase} (${r.repsSuccess}/${r.repsTarget})`);
  const fail = results.filter(r => !r.ok).map(r => `${r.phase} (${r.repsSuccess}/${r.repsTarget}${r.error ? `, ${r.error.message || 'error'}`:''})`);
  console.log('\n====== SUMMARY ======');
  console.log('Sukses :', ok.length ? ok.join(', ') : '-');
  console.log('Gagal  :', fail.length ? fail.join(', ') : '-');
  console.log('=====================\n');
}

// === per-account run (UPDATED to accept accountObj) ===
async function runForAccount(accountObj, globalDetectedTimes=null){
  const accountAddr = accountObj.id;
  log.info(`=== RUN ACCOUNT: ${accountAddr} ===`);
  const results = [];
  const st = DAILY_ENSURE_TX ? loadState() : {};
  const today = todayJakarta();
  const ADDR_KEY = accountAddr;

  // 1) optionally detect per-account times from point.mjs using ACCOUNT in env
  let timesDetected = null;
  if (DETECT_FROM_POINTS) {
    try { timesDetected = await detectTimesFromPoint({ ACCOUNT_ADDR: accountAddr }); }
    catch (e) { log.warn(`[detect ${accountAddr}] gagal membaca point.mjs:`, e?.message || e); timesDetected = null; }
  }
  // fallback to global detection if provided
  if (!timesDetected) timesDetected = globalDetectedTimes || null;

  // 2) determine target repetitions per phase (same logic as original)
  const targetTimes = {};
  for (const ph of PHASES_CFG) {
    let t = 0;
    if (timesDetected && ph in timesDetected) {
      t = timesDetected[ph] || 0;
    } else {
      const envKey = `TIMES_${ph.toUpperCase()}`;
      t = int(process.env[envKey], 1);
    }

    if (DAILY_ENSURE_TX && DAILY_PHASES.includes(ph) && !hasDailyDone(st, today, ph, ADDR_KEY)) {
      if (t < DAILY_MIN_TX) {
        log.info(`[daily:${accountAddr}] enforce: ${ph} set to at least ${DAILY_MIN_TX} for ${today}`);
        t = DAILY_MIN_TX;
      }
    }

    targetTimes[ph] = t;
  }

  log.info(`[${accountAddr}] phases:`, PHASES_CFG.join(' -> '));
  log.info(`[${accountAddr}] target repetitions:`, JSON.stringify(targetTimes));

  // 3) prepare envOverrides base for this account
  const baseEnvOverrides = { ACCOUNT_ADDR: accountAddr, STATE_ADDR_KEY: accountAddr };

  // inject private key if provided inline
  if (accountObj.key) {
    baseEnvOverrides[PRIVATE_KEY_ENV_NAME] = accountObj.key;
    if (PRIVATE_KEY_ENV_NAME !== SUI_PRIVATE_KEY_ENV_NAME) baseEnvOverrides[SUI_PRIVATE_KEY_ENV_NAME] = accountObj.key;
  } else if (accountObj.keyFile) {
    try {
      const keyContent = fs.readFileSync(accountObj.keyFile, 'utf8').trim();
      baseEnvOverrides[PRIVATE_KEY_ENV_NAME] = keyContent;
      if (PRIVATE_KEY_ENV_NAME !== SUI_PRIVATE_KEY_ENV_NAME) baseEnvOverrides[SUI_PRIVATE_KEY_ENV_NAME] = keyContent;
    } catch (e) {
      log.warn(`[${accountAddr}] gagal baca keyfile ${accountObj.keyFile}:`, e?.message || e);
    }
  }

  // 4) Run each phase for this account (sequential)
  for (const ph of PHASES_CFG) {
    const retryMax = PER_PHASE_RETRY[ph] ?? RETRY_GLOBAL_MAX;
    const successDelay = successDelayFor(ph);
    const repsTarget = targetTimes[ph] ?? 0;

    // clone base env overrides so we can add per-phase extras later if perlu
    const envOverrides = Object.assign({}, baseEnvOverrides);

    const res = await runPhase(ph, repsTarget, successDelay, retryMax, envOverrides);
    results.push({ phase: ph, ...res });

    if (DAILY_ENSURE_TX && res.repsSuccess > 0 && DAILY_PHASES.includes(ph)) {
      markDailyDone(st, today, ph, accountAddr);
      saveState(st);
      log.info(`[daily:${accountAddr}] marked done: ${ph} @ ${today}`);
    }

    if (!res.ok) {
      log.warn(`SKIP (${accountAddr}): Phase "${ph}" failed (${res.repsSuccess}/${res.repsTarget}) → lanjut…`);
      if (STOP_ON_FAIL) {
        log.error('STOP_ON_FAIL=1 → menghentikan run sekarang.');
        printSummary(results);
        throw new Error('stop_on_fail');
      }
    }

    const d = DELAYS[ph] || 0;
    if (d > 0) {
      log.info(`delay ${d}ms setelah phase ${ph}...`);
      await sleep(d);
    }
  }

  printSummary(results);
  return results;
}

// concurrency worker runner (UPDATED to handle account objects and force sequential when keys present)
async function runAllAccounts(accounts){
  // detect once globally (without ACCOUNT) to speed things up if desired
  let globalDetectedTimes = null;
  if (DETECT_FROM_POINTS) {
    try { globalDetectedTimes = await detectTimesFromPoint(); }
    catch(e){ log.warn('[detect global] failed:', e?.message || e); globalDetectedTimes = null; }
  }

  if (!accounts.length) {
    // no accounts provided: run once using default env (like original behaviour)
    await runForAccount({ id: process.env.STATE_ADDR_KEY || '*', key: null }, globalDetectedTimes);
    return;
  }

  // if any account provides a private key (inline or file), force sequential mode (safe)
  const hasKeys = accounts.some(a => a.key || a.keyFile);
  const concurrency = hasKeys ? 1 : Math.max(1, PARALLELISM);

  const q = accounts.slice();
  const workers = [];
  for (let i=0;i<concurrency;i++){
    workers.push((async function worker(){
      while (true) {
        const acc = q.shift();
        if (!acc) break;
        try { await runForAccount(acc, globalDetectedTimes); }
        catch(e){
          if (e?.message === 'stop_on_fail') {
            log.error('Worker stopping due to STOP_ON_FAIL.');
            process.exit(1);
          }
          log.error(`Account ${acc.id} fatal:`, e.message || e);
        }
      }
    })());
  }
  await Promise.all(workers);
}

// Entrypoint
(async () => {
  try {
    log.info('Auto runner (multi-account aware) starting...');
    log.info('PHASES_CFG:', PHASES_CFG.join(','));
    log.info('ACCOUNTS:', ACCOUNTS.length ? ACCOUNTS.map(a=>a.id).join(',') : '(none)');
    log.info('PARALLELISM:', PARALLELISM);

    await runAllAccounts(ACCOUNTS);
    process.exit(0);
  } catch (e) {
    log.error('FATAL:', e.message || e);
    process.exit(1);
  }
})();
