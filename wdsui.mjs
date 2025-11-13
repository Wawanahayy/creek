#!/usr/bin/env node
// wdsui.mjs — Withdraw collateral (auto-detect; shared/immutable registry; adaptive amount finder)
// v2025-11-11-fix2

import 'dotenv/config';
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

const RAW_PK = String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();
const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

const VERSION_ID = (process.env.VERSION_ID || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758').toLowerCase();
const MARKET_ID  = (process.env.MARKET_ID  || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d').toLowerCase();
const CLOCK_ID   = (process.env.CLOCK_ID   || '0x0000000000000000000000000000000000000000000000000000000000000006').toLowerCase();

const X_ORACLE_ID = (process.env.X_ORACLE_ID || '0x9052b77605c1e2796582e996e0ce60e2780c9a440d8878a319fa37c50ca32530').toLowerCase();
const RULE_PKG    = (process.env.RULE_PKG    || '0xbd6d8bb7f40ca9921d0c61404cba6dcfa132f184cf8c0f273008a103889eb0e8').toLowerCase();

let DECIMALS_REGISTRY_ID = String(process.env.DECIMALS_REGISTRY_ID || process.env.SUI_DECIMALS_REGISTRY_ID || '').toLowerCase();
const ALLOW_REGISTRY_BEST_EFFORT = ['','1','true','yes','on'].includes(String(process.env.ALLOW_REGISTRY_BEST_EFFORT || '1').toLowerCase());

const ASSET_TYPE = (process.env.ASSET_TYPE || '0x2::sui::SUI').trim();

const WITHDRAW_MODE = (process.env.WITHDRAW_MODE || 'amount').toLowerCase(); // 'amount' | 'percent' | 'all'
let   WITHDRAW_AMOUNT = BigInt(process.env.WITHDRAW_AMOUNT || '10000000'); // default 0.01 SUI (dec=9)
let   WITHDRAW_PERCENT = Math.max(1, Math.min(100, parseInt(process.env.WITHDRAW_PERCENT || '50', 10)));
const DRAIN = ['1','true','yes','on'].includes(String(process.env.DRAIN || '0').toLowerCase());
const DRAIN_MIN_DUST = BigInt(process.env.DRAIN_MIN_DUST || '0'); // sisa dust

const ORACLE_TTL = BigInt(process.env.ORACLE_TTL || '150500000000');

const GAS_BUDGET = BigInt(process.env.GAS_BUDGET || '100000000'); // 0.1 SUI
const MIN_GAS_FALLBACK = BigInt(process.env.MIN_GAS_FALLBACK || '1000000');
const MAX_RETRY = Number(process.env.RETRY_MAX || '4');
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS || '1500');

const DRYRUN = ['1','true','yes','y','on'].includes(String(process.env.DRYRUN || '').toLowerCase());

const OBLIGATION_ID_OVERRIDE = (process.env.OBLIGATION_ID || '').toLowerCase();
const OBLIGATION_KEY_ID_OVERRIDE = (process.env.OBLIGATION_KEY_ID || '').toLowerCase();

const WITHDRAW_TARGET_FROM_ENV = (process.env.WITHDRAW_TARGET || '').trim();

const DEFAULT_PKG = '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a';
const SUI_TYPE  = '0x2::sui::SUI';
const REGISTRY_TYPE_SUFFIX = '::coin_decimals_registry::CoinDecimalsRegistry';

// ---------- helpers ----------
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

async function execTxCompat(client, kp, tx) {
  const built = await tx.build({ client, onlyTransactionKind: false });
  const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
  if (sim.effects?.status?.status !== 'success') {
    log.warn('[warn] dryRun status:', JSON.stringify(sim.effects?.status || {}));
    if (sim.effects?.status?.error) log.warn('[warn] dryRun error:', sim.effects.status.error);
  } else {
    log.info('[info] dryRun status: success');
  }
  const opt = { showEffects: true, showEvents: true, showBalanceChanges: true };
  if (typeof client.signAndExecuteTransactionBlock === 'function') {
    return await client.signAndExecuteTransactionBlock({
      signer: kp, transactionBlock: tx, options: opt, requestType: 'WaitForLocalExecution',
    });
  }
  if (typeof client.signAndExecuteTransaction === 'function') {
    return await client.signAndExecuteTransaction({
      signer: kp, transaction: tx, options: opt, requestType: 'WaitForLocalExecution',
    });
  }
  throw new Error('Tidak menemukan method eksekusi Sui SDK yang cocok');
}

function addOracleRefreshForAsset(tx, assetType) {
  const req = tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::price_update_request',
    typeArguments: [assetType],
    arguments: [tx.object(X_ORACLE_ID)],
  });
  tx.moveCall({
    target: `${RULE_PKG}::rule::set_price_as_primary`,
    typeArguments: [assetType],
    arguments: [req, tx.pure.u64(ORACLE_TTL.toString()), tx.object(CLOCK_ID)],
  });
  tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::confirm_price_update_request',
    typeArguments: [assetType],
    arguments: [tx.object(X_ORACLE_ID), req, tx.object(CLOCK_ID)],
  });
}

function isPackageId(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }

// owner kind helper
async function getOwnerKind(client, id) {
  try {
    const o = await client.getObject({ id, options: { showOwner: true, showType: true } });
    const owner = o?.data?.owner;
    if (!owner) return null;
    if (owner.Shared) return 'Shared';
    if (owner.Immutable) return 'Immutable';
    if (owner.AddressOwner) return 'AddressOwner';
    if (owner.ObjectOwner) return 'ObjectOwner';
    return null;
  } catch { return null; }
}

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
  if (t.wantsDecimalsRegistry) sc += 2;
  return sc;
}

async function autoDiscoverWithdrawTargets(client, candidatePkgs) {
  const found = [];
  for (const pkg of candidatePkgs) {
    try {
      await ensurePackage(client, pkg);
      const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const entries = listEntriesFromModules(mods);
      for (const e of entries) {
        const name = `${e.module}::${e.fn}`.toLowerCase();
        if (name.includes('withdraw')) {
          const tags = paramTags(e.params);
          found.push({ pkg, ...e, score: scoreWithdrawEntry(e), tags });
        }
      }
    } catch (e) {
      log.warn('[warn] skip pkg', pkg, e.message || e);
    }
  }
  if (!found.length) throw new Error('Tidak menemukan entry withdraw pada kandidat package.');
  found.sort((a,b) => b.score - a.score);
  log.info('[info] Withdraw entries (auto):');
  for (const e of found.slice(0, 12)) {
    log.info(`  - ${e.pkg} :: ${e.module}::${e.fn}  score=${e.score}  params=${(e.params||[]).length}  tps=${(e.tps||[]).length}  tags=${JSON.stringify(e.tags)}`);
  }
  return found;
}

function buildWithdrawArgs(tx, params, ctx) {
  const args = [];
  for (const p of params) {
    const s = JSON.stringify(p);
    if (/\"module\":\"version\",\"name\":\"Version\"/.test(s)) { args.push(tx.object(ctx.VERSION_ID)); continue; }
    if (/\"module\":\"obligation\",\"name\":\"Obligation\"/.test(s)) { args.push(tx.object(ctx.obligationId)); continue; }
    if (/\"module\":\"obligation\",\"name\":\"ObligationKey\"/.test(s)) {
      if (!ctx.obligationKeyId) throw new Error('Fungsi butuh ObligationKey tapi tidak ditemukan/di-ENV.');
      args.push(tx.object(ctx.obligationKeyId)); continue;
    }
    if (/\"module\":\"market\",\"name\":\"Market\"/.test(s)) { args.push(tx.object(ctx.MARKET_ID)); continue; }
    if (/\"module\":\"coin_decimals_registry\",\"name\":\"CoinDecimalsRegistry\"/.test(s)) {
      if (!ctx.DECIMALS_REGISTRY_ID) throw new Error('Fungsi butuh CoinDecimalsRegistry — set DECIMALS_REGISTRY_ID.');
      args.push(tx.object(ctx.DECIMALS_REGISTRY_ID)); continue;
    }
    if (/\"U64\"/.test(s) || /U64/.test(s)) {
      if (ctx.amountRaw == null) throw new Error('Fungsi butuh u64 amount tapi amountRaw tidak diset.');
      args.push(tx.pure.u64(ctx.amountRaw.toString())); continue;
    }
    if (/\"module\":\"x_oracle\"/.test(s)) { args.push(tx.object(ctx.X_ORACLE_ID)); continue; }
    if (/\"address\":\"0x2\",\"module\":\"clock\",\"name\":\"Clock\"/.test(s)) { args.push(tx.object(ctx.CLOCK_ID)); continue; }
  }
  return { args };
}

// ----- Obligation / Collateral -----
async function getAllObligationKeys(client, owner) {
  const typeStr = `${DEFAULT_PKG}::obligation::ObligationKey`;
  let cursor = null;
  const out = [];
  do {
    const { data, nextCursor, hasNextPage } = await client.getOwnedObjects({
      owner,
      filter: { StructType: typeStr },
      options: { showContent: true, showType: true, showOwner: true },
      cursor,
    });
    for (const it of (data || [])) {
      const id = it.data?.objectId;
      const ver = it.data?.version || '0';
      const of  = it.data?.content?.fields?.ownership?.fields?.of;
      if (id && of) out.push({ keyId: id, obligationId: String(of), version: ver });
    }
    cursor = nextCursor;
    if (!hasNextPage) break;
  } while (true);

  out.sort((a,b)=> {
    const av = BigInt(a.version || '0'); const bv = BigInt(b.version || '0');
    return (bv > av) ? 1 : (bv < av ? -1 : 0);
  });
  return out;
}

// attempt to scan bags (best effort)
async function extractPossibleParentIdsFromContent(content) {
  const parents = new Set();
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (v.fields?.id?.id && typeof v.fields.id.id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.fields.id.id)) {
      parents.add(v.fields.id.id.toLowerCase());
    }
    for (const [k,val] of Object.entries(v)) {
      if (k === 'id' && typeof val === 'string' && /^0x[0-9a-fA-F]{64}$/.test(val)) parents.add(val.toLowerCase());
      if (k.toLowerCase().includes('bag') || k.toLowerCase().includes('table') || k.toLowerCase().includes('collateral')) {
        const inner = val?.id || val?.fields?.id?.id;
        if (typeof inner === 'string' && /^0x[0-9a-fA-F]{64}$/.test(inner)) parents.add(inner.toLowerCase());
      }
      if (typeof val === 'object') walk(val);
    }
  }
  walk(content);
  return Array.from(parents);
}
async function findAssetCollateralUnderParent(client, parentId, assetType) {
  try {
    const fields = await client.getDynamicFields({ parentId });
    for (const df of fields.data || []) {
      try {
        const obj = await client.getObject({ id: df.objectId, options: { showType: true, showContent: true } });
        const t = obj?.data?.type || '';
        if (!/::dynamic_field::Field</.test(t) || !/obligation_collaterals::Collateral/.test(t)) continue;
        const nameStr =
          obj?.data?.content?.fields?.name?.fields?.name ||
          obj?.data?.content?.fields?.name?.name || '';
        if (typeof nameStr === 'string' && nameStr.includes(assetType)) {
          const val = obj?.data?.content?.fields?.value?.fields || {};
          const amt = val.amount ?? val.balance ?? val.total ?? '0';
          const available = BigInt(String(amt));
          return { ok: true, available };
        }
      } catch {}
    }
    return { ok: false };
  } catch { return { ok: false }; }
}
async function findAssetCollateralUnderObligation(client, obligationId, assetType) {
  try {
    const o = await client.getObject({ id: obligationId, options: { showContent: true, showType: true } });
    const content = o?.data?.content;
    if (!content?.fields) return { hasAsset: false };
    const parents = await extractPossibleParentIdsFromContent(content);
    parents.unshift(obligationId.toLowerCase());
    for (const pid of parents) {
      const r = await findAssetCollateralUnderParent(client, pid, assetType);
      if (r.ok) return { hasAsset: true, available: r.available };
    }
    return { hasAsset: false };
  } catch { return { hasAsset: false }; }
}
async function pickObligationWithAssetCollateral(client, owner, assetType) {
  if (OBLIGATION_KEY_ID_OVERRIDE && OBLIGATION_ID_OVERRIDE) {
    return { keyId: OBLIGATION_KEY_ID_OVERRIDE, obligationId: OBLIGATION_ID_OVERRIDE, available: null };
  }
  const keys = await getAllObligationKeys(client, owner);
  if (!keys.length) throw new Error('Tidak ada ObligationKey di wallet. Lakukan deposit dulu.');

  if (OBLIGATION_KEY_ID_OVERRIDE) {
    const found = keys.find(k => k.keyId.toLowerCase() === OBLIGATION_KEY_ID_OVERRIDE);
    if (!found) throw new Error('OBLIGATION_KEY_ID tidak ditemukan di wallet.');
    return { keyId: found.keyId, obligationId: found.obligationId, available: null };
  }
  if (OBLIGATION_ID_OVERRIDE) {
    const match = keys.find(k => k.obligationId.toLowerCase() === OBLIGATION_ID_OVERRIDE);
    if (match) return { keyId: match.keyId, obligationId: match.obligationId, available: null };
    log.warn('[warn] ENV OBLIGATION_ID tidak cocok key mana pun; lanjut auto-scan.');
  }

  let chosen = null;
  for (const k of keys) {
    const info = await findAssetCollateralUnderObligation(client, k.obligationId, assetType);
    if (info.hasAsset) {
      const now = info.available ?? 0n;
      if (!chosen || (now > (chosen.available ?? 0n))) chosen = { ...k, available: now };
    }
  }
  if (chosen) return { keyId: chosen.keyId, obligationId: chosen.obligationId, available: chosen.available ?? null };

  log.warn('[warn] Tidak menemukan Collateral untuk aset tersebut via bag scan. Pakai key terbaru sebagai fallback.');
  const newest = keys[0];
  return { keyId: newest.keyId, obligationId: newest.obligationId, available: null };
}

// ----- Registry auto (now filters to Shared/Immutable) -----
async function getObjectType(client, id) {
  try {
    const o = await client.getObject({ id, options: { showType: true } });
    return o?.data?.type || null;
  } catch { return null; }
}
async function scanDynamicChildren(client, parentId) {
  try {
    const out = [];
    const fields = await client.getDynamicFields({ parentId });
    for (const df of fields.data || []) {
      out.push(df.objectId.toLowerCase());
      try {
        const obj = await client.getObject({ id: df.objectId, options: { showType: true, showContent: true } });
        const inner = obj?.data?.content?.fields?.value?.fields?.id?.id;
        if (typeof inner === 'string' && /^0x[0-9a-fA-F]{64}$/.test(inner)) out.push(inner.toLowerCase());
      } catch {}
    }
    return out;
  } catch { return []; }
}
function collectLikelyIdsFromContent(content) {
  const ids = new Set();
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (v.id && typeof v.id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.id)) ids.add(v.id.toLowerCase());
    if (v.fields?.id?.id && typeof v.fields.id.id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.fields.id.id)) ids.add(v.fields.id.id.toLowerCase());
    for (const [k,val] of Object.entries(v)) {
      if (/decimal|registry/i.test(k)) {
        const maybe = (val?.id?.id) || val?.id;
        if (typeof maybe === 'string' && /^0x[0-9a-fA-F]{64}$/.test(maybe)) ids.add(maybe.toLowerCase());
      }
      if (typeof val === 'object') walk(val);
    }
  }
  walk(content);
  return Array.from(ids);
}
async function autoFindRegistryCandidates(client) {
  const candidates = new Set();
  if (DECIMALS_REGISTRY_ID) candidates.add(DECIMALS_REGISTRY_ID);
  const tV = await getObjectType(client, VERSION_ID); if (tV && tV.includes(REGISTRY_TYPE_SUFFIX)) candidates.add(VERSION_ID);
  const tM = await getObjectType(client, MARKET_ID);  if (tM && tM.includes(REGISTRY_TYPE_SUFFIX)) candidates.add(MARKET_ID);
  for (const root of [VERSION_ID, MARKET_ID]) {
    const dfs = await scanDynamicChildren(client, root); dfs.forEach(x => candidates.add(x));
  }
  for (const root of [VERSION_ID, MARKET_ID]) {
    try {
      const obj = await client.getObject({ id: root, options: { showContent: true } });
      const ids = collectLikelyIdsFromContent(obj?.data?.content || {}); ids.forEach(x => candidates.add(x));
    } catch {}
  }
  const arr = Array.from(candidates);
  // prioritize exact type + Shared/Immutable owners
  const prioritized = [];
  const others = [];
  for (const id of arr) {
    const t = await getObjectType(client, id);
    const own = await getOwnerKind(client, id);
    const isReg = t && t.includes(REGISTRY_TYPE_SUFFIX);
    const okOwner = own === 'Shared' || own === 'Immutable';
    if (isReg && okOwner) prioritized.push(id);
    else others.push({ id, t: t || '', own: own || '' });
  }
  if (!prioritized.length) {
    // fallback: try any Shared/Immutable object that looks like registry type
    const sharedLookalike = others.filter(o => (o.own === 'Shared' || o.own === 'Immutable') && o.t.includes('coin_decimals_registry'));
    return sharedLookalike.map(x => x.id).slice(0, 64);
  }
  return prioritized.slice(0, 64);
}

async function tryPickWorkingRegistry(client, sender, withdrawTarget, tps, params, ctxBase, candidates, assetType) {
  for (const cand of candidates) {
    try {
      const ownerKind = await getOwnerKind(client, cand);
      if (!(ownerKind === 'Shared' || ownerKind === 'Immutable')) {
        log.debug('[debug] skip registry (owner not shared/immutable):', cand, ownerKind);
        continue;
      }
      const tx = new Transaction();
      tx.setSender(sender);
      tx.setGasBudget(Number(GAS_BUDGET || MIN_GAS_FALLBACK));
      addOracleRefreshForAsset(tx, assetType);
      const ctx = { ...ctxBase, DECIMALS_REGISTRY_ID: cand };
      const { args } = buildWithdrawArgs(tx, params, { ...ctx, amountRaw: 1n });
      tx.moveCall({ target: withdrawTarget, typeArguments: (tps && tps.length) ? [assetType] : [], arguments: args });
      const built = await tx.build({ client, onlyTransactionKind: false });
      const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
      const ok = sim.effects?.status?.status === 'success';
      const err = sim.effects?.status?.error || '';
      if (ok) { log.info('[info] Registry OK via dryRun:', cand); return cand; }
      if (/(limit|health|ELTV|ELVR|insufficient|cannot|over|MoveAbort)/i.test(err)) {
        log.info('[info] Registry accepted (dryRun err non-registry):', cand, '|', err);
        return cand;
      }
      log.debug('[debug] registry candidate rejected by dryRun:', cand, err);
    } catch (e) {
      log.debug('[debug] registry candidate error:', cand, e?.message || e);
    }
  }
  return null;
}

// probe one entry with amount
async function probeEntry(client, sender, entry, amountRaw, registryIdNullable, assetType, ctxFixed) {
  const [pkgId, moduleName, fnName] = [`${entry.pkg}`, `${entry.module}`, `${entry.fn}`];
  const target = `${pkgId}::${moduleName}::${fnName}`;
  const mods = await client.getNormalizedMoveModulesByPackage({ package: pkgId });
  const raw = (mods && mods.data) || mods;
  const mod = raw[moduleName] || raw?.find?.(m => m.name === moduleName);
  const fns = (mod?.exposedFunctions) || (mod?.functions) || {};
  const fn = fns[fnName];
  const params = fn?.parameters || [];
  const tps = fn?.typeParameters || [];

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(Number(GAS_BUDGET || MIN_GAS_FALLBACK));
  addOracleRefreshForAsset(tx, assetType);
  const ctx = { ...ctxFixed, DECIMALS_REGISTRY_ID: registryIdNullable || undefined, amountRaw };
  const { args } = buildWithdrawArgs(tx, params, ctx);
  tx.moveCall({ target, typeArguments: (tps && tps.length) ? [assetType] : [], arguments: args });

  const built = await tx.build({ client, onlyTransactionKind: false });
  const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
  const ok = sim.effects?.status?.status === 'success';
  const err = sim.effects?.status?.error || '';

  return { ok, err, target, params, tps, entry, amountRaw };
}

// adaptive max finder (when available unknown or mode=all/percent)
async function findMaxWithdrawable(client, sender, selected, registryId, assetType, ctxFixed, startGuess = 1_000_000n, capGuess = 50_000_000_000n) {
  // 1) grow exponentially until first fail
  let lo = 0n;
  let hi = startGuess;
  while (hi <= capGuess) {
    const p = await probeEntry(client, sender, selected, hi, registryId, assetType, ctxFixed);
    if (p.ok) { lo = hi; hi = hi * 2n; }
    else if (/(health|limit|ELTV|ELVR|insufficient|cannot|over|MoveAbort|EINSUFFICIENT)/i.test(p.err)) break;
    else break; // other errors -> stop and use lo
  }
  if (lo === 0n) return 0n;
  // 2) binary search between lo..hi-1
  let L = lo, R = hi - 1n, best = lo;
  while (L <= R) {
    const mid = (L + R) >> 1n;
    const p = await probeEntry(client, sender, selected, mid, registryId, assetType, ctxFixed);
    if (p.ok) { best = mid; L = mid + 1n; }
    else if (/(health|limit|ELTV|ELVR|insufficient|cannot|over|MoveAbort|EINSUFFICIENT)/i.test(p.err)) { R = mid - 1n; }
    else { R = mid - 1n; } // treat as fail
  }
  return best;
}

// ---------- MAIN ----------
(async () => {
  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== WITHDRAW COLLATERAL ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Version  :', VERSION_ID);
  log.info('Market   :', MARKET_ID);
  log.info('Oracle   :', X_ORACLE_ID);
  log.info('RuleSto  :', RULE_PKG);
  log.info('Clock    :', CLOCK_ID);
  log.info('Asset    :', ASSET_TYPE);
  if (WITHDRAW_MODE === 'amount') log.info('Mode     :', 'amount', `amount(raw)=${WITHDRAW_AMOUNT}`);
  if (WITHDRAW_MODE === 'percent') log.info('Mode     :', 'percent', `percent=${WITHDRAW_PERCENT}%`);
  if (WITHDRAW_MODE === 'all') log.info('Mode     :', 'all', `drain=${DRAIN ? 'yes' : 'no'}`);

  // pick obligation
  const pick = await pickObligationWithAssetCollateral(client, sender, ASSET_TYPE);
  const obligationKeyId = pick.keyId;
  const obligationId = pick.obligationId;
  const available = pick.available;

  // initial amount target (may be adjusted later)
  let desired = WITHDRAW_AMOUNT;
  if (WITHDRAW_MODE === 'percent') {
    if (available == null) {
      log.warn('[warn] Tidak bisa baca available; percent mode akan pakai adaptive finder.');
    } else {
      let pct = Math.max(1, Math.min(100, Math.floor(WITHDRAW_PERCENT)));
      desired = (available * BigInt(pct)) / 100n;
      if (desired === 0n) desired = 1n;
    }
  } else if (WITHDRAW_MODE === 'all') {
    desired = available ?? 0n; // if unknown, adaptive finder will handle
  }
  if (available != null && desired > available) {
    log.warn(`[warn] desired(${desired}) > available(${available}); di-clamp ke available.`);
    desired = available;
  }

  log.info(`Picked key=${obligationKeyId} obligation=${obligationId} available=${available == null ? 'unknown' : available.toString()}`);

  // candidates pkgs
  const candidatePkgs = new Set();
  const p1 = await typePackageOf(client, MARKET_ID);  if (p1) candidatePkgs.add(p1);
  const p2 = await typePackageOf(client, VERSION_ID); if (p2) candidatePkgs.add(p2);
  candidatePkgs.add(DEFAULT_PKG);
  if (isPackageId(RULE_PKG)) candidatePkgs.add(RULE_PKG.toLowerCase());

  let allEntries = [];
  if (WITHDRAW_TARGET_FROM_ENV) {
    const [pkgId, moduleName, fnName] = WITHDRAW_TARGET_FROM_ENV.split('::');
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkgId });
    const raw = (mods && mods.data) || mods;
    const mod = raw[moduleName] || raw?.find?.(m => m.name === moduleName);
    const fns = (mod?.exposedFunctions) || (mod?.functions) || {};
    const fn = fns[fnName];
    if (!fn) throw new Error('WITHDRAW_TARGET tidak ditemukan di normalized modules.');
    allEntries = [{ pkg: pkgId, module: moduleName, fn: fnName, params: fn.parameters || [], tps: fn.typeParameters || [], tags: paramTags(fn.parameters || []), score: 999 }];
  } else {
    allEntries = await autoDiscoverWithdrawTargets(client, Array.from(candidatePkgs));
  }

  const withReg = allEntries.filter(e => e.tags.wantsDecimalsRegistry);
  const noReg  = allEntries.filter(e => !e.tags.wantsDecimalsRegistry);

  // choose entry
  let selected = null;
  let selectedRegistry = null;

  // prefer with-registry (proper type + shared/immutable)
  if (withReg.length) {
    const top = withReg[0];
    const withdrawTarget = `${top.pkg}::${top.module}::${top.fn}`;
    // collect candidates (filtered to shared/immutable)
    let registryCandidates = [];
    if (DECIMALS_REGISTRY_ID) {
      const ow = await getOwnerKind(client, DECIMALS_REGISTRY_ID);
      if (ow === 'Shared' || ow === 'Immutable') registryCandidates = [DECIMALS_REGISTRY_ID];
      else log.warn('[warn] DECIMALS_REGISTRY_ID owner bukan Shared/Immutable; diabaikan:', ow);
    }
    if (!registryCandidates.length) {
      registryCandidates = await autoFindRegistryCandidates(client);
      if (registryCandidates.length) log.info('[info] Registry candidates (filtered):', registryCandidates.join(', '));
    }
    if (registryCandidates.length) {
      const baseCtx = { VERSION_ID, obligationId, obligationKeyId, MARKET_ID, X_ORACLE_ID, CLOCK_ID };
      const workingRegistry = await tryPickWorkingRegistry(
        client, sender, withdrawTarget, top.tps, top.params, baseCtx, registryCandidates, ASSET_TYPE
      );
      if (workingRegistry) {
        DECIMALS_REGISTRY_ID = workingRegistry;
        selected = top;
        selectedRegistry = workingRegistry;
        log.info('DecimalsRegistry :', DECIMALS_REGISTRY_ID);
      } else if (ALLOW_REGISTRY_BEST_EFFORT) {
        DECIMALS_REGISTRY_ID = registryCandidates[0];
        selected = top;
        selectedRegistry = DECIMALS_REGISTRY_ID;
        log.warn('[warn] Semua kandidat gagal dry-run; BEST-EFFORT pakai kandidat teratas:', DECIMALS_REGISTRY_ID);
      }
    }
  }

  // if still not selected → try no-reg entries
  if (!selected && noReg.length) {
    for (const entry of noReg) {
      try {
        const baseCtx = { VERSION_ID, obligationId, obligationKeyId, MARKET_ID, X_ORACLE_ID, CLOCK_ID };
        const probe = await probeEntry(client, sender, entry, 1n, null, ASSET_TYPE, baseCtx);
        if (probe.ok || /(limit|health|ELTV|ELVR|insufficient|cannot|over|MoveAbort)/i.test(probe.err)) {
          log.info('[info] Pakai entry tanpa registry:', `${entry.pkg}::${entry.module}::${entry.fn}`);
          selected = entry;
          selectedRegistry = null;
          break;
        }
      } catch {}
    }
  }

  if (!selected) {
    log.error('FATAL: Tidak ada entry withdraw yang valid (dengan/ tanpa registry).');
    log.error('Hint: set DECIMALS_REGISTRY_ID=<object_id> (Shared/Immutable) atau set ALLOW_REGISTRY_BEST_EFFORT=1.');
    process.exit(1);
  }

  // gas clamp (soft)
  try {
    const { data: suiCoins } = await client.getCoins({ owner: sender, coinType: SUI_TYPE });
    const suiLargest = (suiCoins || []).reduce((a,b) => (!a || BigInt(b.balance) > BigInt(a.balance)) ? b : a, null);
    const suiBal = suiLargest ? BigInt(suiLargest.balance) : 0n;
    if (suiBal > 0n && GAS_BUDGET >= suiBal) {
      const clamped = suiBal > MIN_GAS_FALLBACK ? (suiBal - MIN_GAS_FALLBACK) : 0n;
      if (clamped > 0n) log.warn(`[warn] GAS_BUDGET dikurangi ke ${clamped.toString()} (saldo SUI: ${suiBal})`);
    }
  } catch {}

  // adaptive desired if unknown/percent/all
  const fixedCtx = { VERSION_ID, obligationId, obligationKeyId, MARKET_ID, X_ORACLE_ID, CLOCK_ID };

  async function runOnce(amountRaw) {
    const [pkgId, moduleName, fnName] = [`${selected.pkg}`, `${selected.module}`, `${selected.fn}`];
    const mods = await client.getNormalizedMoveModulesByPackage({ package: pkgId });
    const raw = (mods && mods.data) || mods;
    const mod = raw[moduleName] || raw?.find?.(m => m.name === moduleName);
    const fns = (mod?.exposedFunctions) || (mod?.functions) || {};
    const fn = fns[fnName];
    if (!fn) throw new Error('Target withdraw hilang saat eksekusi.');
    const params = fn.parameters || [];
    const tps = fn.typeParameters || [];

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(Number(GAS_BUDGET || MIN_GAS_FALLBACK));
    addOracleRefreshForAsset(tx, ASSET_TYPE);

    const ctx = { ...fixedCtx, amountRaw, DECIMALS_REGISTRY_ID: selectedRegistry || undefined };
    const { args } = buildWithdrawArgs(tx, params, ctx);

    tx.moveCall({
      target: `${pkgId}::${moduleName}::${fnName}`,
      typeArguments: (tps && tps.length) ? [ASSET_TYPE] : [],
      arguments: args,
    });

    if (DRYRUN) {
      const built = await tx.build({ client, onlyTransactionKind: false });
      const sim = await client.dryRunTransactionBlock({ transactionBlock: built });
      log.info('dryRun status:', sim.effects?.status?.status, sim.effects?.status?.error ? `| ${sim.effects.status.error}` : '');
      if (Array.isArray(sim.events) && sim.events.length) {
        log.info('events:'); for (const e of sim.events) log.info('  -', e.type, e.parsedJson || '');
      }
      return { status: sim.effects?.status?.status === 'success' ? 'success' : 'fail', digest: '(dryrun)' };
    }

    const res = await execTxCompat(client, kp, tx);
    const status = res.effects?.status?.status;
    const digest = res.digest || res.effects?.transactionDigest;
    log.info('digest:', digest);
    log.info('status:', status);
    if (status !== 'success') {
      const msg = res.effects?.status?.error || 'tx gagal';
      throw new Error(msg);
    }
    const evs = res.events || [];
    if (evs.length) {
      log.info('events:');
      for (const e of evs) log.info('  -', e.type, e.parsedJson || e);
    }
    return { status: 'success', digest };
  }

  // decide final amount
  let amountNow = desired;

  if (amountNow == null || amountNow === 0n || WITHDRAW_MODE === 'all' || (WITHDRAW_MODE === 'percent' && available == null)) {
    // start guess: 0.001 SUI, grow up
    amountNow = await findMaxWithdrawable(client, sender, selected, selectedRegistry, ASSET_TYPE, fixedCtx, 1_000_000n, 100_000_000_000n);
    if (amountNow === 0n) {
      log.error('[error] Tidak menemukan amount yang valid via probing. Coba set WITHDRAW_AMOUNT manual.');
      process.exit(1);
    }
    log.info('[info] Max withdrawable (via probe):', amountNow.toString());
  }

  // main attempt(s) + optional drain
  let lastErr = null;

  async function attemptWithBackoff(amountRaw) {
    for (let i = 1; i <= Math.max(1, MAX_RETRY); i++) {
      log.info(`-- attempt ${i}/${Math.max(1, MAX_RETRY)} want=${amountRaw.toString()} key=${obligationKeyId} obl=${obligationId}`);
      try {
        const r = await runOnce(amountRaw);
        if (r.status === 'success') return true;
      } catch (e) {
        const msg = e?.message || String(e);
        lastErr = msg;
        log.warn('[warn] execute error:', msg);
        if (msg.includes('Balance of gas object') || /gas/i.test(msg)) {
          log.warn('[warn] Gas low/cek GAS_BUDGET vs saldo SUI. Turunkan budget atau top-up SUI.');
          return false;
        }
        if (/health|limit|exceed|insufficient|cannot|over|abort|MoveAbort|EINSUFFICIENT|ELTV|ELVR|not enough/i.test(msg)) {
          let next = amountRaw / 2n;
          if (next === 0n) { log.error('[error] Amount mengecil ke 0; berhenti.'); return false; }
          amountRaw = next;
          await sleep(RETRY_WAIT_MS);
          continue;
        }
        return false;
      }
    }
    return false;
  }

  // first attempt with amountNow
  const okFirst = await attemptWithBackoff(amountNow);
  if (!okFirst) {
    if (lastErr) {
      log.error('FATAL:', lastErr);
      if (!selectedRegistry) log.warn('Note: entry tanpa registry.');
      else log.warn('Note: entry butuh registry:', selectedRegistry);
    } else {
      log.error('FATAL: Unknown execution failure.');
    }
    process.exit(1);
  }

  // drain loop if requested
  if (DRAIN || (WITHDRAW_MODE === 'all') || (WITHDRAW_MODE === 'percent' && WITHDRAW_PERCENT === 100)) {
    log.info('[info] Drain mode aktif — lanjut WD berulang sampai habis/dust...');
    while (true) {
      const nextMax = await findMaxWithdrawable(client, sender, selected, selectedRegistry, ASSET_TYPE, fixedCtx, 1_000_000n, 100_000_000_000n);
      if (nextMax === 0n || nextMax <= DRAIN_MIN_DUST) {
        log.info('[info] Drain selesai. sisa <= dust:', nextMax.toString());
        break;
      }
      const ok = await attemptWithBackoff(nextMax);
      if (!ok) { log.warn('[warn] Drain berhenti karena tx gagal.'); break; }
      await sleep(500); // small pause
    }
  }

  process.exit(0);
})().catch(e => {
  log.error('FATAL:', e.message || e);
  process.exit(1);
});
