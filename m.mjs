#!/usr/bin/env node
// mint-bot.mjs
// node >= 18
// npm i ethers p-limit dotenv fast-csv

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ethers, Wallet, HDNodeWallet } from 'ethers';
import pLimit from 'p-limit';
import { format as csvFormat } from 'fast-csv';
import http from 'node:http';
import https from 'node:https';

// ========= ENV =========
const RPC_URL            = process.env.RPC_URL || '';
const CONTRACT_ADDRESS   = process.env.CONTRACT_ADDRESS || '';
const CHAIN_ID           = parseInt(process.env.CHAIN_ID || '8453', 10); // Base mainnet default
const OUT_DIR            = process.env.OUT_DIR || 'out';

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const WALLETS_FILE       = process.env.WALLETS_FILE || '';

const SIGNATURES_JSON    = process.env.SIGNATURES_JSON || '';
const FIDS_FILE          = process.env.FIDS_FILE || 'fids.txt';
const BASE               = process.env.BASE || ''; // for auto-fetch signature

const CONCURRENCY        = parseInt(process.env.CONCURRENCY || '2', 10);
const MAX_RETRIES        = parseInt(process.env.MAX_RETRIES || '4', 10);
const WAIT_CONFIRMATIONS = parseInt(process.env.WAIT_CONFIRMATIONS || '1', 10);
const GAS_MULTIPLIER     = parseFloat(process.env.GAS_MULTIPLIER || '1.05');
const DRY_RUN            = String(process.env.DRY_RUN || '0') === '1';
const CHECK_FID_USED     = String(process.env.CHECK_FID_USED || '1') === '1';
const FORCE_REFETCH_SIG  = String(process.env.FORCE_REFETCH_SIG || '0') === '1';

// ========= VALIDATION =========
if (!RPC_URL || !CONTRACT_ADDRESS) {
  console.error('Missing RPC_URL or CONTRACT_ADDRESS in .env');
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// ========= PROVIDER =========
const provider = new ethers.JsonRpcProvider(RPC_URL, { name: 'base', chainId: CHAIN_ID });

// ========= ABI MINIMAL =========
// Pastikan kontrakmu expose fidUsed(uint256) kalau mau CHECK_FID_USED=1
const ABI = [
  "function mint(uint256 inputFid, string url, bytes signature) payable",
  "function fidUsed(uint256) view returns (bool)"
];

// ========= UTILS =========
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function stripBOM(s){ return s.replace(/^\uFEFF/, ''); }
function normLine(s){ return stripBOM(String(s).trim()); }

function normalizeSig(sig) {
  if (!sig) return '';
  return sig.startsWith('0x') ? sig : '0x' + sig;
}

// ========= WALLET LOADER (robust) =========
function parseKeyLine(line, idx) {
  const raw = normLine(line);
  if (!raw) return null;

  // mnemonic: "mnemonic: word1 ... word12/24 #index"
  if (/^mnemonic\s*:/i.test(raw)) {
    const body = raw.replace(/^mnemonic\s*:/i, '').trim();
    const [phrasePart, indexPart] = body.split('#');
    const phrase = normLine(phrasePart || '');
    const accountIdx = indexPart ? parseInt(indexPart.trim(), 10) : 0;
    try {
      const hdw = HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${accountIdx}`);
      return hdw;
    } catch (e) {
      throw new Error(`Bad mnemonic on line ${idx+1}: ${e.message || e}`);
    }
  }

  // allow "PK=0x...", "privateKey: 0x...", or just key
  const m = raw.match(/(?:^|=|:)\s*([0-9a-fA-Fx\s"]+)$/);
  const val = m ? normLine(m[1]).replace(/^"(.*)"$/, '$1') : raw;

  let hex = val;
  if (hex.startsWith('0x')) hex = hex.slice(2);
  hex = hex.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return new Wallet('0x' + hex);
  }

  throw new Error(`Invalid private key format on line ${idx+1} (need 64 hex chars).`);
}

function loadWallets() {
  const list = [];

  if (WALLETS_FILE && fs.existsSync(WALLETS_FILE)) {
    const lines = fs.readFileSync(WALLETS_FILE, 'utf8').split(/\r?\n/);
    for (let i=0;i<lines.length;i++) {
      const l = normLine(lines[i]);
      if (!l || l.startsWith('#')) continue;
      const w = parseKeyLine(l, i);
      if (w) list.push(w.connect(provider));
    }
  }

  if (WALLET_PRIVATE_KEY) {
    try {
      const w = parseKeyLine(WALLET_PRIVATE_KEY, -1);
      if (w) list.unshift(w.connect(provider));
    } catch (e) {
      throw new Error(`WALLET_PRIVATE_KEY invalid: ${e.message || e}`);
    }
  }

  if (list.length === 0) {
    throw new Error('No valid wallets provided. Use WALLET_PRIVATE_KEY or WALLETS_FILE.');
  }
  return list;
}

const wallets = loadWallets();
let rrIdx = 0;
function pickWallet() {
  const w = wallets[rrIdx % wallets.length];
  rrIdx++;
  return w;
}

// ========= SIGNATURE SOURCE =========
// Format target: { fid: "298959", url: "https://...", signature: "0x..." }
function loadTargetsFromSignaturesJson(file) {
  const raw = JSON.parse(stripBOM(fs.readFileSync(file, 'utf8')));
  if (Array.isArray(raw)) {
    return raw.map(x => ({
      fid: String(x.fid),
      url: x.url || '',
      signature: normalizeSig(x.signature || '')
    }));
  }
  const arr = [];
  for (const k of Object.keys(raw)) {
    arr.push({
      fid: String(k),
      url: raw[k].url || '',
      signature: normalizeSig(raw[k].signature || '')
    });
  }
  return arr;
}

function loadFids(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s=>normLine(s)).filter(Boolean);
}

// Cache per-FID signature
function sigCachePath(fid) {
  return path.join(OUT_DIR, `sign-${fid}.json`);
}
function readSigCache(fid) {
  const p = sigCachePath(fid);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return null;
}
function writeSigCache(fid, obj) {
  fs.writeFileSync(sigCachePath(fid), JSON.stringify(obj, null, 2));
}

// Simple axios with keepalive for signature fetch
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
async function fetchSignature(fid) {
  if (!BASE) throw new Error('BASE not set; cannot auto-fetch signature.');
  const url = `${BASE.replace(/\/+$/,'')}/api/warplet/generateSignature/${fid}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'User-Agent':'MintBot/1.0'},
    body: JSON.stringify({ walletAddress: await wallets[0].getAddress() }), // signer could be any; backend may ignore
    // Node fetch will reuse keep-alive via global agent if set; here, simpler approach.
  });
  if (!res.ok) throw new Error(`fetchSignature ${fid} -> HTTP ${res.status}`);
  return await res.json();
}

// ========= BUILD TARGETS =========
let targets = [];
if (SIGNATURES_JSON && fs.existsSync(SIGNATURES_JSON)) {
  targets = loadTargetsFromSignaturesJson(SIGNATURES_JSON);
} else if (fs.existsSync(FIDS_FILE)) {
  const fids = loadFids(FIDS_FILE);
  targets = fids.map(fid => ({ fid, url:'', signature:'' }));
} else {
  console.error('No SIGNATURES_JSON or FIDS_FILE found.');
  process.exit(1);
}

// ========= CONTRACT INSTANCES =========
const readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

// ========= CORE MINT =========
async function ensureSignatureForTarget(t) {
  // Has signature already?
  if (t.signature && t.signature.length >= 2) return t;

  // Try cache
  if (!FORCE_REFETCH_SIG) {
    const cached = readSigCache(t.fid);
    if (cached?.signature && cached?.url) {
      t.signature = normalizeSig(cached.signature);
      t.url = cached.url;
      return t;
    }
  }

  // Fetch from backend (if BASE provided)
  if (!BASE) throw new Error(`Missing signature for fid=${t.fid} and BASE not set.`);
  const data = await fetchSignature(t.fid);
  // Expect at least: { signature: "0x...", url: "..." }
  if (!data?.signature) throw new Error(`No signature returned for fid=${t.fid}`);
  t.signature = normalizeSig(data.signature);
  t.url = data.url || t.url || '';
  writeSigCache(t.fid, { signature: t.signature, url: t.url, raw: data });
  return t;
}

async function doMintOne(t, wallet) {
  const out = {
    fid: String(t.fid),
    wallet: await wallet.getAddress(),
    ok:false,
    txHash:'',
    error:'',
    attempts:0
  };

  // 1) Ensure we have signature/url
  try {
    await ensureSignatureForTarget(t);
  } catch (e) {
    out.error = `sig-fetch-failed: ${e.message || e}`;
    return out;
  }

  const fid = BigInt(t.fid);
  const url = t.url || '';
  const signature = normalizeSig(t.signature || '');

  // 2) Optional: on-chain check fidUsed
  if (CHECK_FID_USED) {
    try {
      if (typeof readContract.fidUsed === 'function') {
        const used = await readContract.fidUsed(fid);
        if (used) {
          out.error = 'FID_ALREADY_USED';
          return out;
        }
      }
    } catch (e) {
      // Non-fatal if not available
      console.warn(`[warn] fidUsed read failed for fid=${fid}: ${e.message || e}`);
    }
  }

  // 3) Prepare write call
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const args = [fid, url, signature];

  // 4) Retry loop
  let attempt = 0;
  let backoff = 800;
  let lastErr = null;

  while (attempt < MAX_RETRIES) {
    attempt++;
    out.attempts = attempt;
    try {
      // gas estimate
      let gasLimit;
      try {
        gasLimit = await contract.estimateGas.mint(...args);
        gasLimit = gasLimit * BigInt(Math.round(GAS_MULTIPLIER * 100)) / 100n;
      } catch {
        gasLimit = 400_000n;
      }

      // fees
      const fee = await provider.getFeeData();
      const overrides = { gasLimit };
      if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
        overrides.maxFeePerGas = fee.maxFeePerGas;
        overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      } else if (fee.gasPrice) {
        overrides.gasPrice = fee.gasPrice;
      }

      console.log(`[mint] fid=${fid} from=${out.wallet} gas=${gasLimit.toString()}`);

      if (DRY_RUN) {
        out.ok = true;
        out.txHash = 'DRY_RUN';
        return out;
      }

      const tx = await contract.mint(...args, overrides);
      console.log(`[tx] ${tx.hash} fid=${fid} waiting ${WAIT_CONFIRMATIONS} conf`);
      const rc = await tx.wait(WAIT_CONFIRMATIONS);
      if (rc && rc.status === 1) {
        out.ok = true;
        out.txHash = tx.hash;
        return out;
      } else {
        lastErr = `reverted status=${rc?.status ?? 'unknown'}`;
        console.warn(`[warn] tx revert fid=${fid} status=${rc?.status}`);
      }
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      console.warn(`[warn] attempt#${attempt} fid=${fid} -> ${msg}`);

      // Backoff policy (simple)
      if (msg.includes('nonce') || msg.includes('underpriced')) {
        await sleep(1000 * attempt);
      } else if (msg.includes('timeout') || msg.includes('429') || msg.includes('rate limit') || msg.includes('ECONNRESET')) {
        await sleep(backoff);
        backoff = Math.min(30000, Math.floor(backoff * 1.6));
      } else if (msg.includes('insufficient funds')) {
        // No point retrying many times
        break;
      } else {
        await sleep(Math.min(3000, 500 * attempt));
      }
    }
  }

  out.error = String(lastErr);
  return out;
}

// ========= MAIN =========
(async () => {
  console.log(`Mint-Bot start: targets=${targets.length} wallets=${wallets.length} concurrency=${CONCURRENCY} DRY_RUN=${DRY_RUN}`);
  const limit = pLimit(CONCURRENCY);

  // Attach provider to wallets (already connected in loader), just sanity:
  // (ethers v6 Wallet.connect returns a new Wallet; loader already connected)

  const jobs = targets.map(t => limit(async () => {
    const w = pickWallet();
    try {
      return await doMintOne({ ...t }, w);
    } catch (e) {
      return {
        fid: String(t.fid),
        wallet: await w.getAddress(),
        ok:false,
        txHash:'',
        error:`fatal: ${e.message || e}`,
        attempts:0
      };
    }
  }));

  const results = await Promise.all(jobs);

  // Write CSV
  const csvPath = path.join(OUT_DIR, 'mint-results.csv');
  await new Promise(resolve => {
    const stream = csvFormat({ headers: true });
    const ws = fs.createWriteStream(csvPath);
    stream.pipe(ws).on('finish', resolve);
    for (const r of results) {
      stream.write({
        fid: r.fid,
        wallet: r.wallet,
        ok: r.ok ? '1' : '0',
        txHash: r.txHash || '',
        error: r.error || '',
        attempts: r.attempts || 0
      });
    }
    stream.end();
  });

  console.log(`Mint-Bot done → ${csvPath}`);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.warn(`${failed.length} failed (see CSV)`);
  } else {
    console.log('All succeeded (or dry-run).');
  }
  process.exit(0);
})().catch(e => {
  console.error('Fatal', e);
  process.exit(2);
});
