#!/usr/bin/env node
// borrow.mjs — Creek Finance (Sui) Borrow bot (auto-bind ObligationKey ↔ Obligation)
// Patch: Auto-clamp GAS_BUDGET + optional auto-merge SUI gas coins.

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

const RAW_PK =
  String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();

const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

const X_ORACLE_ID = process.env.X_ORACLE_ID || '0x9052b77605c1e2796582e996e0ce60e2780c9a440d8878a319fa37c50ca32530';
const DECIMALS_REG = process.env.DECIMALS_REG || '0x3a865c5bc0e47efc505781598396d75b647e4f1218359e89b08682519c3ac060';
const VERSION_ID   = process.env.VERSION_ID   || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758';
const MARKET_ID    = process.env.MARKET_ID    || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d';
const CLOCK_ID     = process.env.CLOCK_ID     || '0x0000000000000000000000000000000000000000000000000000000000000006';

// Token types + rule pkg
const GR_TYPE   = process.env.TYPE_GR   || '0x5504354cf3dcbaf64201989bc734e97c1d89bba5c7f01ff2704c43192cc2717c::coin_gr::COIN_GR';
const GUSD_TYPE = process.env.TYPE_GUSD || '0x5434351f2dcae30c0c4b97420475c5edc966b02fd7d0bbe19ea2220d2f623586::coin_gusd::COIN_GUSD';
const RULE_PKG  = process.env.RULE_PKG  || '0xbd6d8bb7f40ca9921d0c61404cba6dcfa132f184cf8c0f273008a103889eb0e8';

// Amount & TTL (contoh dari tx sukses kamu)
const BORROW_AMOUNT = BigInt(process.env.BORROW_AMOUNT || process.argv[2] || '10000000000'); // 10 GUSD
const GR_TTL        = BigInt(process.env.GR_TTL   || '150500000000');
const GUSD_TTL      = BigInt(process.env.GUSD_TTL || '1050000000');

// Gas & Retry
const GAS_BUDGET_CFG    = BigInt(process.env.GAS_BUDGET || '100000000'); // default 0.1 SUI
const MAX_RETRY         = Number(process.env.RETRY_MAX || '1');
const RETRY_WAIT_MS     = Number(process.env.RETRY_WAIT_MS || '1500');
const AUTO_MERGE_SUI    = ['1','true','yes','y','on'].includes(String(process.env.AUTO_MERGE_SUI || '').toLowerCase());
const GAS_SAFETY_BUFFER = BigInt(process.env.GAS_SAFETY || '100000');    // 0.0001 SUI buffer
const MIN_GAS_FALLBACK  = BigInt(process.env.MIN_GAS_FALLBACK || '1000000'); // 0.001 SUI minimal

const DRYRUN        = ['1','true','yes','y','on'].includes(String(process.env.DRYRUN || '').toLowerCase());

// Preferensi dari env (opsional)
const ENV_OBLIGATION_ID = (process.env.OBLIGATION_ID || '').toLowerCase();
const ENV_OBLIGATION_KEY_ID = (process.env.OBLIGATION_KEY_ID || '');

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

/**
 * Cari pasangan (ObligationKey owned by sender) ⇄ (Obligation shared id "of").
 */
async function findKeyAndObligation(client, ownerAddr) {
  // ENV key?
  if (ENV_OBLIGATION_KEY_ID) {
    const o = await client.getObject({ id: ENV_OBLIGATION_KEY_ID, options: { showType: true, showContent: true, showOwner: true } });
    const d = o.data;
    if (!d?.content?.fields) throw new Error('OBLIGATION_KEY_ID tidak ditemukan/invalid content.');
    if (!d.owner || !('AddressOwner' in d.owner) || d.owner.AddressOwner.toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new Error('OBLIGATION_KEY_ID bukan milik address sender.');
    }
    const of = d.content.fields.ownership?.fields?.of;
    if (!of) throw new Error('OBLIGATION_KEY_ID tidak punya ownership.of');
    const chosenObligationId = ENV_OBLIGATION_ID || String(of);
    if (ENV_OBLIGATION_ID && chosenObligationId.toLowerCase() !== ENV_OBLIGATION_ID) {
      log.warn('[warn] OBLI_ID env ≠ key.of — pakai key.of:', of);
    }
    return { keyId: d.objectId, obligationId: chosenObligationId };
  }

  // Ambil semua ObligationKey milik sender
  const { data } = await client.getOwnedObjects({
    owner: ownerAddr,
    filter: { StructType: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::obligation::ObligationKey' },
    options: { showType: true, showOwner: true, showContent: true },
  });

  if (!data.length) throw new Error('ObligationKey (AddressOwner) tidak ditemukan. Jalankan deposit dulu untuk membuatnya.');

  // Cari yang cocok ENV_OBLIGATION_ID bila di-set
  if (ENV_OBLIGATION_ID) {
    const found = data.find(x => {
      const of = x?.data?.content?.fields?.ownership?.fields?.of;
      return of && of.toLowerCase() === ENV_OBLIGATION_ID;
    });
    if (found) return { keyId: found.data.objectId, obligationId: ENV_OBLIGATION_ID };
    log.warn('[warn] Tidak ada ObligationKey milikmu of == ENV_OBLIGATION_ID; pakai key pertama.');
  }

  const first = data[0];
  const of = first?.data?.content?.fields?.ownership?.fields?.of;
  if (!of) throw new Error('ObligationKey tidak memiliki ownership.of');
  return { keyId: first.data.objectId, obligationId: String(of) };
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

function addOracleRefresh(tx, xOracleId, rulePkg, clockId, type, ttl) {
  const req = tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::price_update_request',
    typeArguments: [type],
    arguments: [tx.object(xOracleId)],
  });
  tx.moveCall({
    target: `${rulePkg}::rule::set_price_as_primary`,
    typeArguments: [type],
    arguments: [req, tx.pure.u64(ttl.toString()), tx.object(clockId)],
  });
  tx.moveCall({
    target: '0xca9b2f66c5ab734939e048d0732e2a09f486402bb009d88f95c27abe8a4872ee::x_oracle::confirm_price_update_request',
    typeArguments: [type],
    arguments: [tx.object(xOracleId), req, tx.object(clockId)],
  });
}

// ---------- Gas Helpers ----------
const SUI_TYPE = '0x2::sui::SUI';

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
async function getLargestCoin(client, owner, coinType) {
  const all = await listCoins(client, owner, coinType);
  return all.reduce((a,b) => (!a || BigInt(b.balance) > BigInt(a.balance)) ? b : a, null);
}

/** Merge semua SUI kecil ke yang terbesar sampai >= target (best effort). */
async function ensureSuiForGas(client, sender, target, kp) {
  const largest = await getLargestCoin(client, sender, SUI_TYPE);
  const curBal = largest ? BigInt(largest.balance) : 0n;
  if (curBal >= target) return;

  if (!AUTO_MERGE_SUI) {
    log.warn(`[warn] Saldo gas (${curBal}) < target (${target}) dan AUTO_MERGE_SUI=0. Lanjut dengan clamp saja.`);
    return;
  }

  const coins = await listCoins(client, sender, SUI_TYPE);
  if (coins.length <= 1) {
    log.warn('[warn] Hanya 1 SUI coin, tidak ada yang bisa di-merge.');
    return;
  }

  // Sort kecil → besar, ambil terbesar sebagai dest
  coins.sort((a,b) => BigInt(a.balance) - BigInt(b.balance));
  const dest = coins.pop();
  const sources = coins.map(c => c.coinObjectId);

  log.info(`[info] Merge ${sources.length} SUI coins → ${dest.coinObjectId}…`);
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(Number(5_000_000)); // kecil saja

  const destObj = tx.object(dest.coinObjectId);
  const srcObjs = sources.map(id => tx.object(id));
  if (srcObjs.length) tx.mergeCoins(destObj, srcObjs);

  const res = await execTxCompat(client, kp, tx);
  const status = res.effects?.status?.status;
  log.info('[info] merge status:', status, 'digest:', res.digest || res.effects?.transactionDigest);
  if (status !== 'success') {
    throw new Error('Merge SUI gagal: ' + (res.effects?.status?.error || 'unknown'));
  }
}

// ---------- MAIN ----------
(async () => {
  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== CREEK BORROW ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Amount   :', BORROW_AMOUNT.toString());

  // Temukan pasangan Key ↔ Obligation yang valid
  const { keyId: obligationKeyId, obligationId } = await findKeyAndObligation(client, sender);
  log.info('ObligationKey (owned):', obligationKeyId);
  log.info('Obligation (shared)  :', obligationId);

  // ----- GAS budget clamp & optional merge -----
  const largestSui = await getLargestCoin(client, sender, SUI_TYPE);
  const suiBal = largestSui ? BigInt(largestSui.balance) : 0n;

  let gasBudget = GAS_BUDGET_CFG;
  if (suiBal > 0n && gasBudget >= suiBal) {
    const clamped = suiBal > GAS_SAFETY_BUFFER ? (suiBal - GAS_SAFETY_BUFFER) : 0n;
    gasBudget = clamped > 0n ? clamped : MIN_GAS_FALLBACK;
    log.warn(`[warn] GAS_BUDGET dikurangi ke ${gasBudget.toString()} (saldo SUI: ${suiBal})`);
  }

  // Jika after-clamp masih kurang dari default yang kamu mau, coba merge dulu (opsional)
  if (AUTO_MERGE_SUI && suiBal < GAS_BUDGET_CFG) {
    await ensureSuiForGas(client, sender, GAS_BUDGET_CFG, kp).catch(e => {
      log.warn('[warn] merge SUI gagal / dilewati:', e.message || e);
    });
    // refresh saldo & clamp lagi
    const largestAfter = await getLargestCoin(client, sender, SUI_TYPE);
    const sui2 = largestAfter ? BigInt(largestAfter.balance) : 0n;
    if (sui2 > 0n && GAS_BUDGET_CFG >= sui2) {
      const clamped2 = sui2 > GAS_SAFETY_BUFFER ? (sui2 - GAS_SAFETY_BUFFER) : 0n;
      gasBudget = clamped2 > 0n ? clamped2 : MIN_GAS_FALLBACK;
    } else {
      gasBudget = GAS_BUDGET_CFG; // sudah cukup
    }
    log.info('[info] gasBudget final:', gasBudget.toString());
  }

  // ----- Bangun TX utama -----
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(Number(gasBudget));

  // 1) Refresh oracle GR & GUSD (pola dari tx sukses kamu)
  addOracleRefresh(tx, X_ORACLE_ID, RULE_PKG, CLOCK_ID, GR_TYPE,   GR_TTL);
  addOracleRefresh(tx, X_ORACLE_ID, RULE_PKG, CLOCK_ID, GUSD_TYPE, GUSD_TTL);

  // 2) borrow::borrow_entry(
  //    version, obligation(shared), obligation_key(owned), market(shared),
  //    coin_decimals_registry, amount, x_oracle, clock)
  tx.moveCall({
    target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::borrow::borrow_entry',
    arguments: [
      tx.object(VERSION_ID),
      tx.object(obligationId),              // ← auto dari key.of
      tx.object(obligationKeyId),
      tx.object(MARKET_ID),
      tx.object(DECIMALS_REG),
      tx.pure.u64(BORROW_AMOUNT.toString()),
      tx.object(X_ORACLE_ID),
      tx.object(CLOCK_ID),
    ],
  });

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
