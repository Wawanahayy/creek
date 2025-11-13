#!/usr/bin/env node
// repay.mjs — Creek Finance (Sui) — target fix to repay::repay<Coin<GUSD>>
// - Default langsung ke 0x8cee…e97a::repay::repay<T> sesuai tx yang sukses.
// - Kirim Coin<GUSD> hasil splitCoins (bukan u64).
// - NO MERGE: kalau 1 coin < amount, akan panggil repay beberapa kali (tiap coin) sampai tercapai.
// - Human decimals: REPAY_AMOUNT=1.23 (DECIMALS_GUSD=9 default).
// - Override: REPAY_TARGET, REPAY_MODULE/REPAY_FN, EXTRA_PACKAGES; LIST_ONLY untuk inspeksi.

import 'dotenv/config';
import fs from 'node:fs';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- ENV ----------
const FULLNODE =
  process.env.SUI_FULLNODE ||
  process.env.FULLNODE_URL ||
  getFullnodeUrl('testnet');

const RAW_PK =
  String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();

const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

// Core shared objs
const VERSION_ID = process.env.VERSION_ID || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758';
const MARKET_ID  = process.env.MARKET_ID  || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d';
const CLOCK_ID   = process.env.CLOCK_ID   || '0x0000000000000000000000000000000000000000000000000000000000000006';

// Types
const GUSD_TYPE = process.env.TYPE_GUSD || '0x5434351f2dcae30c0c4b97420475c5edc966b02fd7d0bbe19ea2220d2f623586::coin_gusd::COIN_GUSD';
const SUI_TYPE  = '0x2::sui::SUI';
const DECIMALS_GUSD = Number(process.env.DECIMALS_GUSD || '9');

// Repay params
const REPAY_MODE_RAW = (process.env.REPAY_MODE || 'amount').toLowerCase(); // amount | all | max
const REPAY_MODE = REPAY_MODE_RAW === 'max' ? 'all' : REPAY_MODE_RAW;
const REPAY_AMOUNT_HUMAN = String(process.env.REPAY_AMOUNT || process.argv[2] || '1'); // 1 GUSD by default

// Gas & retry
const GAS_BUDGET_CFG    = BigInt(process.env.GAS_BUDGET || '100000000'); // 0.1 SUI budget seperti contoh sukses
const GAS_SAFETY_BUFFER = BigInt(process.env.GAS_SAFETY || '100000');    // 0.0001 SUI
const MIN_GAS_FALLBACK  = BigInt(process.env.MIN_GAS_FALLBACK || '1000000'); // 0.001 SUI
const MAX_RETRY         = Number(process.env.RETRY_MAX || '1');
const RETRY_WAIT_MS     = Number(process.env.RETRY_WAIT_MS || '1500');
const DRYRUN            = ['1','true','yes','y','on'].includes(String(process.env.DRYRUN || '').toLowerCase());
const LIST_ONLY         = ['1','true','yes','y','on'].includes(String(process.env.LIST_ONLY || '').toLowerCase());

// Obligation preference
const ENV_OBLIGATION_ID     = (process.env.OBLIGATION_ID || '').toLowerCase();
const ENV_OBLIGATION_KEY_ID = (process.env.OBLIGATION_KEY_ID || '');

// Target overrides
const REPAY_TARGET_FROM_ENV = (process.env.REPAY_TARGET || '').trim();     // full <pkg>::<module>::<fn>
const REPAY_MODULE_OVERRIDE = (process.env.REPAY_MODULE || '').trim();     // e.g. repay
const REPAY_FN_OVERRIDE     = (process.env.REPAY_FN || '').trim();         // e.g. repay
const EXTRA_PACKAGES        = (process.env.EXTRA_PACKAGES || '').split(',').map(s=>s.trim()).filter(Boolean);

// Default target (berdasarkan tx sukses kamu)
const DEFAULT_REPAY_PKG = '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a';
const DEFAULT_REPAY_MOD = 'repay';
const DEFAULT_REPAY_FN  = 'repay';

// ---------- Helpers ----------
function parsePrivKey(raw, schemeFromEnv = String(process.env.SUI_KEY_SCHEME || '').toLowerCase()) {
  if (!raw) throw new Error('SUI_PRIVATE_KEY / PRIVATE_KEY kosong.');
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return { kp: Ed25519Keypair.fromSecretKey(secretKey),  scheme: 'ed25519' };
    if (s === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(secretKey), scheme: 'secp256k1' };
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }
  let bytes;
  if (raw.startsWith('0x')) bytes = fromHex(raw);
  else                      bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);
  if (schemeFromEnv === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

async function listCoins(client, owner, coinType) {
  let cursor = null, out = [];
  do {
    const { data, nextCursor, hasNextPage } = await client.getCoins({ owner, coinType, cursor });
    out = out.concat(data || []);
    cursor = nextCursor;
    if (!hasNextPage) break;
  } while (true);
  return out;
}
function sumBigint(coins) { return coins.reduce((a,c)=>a+BigInt(c.balance), 0n); }

async function getTypeOfObject(client, id) {
  const o = await client.getObject({ id, options: { showType: true } });
  return o?.data?.type || '';
}
function pkgFromType(typeStr) {
  const m = /^0x[0-9a-fA-F]{64}/.exec(typeStr || '');
  return m ? m[0].toLowerCase() : null;
}
function isPackageId(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }

async function ensurePackage(client, pkgId) {
  const obj = await client.getObject({ id: pkgId, options: { showBcs: true } });
  const isPkg = obj?.data?.bcs?.dataType === 'package';
  if (!isPkg) throw new Error(`ID ${pkgId} bukan package.`);
}

function parseHumanToU64(str, decimals) {
  const s = String(str).trim();
  if (s.includes('.')) {
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`REPAY_AMOUNT invalid: ${s}`);
    const [i,f=''] = s.split('.');
    if (f.length > decimals) throw new Error(`Terlalu banyak desimal (max ${decimals})`);
    return BigInt(i + f.padEnd(decimals, '0'));
  }
  if (!/^\d+$/.test(s)) throw new Error(`REPAY_AMOUNT invalid: ${s}`);
  // angka pendek → anggap human, kalikan 10^dec
  if (s.length <= (decimals+2)) return BigInt(s) * (10n ** BigInt(decimals));
  // angka “panjang” → treat as raw
  return BigInt(s);
}

async function findKeyAndObligation(client, ownerAddr) {
  if (ENV_OBLIGATION_ID) return { obligationId: ENV_OBLIGATION_ID };
  if (ENV_OBLIGATION_KEY_ID) {
    const o = await client.getObject({ id: ENV_OBLIGATION_KEY_ID, options: { showType: true, showContent: true, showOwner: true }});
    const d = o.data;
    if (!d?.content?.fields) throw new Error('OBLIGATION_KEY_ID invalid.');
    if (!d.owner || !('AddressOwner' in d.owner) || d.owner.AddressOwner.toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new Error('OBLIGATION_KEY_ID bukan milik address sender.');
    }
    const of = d.content.fields.ownership?.fields?.of;
    if (!of) throw new Error('ObligationKey tidak punya ownership.of');
    return { obligationId: String(of) };
  }
  const { data } = await client.getOwnedObjects({
    owner: ownerAddr,
    filter: { StructType: `${DEFAULT_REPAY_PKG}::obligation::ObligationKey` },
    options: { showType: true, showOwner: true, showContent: true },
  });
  if (!data.length) throw new Error('ObligationKey tidak ditemukan; jalankan deposit/borrow dulu.');
  const first = data[0];
  const of = first?.data?.content?.fields?.ownership?.fields?.of;
  if (!of) throw new Error('ObligationKey tidak memiliki ownership.of');
  return { obligationId: String(of) };
}

async function execTxCompat(client, kp, tx) {
  const built = await tx.build({ client, onlyTransactionKind: false });
  const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
  if (sim.effects?.status?.status !== 'success') {
    log.warn('[warn] dryRun:', JSON.stringify(sim.effects?.status || {}));
  } else {
    log.info('[info] dryRun: success');
  }
  const options = { showEffects: true, showEvents: true, showBalanceChanges: true };
  if (typeof client.signAndExecuteTransactionBlock === 'function') {
    return await client.signAndExecuteTransactionBlock({
      signer: kp, transactionBlock: tx, options, requestType: 'WaitForLocalExecution',
    });
  }
  if (typeof client.signAndExecuteTransaction === 'function') {
    return await client.signAndExecuteTransaction({
      signer: kp, transaction: tx, options, requestType: 'WaitForLocalExecution',
    });
  }
  throw new Error('SDK execute method tidak ditemukan');
}

// --- optional auto-discovery (fallback kalau default/override gagal) ---
function normalizeModules(mods) {
  const raw = (mods && typeof mods === 'object' && 'data' in mods) ? mods.data : mods;
  if (Array.isArray(raw)) {
    return raw.map((m) => ({
      name: m.name || m.moduleName || m.module || '(unknown)',
      exposedFunctions: m.exposedFunctions || m.functions || {},
    }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([name, mod]) => ({
      name,
      exposedFunctions: (mod && (mod.exposedFunctions || mod.functions)) || {},
    }));
  }
  throw new Error('getNormalizedMoveModulesByPackage format tidak dikenal.');
}
async function autoDiscoverRepay(client, pkgIds) {
  const entries = [];
  for (const pkg of pkgIds) {
    try {
      await ensurePackage(client, pkg);
      const modsRaw = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modules = normalizeModules(modsRaw);
      for (const m of modules) {
        for (const [fnName, fn] of Object.entries(m.exposedFunctions || {})) {
          const isEntry = !!fn.isEntry;
          const nameL = `${m.name}::${fnName}`.toLowerCase();
          if (isEntry && nameL.includes('repay')) {
            entries.push({ pkg, module: m.name, fn: fnName, params: fn.parameters || [], tps: fn.typeParameters || [] });
          }
        }
      }
    } catch (e) {
      log.warn('[warn] skip pkg', pkg, e.message || e);
    }
  }
  if (!entries.length) throw new Error('Auto-discovery: entry "repay" tidak ditemukan.');
  log.info('[info] Repay entries (auto):');
  for (const e of entries) log.info(`  - ${e.pkg} :: ${e.module}::${e.fn} [tp=${(e.tps||[]).length}] p=${(e.params||[]).length}`);
  const best = entries.find(e => e.module === 'repay' && e.fn === 'repay') || entries[0];
  return `${best.pkg}::${best.module}::${best.fn}`;
}

// ---------- MAIN ----------
(async () => {
  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== CREEK REPAY (no-merge) ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Mode     :', REPAY_MODE, REPAY_MODE === 'amount' ? `| amount=${REPAY_AMOUNT_HUMAN} (dec=${DECIMALS_GUSD})` : '');

  // Obligation(shared)
  const { obligationId } = await findKeyAndObligation(client, sender);
  log.info('Obligation (shared):', obligationId);

  // Gas clamp ala contoh sukses
  const { data: suiCoins } = await client.getCoins({ owner: sender, coinType: SUI_TYPE });
  const suiLargest = (suiCoins || []).reduce((a,b) => (!a || BigInt(b.balance) > BigInt(a.balance)) ? b : a, null);
  const suiBal = suiLargest ? BigInt(suiLargest.balance) : 0n;
  let gasBudget = GAS_BUDGET_CFG;
  if (suiBal > 0n && gasBudget >= suiBal) {
    const clamped = suiBal > GAS_SAFETY_BUFFER ? (suiBal - GAS_SAFETY_BUFFER) : 0n;
    gasBudget = clamped > 0n ? clamped : MIN_GAS_FALLBACK;
    log.warn(`[warn] GAS_BUDGET dikurangi ke ${gasBudget.toString()} (saldo SUI: ${suiBal})`);
  }

  // GUSD coins
  const gusdCoins = await listCoins(client, sender, GUSD_TYPE);
  if (!gusdCoins.length) throw new Error('Saldo GUSD kosong.');
  const totalGusd = sumBigint(gusdCoins);
  log.info('[info] Total GUSD (raw):', totalGusd.toString());

  const wantAll = (REPAY_MODE === 'all');
  let targetRaw = wantAll ? totalGusd : parseHumanToU64(REPAY_AMOUNT_HUMAN, DECIMALS_GUSD);
  if (!wantAll && totalGusd < targetRaw) throw new Error(`Saldo GUSD total (${totalGusd}) < REPAY_AMOUNT (${targetRaw})`);

  // Tentukan target function: priority — ENV full target > module+fn > default fixed > autodiscovery
  let repayTarget = REPAY_TARGET_FROM_ENV;
  if (!repayTarget && (REPAY_MODULE_OVERRIDE || REPAY_FN_OVERRIDE)) {
    repayTarget = `${DEFAULT_REPAY_PKG}::${REPAY_MODULE_OVERRIDE || DEFAULT_REPAY_MOD}::${REPAY_FN_OVERRIDE || DEFAULT_REPAY_FN}`;
  }
  if (!repayTarget) {
    // default persis log sukses
    repayTarget = `${DEFAULT_REPAY_PKG}::${DEFAULT_REPAY_MOD}::${DEFAULT_REPAY_FN}`;
  }

  // Verifikasi target; kalau gagal, auto-discover dari paket-paket related
  async function verifyOrDiscover(target) {
    try {
      const [pkgId] = target.split('::');
      await ensurePackage(client, pkgId);
      return target;
    } catch (e) {
      log.warn('[warn] target default gagal diverify, coba auto-discover:', e.message || e);
      // collect candidate pkgs dari tipe objek & EXTRA_PACKAGES
      const cands = new Set();
      try { const t = await getTypeOfObject(client, MARKET_ID); const p = pkgFromType(t); if (p) cands.add(p); } catch {}
      try { const t = await getTypeOfObject(client, VERSION_ID); const p = pkgFromType(t); if (p) cands.add(p); } catch {}
      for (const p of EXTRA_PACKAGES) if (isPackageId(p)) cands.add(p.toLowerCase());
      if (!cands.size) cands.add(DEFAULT_REPAY_PKG);
      const auto = await autoDiscoverRepay(client, Array.from(cands));
      return auto;
    }
  }

  repayTarget = await verifyOrDiscover(repayTarget);
  log.info('[info] Repay target:', repayTarget, '| coinBased= true (Coin<GUSD>)');

  if (LIST_ONLY) {
    console.log('LIST_ONLY=1 → stop (target verified):', repayTarget);
    process.exit(0);
  }

  // Build transaction(s): split coin → repay(target portion) — tanpa merge
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(Number(gasBudget));

  // Urutkan koin terbesar dulu (biar mirip contoh: 1 split dari 1 coin bila cukup)
  const byBig = gusdCoins.slice().sort((a, b) => {
    const bb = BigInt(b.balance), aa = BigInt(a.balance);
    return bb > aa ? 1 : (bb < aa ? -1 : 0);
  });

  const callRepayWithPortion = (portion) => tx.moveCall({
    target: repayTarget,
    typeArguments: [GUSD_TYPE],
    arguments: [
      tx.object(VERSION_ID),
      tx.object(obligationId),
      tx.object(MARKET_ID),
      portion,                   // Coin<GUSD>
      tx.object(CLOCK_ID),
    ],
  });

  if (wantAll) {
    // kirim semua saldo — satu call per coin (full balance)
    for (const c of byBig) {
      const bal = BigInt(c.balance);
      if (bal === 0n) continue;
      const base = tx.object(c.coinObjectId);
      const [portion] = tx.splitCoins(base, [tx.pure.u64(bal.toString())]);
      callRepayWithPortion(portion);
    }
  } else {
    let remain = targetRaw;
    for (const c of byBig) {
      if (remain === 0n) break;
      const bal = BigInt(c.balance);
      if (bal === 0n) continue;
      const take = bal >= remain ? remain : bal;
      const base = tx.object(c.coinObjectId);
      const [portion] = tx.splitCoins(base, [tx.pure.u64(take.toString())]);
      callRepayWithPortion(portion);
      remain -= take;
    }
    if (remain > 0n) throw new Error(`Internal: sisa amount ${remain} setelah iterasi koin (NO MERGE)`);
  }

  if (DRYRUN) {
    const built = await tx.build({ client, onlyTransactionKind: false });
    const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
    log.info('dryRun status:', sim.effects?.status?.status, sim.effects?.status?.error ? `| ${sim.effects.status.error}` : '');
    if (Array.isArray(sim.events) && sim.events.length) {
      log.info('events:'); for (const e of sim.events) log.info('  -', e.type, e.parsedJson || '');
    }
    process.exit(sim.effects?.status?.status === 'success' ? 0 : 1);
  }

  let err = null;
  for (let i = 1; i <= Math.max(1, MAX_RETRY); i++) {
    try {
      log.info(`execute attempt ${i}/${Math.max(1, MAX_RETRY)}…`);
      const res = await execTxCompat(client, kp, tx);
      const status = res.effects?.status?.status;
      const digest = res.digest || res.effects?.transactionDigest;
      log.info('digest:', digest);
      log.info('status:', status);
      if (status === 'success') {
        const evs = res.events || [];
        if (evs.length) {
          log.info('events:');
          for (const e of evs) log.info('  -', e.type, e.parsedJson || e);
        }
        process.exit(0);
      }
      const msg = res.effects?.status?.error || 'tx gagal';
      throw new Error(msg);
    } catch (e) {
      err = e;
      log.warn('[warn] execute error:', e?.message || e);
      if (i < Math.max(1, MAX_RETRY)) await sleep(RETRY_WAIT_MS);
    }
  }
  log.error('FATAL:', err?.message || err);
  process.exit(1);
})().catch(e => {
  log.error('FATAL:', e.message || e);
  process.exit(1);
});
