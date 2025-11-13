#!/usr/bin/env node
// sui.mjs — Deposit SUI Collateral (percent / amount / ladder)
// Fungsinya mirip contohmu (GR), tapi ini khusus SUI collateral.
// Sudah dipatch agar menerima SUI_PRIVATE_KEY / PRIVATE_KEY / PRIVATE_KEY_HEX dan SUI_FULLNODE / FULLNODE_URL.
// Support ed25519 & secp256k1, berbagai encoding kunci, dan API execute SDK baru/lama.

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

// ---------- ENV ----------
const FULLNODE =
  process.env.SUI_FULLNODE ||
  process.env.FULLNODE_URL ||
  getFullnodeUrl('testnet');

const RAW_PK =
  String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();

const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

// Shared objects Creek
const VERSION_ID = process.env.VERSION_ID || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758';
const MARKET_ID  = process.env.MARKET_ID  || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d';

// Konstanta SUI
const SUI_TYPE   = '0x2::sui::SUI';

// Gas & batas
const GAS_BUDGET = BigInt(process.env.SUI_GAS_BUDGET || '100000000');   // 0.1 SUI (dec=9)
const DUST       = BigInt(process.env.SUI_DUST || '2000000');           // sisakan ~0.002 SUI buat gas           // sisakan 0.002 SUI buat gas
const MIN_DEPOSIT= BigInt(process.env.SUI_MIN_DEPOSIT || '10000000');   // default 0.01 SUI

// Mode deposit
const MODE        = (process.env.SUI_DEPOSIT_MODE || 'percent').toLowerCase(); // 'percent'|'amount'|'ladder'
const PERCENT     = Number(process.env.SUI_DEPOSIT_PERCENT || '50');           // 1..99
const AMOUNT_ABS  = BigInt(process.env.SUI_DEPOSIT_AMOUNT || '0');             // jika MODE=amount
const LADDER      = (process.env.SUI_LADDER_AMOUNTS || '100000000,50000000,20000000,10000000')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => BigInt(s));

const MAX_RETRY   = Number(process.env.SUI_DEPOSIT_RETRY || '4');
const BACKOFF_MS  = Number(process.env.SUI_DEPOSIT_BACKOFF_MS || '1500');

// ---------- HELPERS ----------
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Universal key parser (supports suiprivkey:, ed25519:, secp256k1:, 0x-hex, base64)
function parsePrivKey(raw, schemeFromEnv = String(process.env.SUI_KEY_SCHEME || '').toLowerCase()) {
  if (!raw) throw new Error('SUI_PRIVATE_KEY / PRIVATE_KEY kosong.');

  // sui-format or prefixed format
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return { kp: Ed25519Keypair.fromSecretKey(secretKey),  scheme: 'ed25519' };
    if (s === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(secretKey), scheme: 'secp256k1' };
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }

  // raw hex atau base64 seed
  let bytes;
  if (raw.startsWith('0x')) bytes = fromHex(raw);
  else                      bytes = Buffer.from(raw, 'base64');

  // Beberapa export menambahkan 0x00 prefix (33 bytes)
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);

  if (schemeFromEnv === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

async function getLargestCoinObj(client, owner, coinType) {
  let cursor = null, largest = null;
  do {
    const { data, nextCursor, hasNextPage } = await client.getCoins({ owner, coinType, cursor });
    for (const c of data) if (!largest || BigInt(c.balance) > BigInt(largest.balance)) largest = c;
    cursor = nextCursor;
    if (!hasNextPage) break;
  } while (true);
  return largest;
}

async function getTotalBalance(client, owner, coinType) {
  const r = await client.getBalance({ owner, coinType });
  return BigInt(r.totalBalance || '0');
}

function pickAmount(balance) {
  // Untuk SUI, kita sisakan DUST buat gas; jangan mengunci semua SUI sebagai collateral.
  const maxSpendable = balance > DUST ? (balance - DUST) : 0n;
  if (maxSpendable < MIN_DEPOSIT) throw new Error(`Saldo SUI terlalu kecil: ${balance} < MIN_DEPOSIT(${MIN_DEPOSIT}).`);

  if (MODE === 'amount') {
    if (AMOUNT_ABS <= 0n) throw new Error('MODE=amount tapi DEPOSIT_AMOUNT tidak valid.');
    let a = AMOUNT_ABS;
    if (a > maxSpendable) a = maxSpendable;
    if (a < MIN_DEPOSIT) throw new Error(`Amount < MIN_DEPOSIT (${a} < ${MIN_DEPOSIT}).`);
    return a;
  }
  if (MODE === 'percent') {
    let pct = Math.max(1, Math.min(99, Math.floor(PERCENT)));
    let a = (maxSpendable * BigInt(pct)) / 100n;
    if (a < MIN_DEPOSIT) a = MIN_DEPOSIT;
    if (a > maxSpendable) a = maxSpendable;
    return a;
  }
  // ladder
  for (const x of LADDER) if (x >= MIN_DEPOSIT && x <= maxSpendable) return x;
  return maxSpendable;
}

async function checkShared(client, id) {
  const o = await client.getObject({ id, options: { showOwner: true }});
  const d = o.data;
  if (!d) throw new Error(`Object ${id} tidak ditemukan.`);
  const owner = d.owner;
  if (!owner || !('Shared' in owner)) log.warn(`[warn] ${id} bukan shared object. owner=`, owner);
  return d.reference?.digest || d.digest;
}

async function execTxCompat(sui, kp, tx) {
  const built = await tx.build({ client: sui, onlyTransactionKind: false });

  // Dry run (opsional)
  try {
    const sim = await sui.dryRunTransactionBlock({ transactionBlock: built });
    if (sim.effects?.status?.status !== 'success') {
      log.warn('[warn] dryRun status != success', JSON.stringify(sim.effects?.status || {}));
    } else {
      log.info('[info] dryRun status: success');
    }
  } catch (e) {
    log.warn('[warn] dryRun gagal:', e?.message || String(e));
  }

  const opt = { showEffects: true, showEvents: true, showBalanceChanges: true };
  if (typeof sui.signAndExecuteTransactionBlock === 'function') {
    return await sui.signAndExecuteTransactionBlock({ signer: kp, transactionBlock: tx, options: opt, requestType: 'WaitForLocalExecution' });
  }
  if (typeof sui.signAndExecuteTransaction === 'function') {
    return await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: opt, requestType: 'WaitForLocalExecution' });
  }
  if (typeof kp.signTransactionBlock === 'function' && typeof sui.executeTransactionBlock === 'function') {
    const sig = await kp.signTransactionBlock({ transactionBlock: built });
    return await sui.executeTransactionBlock({ transactionBlock: built, signature: sig.signature, options: opt, requestType: 'WaitForLocalExecution' });
  }
  throw new Error('Tidak menemukan method eksekusi Sui SDK yang cocok');
}

// ---------- MAIN ----------
(async () => {
  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== DEPOSIT SUI COLLATERAL ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Version  :', VERSION_ID);
  log.info('Market   :', MARKET_ID);
  log.info('Type     :', SUI_TYPE);
  if (MODE === 'percent') log.info('Mode     : percent =', PERCENT + '%');
  if (MODE === 'amount')  log.info('Mode     : amount  =', AMOUNT_ABS.toString());
  if (MODE === 'ladder')  log.info('Mode     : ladder  =', LADDER.map(x=>x.toString()).join(', '));

  await checkShared(client, VERSION_ID).catch(()=>{});
  await checkShared(client, MARKET_ID).catch(()=>{});

  // Total saldo SUI
  const total = await getTotalBalance(client, sender, SUI_TYPE);
  log.info('SUI total:', total.toString());
  if (total <= DUST) throw new Error('Saldo SUI kosong/terlalu kecil.');

  let want = pickAmount(total);
  log.info('Target   :', want.toString());

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    log.info(`-- attempt ${attempt}/${MAX_RETRY} amount=${want.toString()}`);

    const biggest = await getLargestCoinObj(client, sender, SUI_TYPE);
    if (!biggest) throw new Error('Tidak menemukan coin SUI.');
    const bal = BigInt(biggest.balance);
    if (bal <= DUST) throw new Error(`Saldo SUI pada object terbesar sangat kecil: ${bal}`);

    let amount = want;
    // Pastikan koin gas yang sama masih punya saldo >= GAS_BUDGET setelah split
    const reserveForGas = GAS_BUDGET + DUST; // sisakan gas budget + buffer
    const spendCap = bal > reserveForGas ? (bal - reserveForGas) : 0n;
    if (amount > spendCap) {
      amount = spendCap;
      log.warn('[warn] amount > coinObj balance. pakai amount=', amount.toString());
    }
    if (amount < MIN_DEPOSIT) throw new Error(`Amount efektif < MIN_DEPOSIT (${amount} < ${MIN_DEPOSIT}).`);

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(Number(GAS_BUDGET));

    // Pakai coin terbesar sebagai gas payment secara eksplisit

    const version = tx.object(VERSION_ID);
    const market  = tx.object(MARKET_ID);
    // gunakan gas coin langsung untuk split supaya gas coin tidak perlu diset manual
    // const suiCoin = tx.object(biggest.coinObjectId);

    // 1) Buka obligation baru (obligation, obligation_key, hot_potato)
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::open_obligation::open_obligation',
      arguments: [version],
    });

    // 2) Split SUI sesuai amount
    const [suiSplit] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);

    // 3) Deposit SUI sebagai collateral
    tx.moveCall({
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::deposit_collateral::deposit_collateral',
      typeArguments: [SUI_TYPE],
      arguments: [version, obligation, market, suiSplit],
    });

    // 4) ObligationKey ke wallet pemilik
    tx.transferObjects([obligationKey], tx.pure.address(sender));

    // 5) Kembalikan obligation handle
    tx.moveCall({
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::open_obligation::return_obligation',
      arguments: [version, obligation, hotPotato],
    });

    try {
      const res = await execTxCompat(client, kp, tx);

      const status = res.effects?.status?.status;
      const digest = res.digest || res.effects?.transactionDigest;
      log.info('[info] execute digest:', digest);
      log.info('[info] execute status:', status);

      if (status === 'success') {
        const evts = res.events || [];
        if (evts.length) {
          log.info('[info] events:');
          for (const e of evts) log.info('  -', e.type, e.parsedJson || e);
        }
        return;
      }

      const abort =
        res.effects?.status?.error ||
        res.effects?.abortError ||
        '';
      const msgStr = typeof abort === 'string' ? abort : JSON.stringify(abort);

      if (msgStr.includes('1793')) { // kapasitas penuh
        log.warn('[warn] Market penuh (1793). Turunkan amount & retry…');
        let next = amount / 2n;
        if (next < MIN_DEPOSIT) next = MIN_DEPOSIT;
        want = next;
        await sleep(BACKOFF_MS);
        continue;
      }

      throw new Error(msgStr || 'Tx gagal tanpa detail.');

    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('1793')) {
        log.warn('[warn] Market penuh (1793). Turunkan amount & retry…');
        let next = amount / 2n;
        if (next < MIN_DEPOSIT) next = MIN_DEPOSIT;
        want = next;
        await sleep(BACKOFF_MS);
        continue;
      }
      log.error('FATAL:', msg);
      process.exit(1);
    }
  }

  log.error(`FATAL: Gagal deposit setelah ${MAX_RETRY} attempt.`);
  process.exit(1);
})().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
