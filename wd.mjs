#!/usr/bin/env node
// wd.mjs — Creek Finance (Sui) Withdraw GR collateral (auto-detect target)
// Patch v2025-11-02:
// - Support CoinDecimalsRegistry param (DECIMALS_REGISTRY_ID)
// - Smarter entry discovery + clearer logs
// - WITHDRAW_TARGET override always respected if set
// - Minor stability tweaks (dryRun printouts, arg mismatch hints)

import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';

// ---------- LOG ----------
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

const RAW_PK = String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();
const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

const VERSION_ID = process.env.VERSION_ID || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758';
const MARKET_ID  = process.env.MARKET_ID  || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d';
const CLOCK_ID   = process.env.CLOCK_ID   || '0x0000000000000000000000000000000000000000000000000000000000000006';

// NEW: CoinDecimalsRegistry object id (REQUIRED by withdraw fn)
const DECIMALS_REGISTRY_ID = process.env.DECIMALS_REGISTRY_ID || '0x1fad8fca59ad11369f39d637e49130b62f4a315953c07ccaa132f6c04c2e1de7';

// Oracle & rule
const X_ORACLE_ID = process.env.X_ORACLE_ID || '0x9052b77605c1e2796582e996e0ce60e2780c9a440d8878a319fa37c50ca32530';
const RULE_PKG    = process.env.RULE_PKG    || '0xbd6d8bb7f40ca9921d0c61404cba6dcfa132f184cf8c0f273008a103889eb0e8';

// Types
const GR_TYPE = process.env.TYPE_GR || '0x5504354cf3dcbaf64201989bc734e97c1d89bba5c7f01ff2704c43192cc2717c::coin_gr::COIN_GR';

// Mode & amount (RAW unit, default 1e9 = 1 GR jika dec=9)
const WITHDRAW_MODE = (process.env.WITHDRAW_MODE || 'amount').toLowerCase(); // 'amount' | 'percent'
let   WITHDRAW_AMOUNT = BigInt(process.env.WITHDRAW_AMOUNT || process.argv[2] || '1000000000'); // raw
const WITHDRAW_PERCENT = Math.max(1, Math.min(99, parseInt(process.env.WITHDRAW_PERCENT || '50', 10)));

const GR_TTL = BigInt(process.env.GR_TTL || '150500000000'); // ttl untuk oracle primary price

// Gas & retry
const GAS_BUDGET = BigInt(process.env.GAS_BUDGET || '70000000');
const MIN_GAS_FALLBACK = BigInt(process.env.MIN_GAS_FALLBACK || '1000000');
const MAX_RETRY = Number(process.env.RETRY_MAX || '4');
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS || '1500');

const DRYRUN = ['1','true','yes','y','on'].includes(String(process.env.DRYRUN || '').toLowerCase());

// Obligation hints
const ENV_OBLIGATION_ID = (process.env.OBLIGATION_ID || '').toLowerCase();
const ENV_OBLIGATION_KEY_ID = (process.env.OBLIGATION_KEY_ID || '');

// Manual override target (opsional)
const WITHDRAW_TARGET_FROM_ENV = (process.env.WITHDRAW_TARGET || '').trim(); // full <pkg>::<module>::<fn>

// ---------- CONST ----------
const SUI_TYPE  = '0x2::sui::SUI';
const DEFAULT_PKG = '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a';

// ---------- HELPERS ----------
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

async function findKeyAndObligation(client, ownerAddr) {
  if (ENV_OBLIGATION_KEY_ID) {
    const o = await client.getObject({ id: ENV_OBLIGATION_KEY_ID, options: { showType: true, showContent: true, showOwner: true } });
    const d = o.data;
    if (!d?.content?.fields) throw new Error('OBLIGATION_KEY_ID invalid.');
    if (!d.owner || !('AddressOwner' in d.owner) || d.owner.AddressOwner.toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new Error('OBLIGATION_KEY_ID bukan milik address ini.');
    }
    const of = d.content.fields.ownership?.fields?.of;
    if (!of) throw new Error('ownership.of kosong pada OBLIGATION_KEY_ID.');
    const chosen = ENV_OBLIGATION_ID || String(of);
    return { keyId: d.objectId, obligationId: chosen };
  }

  const { data } = await client.getOwnedObjects({
    owner: ownerAddr,
    filter: { StructType: `${DEFAULT_PKG}::obligation::ObligationKey` },
    options: { showType: true, showOwner: true, showContent: true },
  });

  if (!data.length) throw new Error('ObligationKey (AddressOwner) tidak ditemukan. Pastikan sudah deposit (membuat key).');

  if (ENV_OBLIGATION_ID) {
    const found = data.find(x => x?.data?.content?.fields?.ownership?.fields?.of?.toLowerCase() === ENV_OBLIGATION_ID);
    if (found) return { keyId: found.data.objectId, obligationId: ENV_OBLIGATION_ID };
    log.warn('[warn] ENV_OBLIGATION_ID tidak cocok key mana pun, pakai key[0].');
  }

  const first = data[0];
  const of = first?.data?.content?.fields?.ownership?.fields?.of;
  if (!of) throw new Error('Key[0] tidak punya ownership.of');
  return { keyId: first.data.objectId, obligationId: String(of) };
}

async function getTotalBalance(client, owner, coinType) {
  const r = await client.getBalance({ owner, coinType });
  return BigInt(r.totalBalance || '0');
}

async function execTxCompat(client, kp, tx) {
  const built = await tx.build({ client, onlyTransactionKind: false });
  const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
  if (sim.effects?.status?.status !== 'success') {
    log.warn('[warn] dryRun:', JSON.stringify(sim.effects?.status || {}));
    if (sim.effects?.status?.error) log.warn('[warn] dryRun error:', sim.effects.status.error);
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

function addOracleRefreshGR(tx) {
  const req = tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::price_update_request',
    typeArguments: [GR_TYPE],
    arguments: [tx.object(X_ORACLE_ID)],
  });
  tx.moveCall({
    target: `${RULE_PKG}::rule::set_price_as_primary`,
    typeArguments: [GR_TYPE],
    arguments: [req, tx.pure.u64(GR_TTL.toString()), tx.object(CLOCK_ID)],
  });
  tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::confirm_price_update_request',
    typeArguments: [GR_TYPE],
    arguments: [tx.object(X_ORACLE_ID), req, tx.object(CLOCK_ID)],
  });
}

// ---------- TARGET DISCOVERY ----------
function isPackageId(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }
async function ensurePackage(client, pkgId) {
  const obj = await client.getObject({ id: pkgId, options: { showBcs: true } });
  const isPkg = obj?.data?.bcs?.dataType === 'package';
  if (!isPkg) throw new Error(`ID ${pkgId} bukan package.`);
}

async function typePackageOf(client, id) {
  try {
    const o = await client.getObject({ id, options: { showType: true } });
    const t = o?.data?.type;
    if (!t) return null;
    const m = /^0x[0-9a-fA-F]{64}/.exec(t);
    return m ? m[0].toLowerCase() : null;
  } catch { return null; }
}

function listEntriesFromModules(modsRaw) {
  const out = [];
  const raw = (modsRaw && modsRaw.data) || modsRaw;
  const modulesEntries = Array.isArray(raw)
    ? raw.map(m => [m.name, m.exposedFunctions || m.functions || {}])
    : Object.entries(raw || {});

  for (const [mname, mod] of modulesEntries) {
    const fns = (mod?.exposedFunctions) || (mod?.functions) || {};
    for (const [fname, fn] of Object.entries(fns)) {
      // Some indexers drop isEntry; treat *entry suffix as entry too
      const isEntry = Boolean(fn?.isEntry) || /_entry$/.test(fname);
      if (isEntry) out.push({ module: mname, fn: fname, params: fn.parameters || [], tps: fn.typeParameters || [] });
    }
  }
  return out;
}

function paramTags(params) {
  const s = JSON.stringify(params);
  return {
    hasU64: /"U64"|U64/.test(s),
    wantsVersion: /"module":"version","name":"Version"/.test(s),
    wantsObligation: /"module":"obligation","name":"Obligation"/.test(s),
    wantsObligationKey: /"module":"obligation","name":"ObligationKey"/.test(s),
    wantsMarket: /"module":"market","name":"Market"/.test(s),
    wantsClock: /"address":"0x2","module":"clock","name":"Clock"/.test(s),
    wantsOracle: /"module":"x_oracle"/.test(s),
    wantsDecimalsRegistry: /"module":"coin_decimals_registry","name":"CoinDecimalsRegistry"/.test(s),
  };
}

function scoreWithdrawEntry(e) {
  const name = `${e.module}::${e.fn}`.toLowerCase();
  let sc = 0;
  if (name.includes('withdraw')) sc += 3;
  if (name.includes('withdraw_collateral')) sc += 5;
  if (name.endsWith('withdraw') || name.endsWith('withdraw_collateral') || name.endsWith('withdraw_collateral_entry')) sc += 2;
  const t = paramTags(e.params);
  if (t.wantsVersion) sc += 1;
  if (t.wantsObligation) sc += 2;
  if (t.wantsObligationKey) sc += 2;
  if (t.wantsMarket) sc += 1;
  if (t.hasU64) sc += 1;
  if (t.wantsDecimalsRegistry) sc += 2; // matches Creek signature
  return sc;
}

async function autoDiscoverWithdrawTarget(client, candidatePkgs) {
  const found = [];
  for (const pkg of candidatePkgs) {
    try {
      await ensurePackage(client, pkg);
      const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const entries = listEntriesFromModules(mods);
      for (const e of entries) {
        const name = `${e.module}::${e.fn}`.toLowerCase();
        if (name.includes('withdraw')) found.push({ pkg, ...e, score: scoreWithdrawEntry(e) });
      }
    } catch (e) {
      log.warn('[warn] skip pkg', pkg, e.message || e);
    }
  }
  if (!found.length) throw new Error('Tidak menemukan entry withdraw pada kandidat package.');
  found.sort((a,b) => b.score - a.score);
  log.info('[info] Withdraw entries (auto):');
  for (const e of found.slice(0, 12)) {
    const tags = paramTags(e.params);
    log.info(`  - ${e.pkg} :: ${e.module}::${e.fn}  score=${e.score}  params=${(e.params||[]).length}  tps=${(e.tps||[]).length}  tags=${JSON.stringify(tags)}`);
  }
  const best = found[0];
  return { target: `${best.pkg}::${best.module}::${best.fn}`, params: best.params, tps: best.tps };
}

// Build args sesuai parameter fungsi
function buildWithdrawArgs(tx, params, ctx) {
  const args = [];
  for (const p of params) {
    const s = JSON.stringify(p);

    if (/\"module\":\"version\",\"name\":\"Version\"/.test(s)) {
      args.push(tx.object(ctx.VERSION_ID));
      continue;
    }
    if (/\"module\":\"obligation\",\"name\":\"Obligation\"/.test(s)) {
      args.push(tx.object(ctx.obligationId));
      continue;
    }
    if (/\"module\":\"obligation\",\"name\":\"ObligationKey\"/.test(s)) {
      if (!ctx.obligationKeyId) throw new Error('Fungsi butuh ObligationKey tapi tidak ditemukan/di-ENV.');
      args.push(tx.object(ctx.obligationKeyId));
      continue;
    }
    if (/\"module\":\"market\",\"name\":\"Market\"/.test(s)) {
      args.push(tx.object(ctx.MARKET_ID));
      continue;
    }
    if (/\"module\":\"coin_decimals_registry\",\"name\":\"CoinDecimalsRegistry\"/.test(s)) {
      if (!ctx.DECIMALS_REGISTRY_ID) throw new Error('Fungsi butuh CoinDecimalsRegistry — set DECIMALS_REGISTRY_ID.');
      args.push(tx.object(ctx.DECIMALS_REGISTRY_ID));
      continue;
    }
    if (/\"U64\"/.test(s) || /U64/.test(s)) {
      if (ctx.amountRaw == null) throw new Error('Fungsi butuh u64 amount tapi amountRaw tidak diset.');
      args.push(tx.pure.u64(ctx.amountRaw.toString()));
      continue;
    }
    if (/\"module\":\"x_oracle\"/.test(s)) {
      args.push(tx.object(ctx.X_ORACLE_ID));
      continue;
    }
    if (/\"address\":\"0x2\",\"module\":\"clock\",\"name\":\"Clock\"/.test(s)) {
      args.push(tx.object(ctx.CLOCK_ID));
      continue;
    }
    // TxContext is implicit
  }

  return { args };
}

// ---------- MAIN ----------
(async () => {
  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== CREEK WITHDRAW GR ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Mode     :', WITHDRAW_MODE, WITHDRAW_MODE === 'amount' ? `amount(raw)=${WITHDRAW_AMOUNT}` : `percent=${WITHDRAW_PERCENT}%`);

  const { keyId: obligationKeyId, obligationId } = await findKeyAndObligation(client, sender);
  log.info('ObligationKey (owned):', obligationKeyId);
  log.info('Obligation (shared)  :', obligationId);

  if (WITHDRAW_MODE === 'percent') {
    const totalGR = await getTotalBalance(client, sender, GR_TYPE);
    if (totalGR <= 0n) throw new Error('Saldo GR 0; tidak ada collateral yang bisa ditarik.');
    let pct = Math.max(1, Math.min(99, Math.floor(WITHDRAW_PERCENT)));
    WITHDRAW_AMOUNT = (totalGR * BigInt(pct)) / 100n;
    if (WITHDRAW_AMOUNT === 0n) WITHDRAW_AMOUNT = 1n;
    log.info('Computed amount from percent:', WITHDRAW_AMOUNT.toString(), '(of total GR', totalGR.toString(), ')');
  }

  // Gas clamp
  try {
    const { data: suiCoins } = await client.getCoins({ owner: sender, coinType: SUI_TYPE });
    const suiLargest = (suiCoins || []).reduce((a,b) => (!a || BigInt(b.balance) > BigInt(a.balance)) ? b : a, null);
    const suiBal = suiLargest ? BigInt(suiLargest.balance) : 0n;
    if (suiBal > 0n && GAS_BUDGET >= suiBal) {
      const clamped = suiBal > MIN_GAS_FALLBACK ? (suiBal - MIN_GAS_FALLBACK) : 0n;
      if (clamped > 0n) {
        log.warn(`[warn] GAS_BUDGET dikurangi ke ${clamped.toString()} (saldo SUI: ${suiBal})`);
      }
    }
  } catch {}

  // ---- pick withdraw target ----
  let chosen = null;
  if (WITHDRAW_TARGET_FROM_ENV) {
    chosen = { target: WITHDRAW_TARGET_FROM_ENV, params: null, tps: [] };
    log.info('[info] WITHDRAW_TARGET override:', chosen.target);
  }

  if (!chosen || !chosen.params) {
    const candidates = new Set();
    const p1 = await typePackageOf(client, MARKET_ID);  if (p1) candidates.add(p1);
    const p2 = await typePackageOf(client, VERSION_ID); if (p2) candidates.add(p2);
    candidates.add(DEFAULT_PKG);
    if (isPackageId(RULE_PKG)) candidates.add(RULE_PKG.toLowerCase());

    log.info('[info] Candidate packages:', Array.from(candidates).join(', '));

    try {
      chosen = await autoDiscoverWithdrawTarget(client, Array.from(candidates));
    } catch (e) {
      log.error('[error] Auto-discovery gagal:', e.message || e);
      // Fallback: known Creek path
      chosen = { target: `${DEFAULT_PKG}::withdraw_collateral::withdraw_collateral_entry`, params: null, tps: ['T0'] };
      log.warn('[warn] Fallback target:', chosen.target);
    }
  }

  log.info('[info] Withdraw target:', chosen.target);

  // Pull normalized signature for the function
  const [pkgId, moduleName, fnName] = chosen.target.split('::');
  const mods = await client.getNormalizedMoveModulesByPackage({ package: pkgId });
  const raw = (mods && mods.data) || mods;
  const mod = raw[moduleName] || raw?.find?.(m => m.name === moduleName);
  const fns = (mod?.exposedFunctions) || (mod?.functions) || {};
  const fn = fns[fnName];
  if (!fn) throw new Error('Tidak menemukan fungsi di normalized modules. Pastikan target benar.');
  const params = fn.parameters || [];
  const tps = fn.typeParameters || [];

  let amount = WITHDRAW_AMOUNT;
  let lastErr = null;

  for (let i = 1; i <= Math.max(1, MAX_RETRY); i++) {
    log.info(`-- attempt ${i}/${Math.max(1, MAX_RETRY)} amount(raw)=${amount.toString()}`);

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(Number(GAS_BUDGET || MIN_GAS_FALLBACK));

    // 1) refresh oracle GR
    addOracleRefreshGR(tx);

    // 2) build args by signature
    const ctx = {
      VERSION_ID,
      obligationId,
      obligationKeyId,
      MARKET_ID,
      amountRaw: amount,
      X_ORACLE_ID,
      CLOCK_ID,
      DECIMALS_REGISTRY_ID,
    };
    const { args } = buildWithdrawArgs(tx, params, ctx);

    // 3) call
    tx.moveCall({
      target: chosen.target,
      typeArguments: (tps && tps.length) ? [GR_TYPE] : [],
      arguments: args,
    });

    try {
      if (DRYRUN) {
        const built = await tx.build({ client, onlyTransactionKind: false });
        const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
        log.info('dryRun status:', sim.effects?.status?.status, sim.effects?.status?.error ? `| ${sim.effects.status.error}` : '');
        if (Array.isArray(sim.events) && sim.events.length) {
          log.info('events:'); for (const e of sim.events) log.info('  -', e.type, e.parsedJson || '');
        }
        process.exit(sim.effects?.status?.status === 'success' ? 0 : 1);
      }

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
      const msg = e?.message || String(e);
      lastErr = msg;
      log.warn('[warn] execute error:', msg);

      // gas problems
      if (msg.includes('Balance of gas object') || /gas/i.test(msg)) {
        log.warn('[warn] Gas low/cek GAS_BUDGET vs saldo SUI. Turunkan budget atau top-up SUI.');
        break;
      }

      // health/limit typical → shrink amount
      if (/health|limit|exceed|insufficient|cannot|over|abort|MoveAbort|EINSUFFICIENT|ELTV|ELVR/i.test(msg)) {
        let next = amount / 2n;
        if (next === 0n) {
          log.error('[error] Amount mengecil ke 0; berhenti.');
          break;
        }
        amount = next;
        await sleep(RETRY_WAIT_MS);
        continue;
      }

      // signature/arg mismatch → lapor & hentikan
      if (/Incorrect number of arguments|No function was found|Invalid type argument|Argument.*type|Entry functions cannot be called without required object/i.test(msg)) {
        log.error('[error] Signature mismatch. Cek DECIMALS_REGISTRY_ID & WITHDRAW_TARGET.');
        break;
      }

      break; // lainnya → hentikan
    }
  }

  if (lastErr) {
    log.error('FATAL:', lastErr);
    process.exit(1);
  } else {
    log.error('FATAL: Unknown execution failure.');
    process.exit(1);
  }
})().catch(e => {
  log.error('FATAL:', e.message || e);
  process.exit(1);
});
