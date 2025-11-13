#!/usr/bin/env node
/**
 * gen_suikeys.mjs — generate Ed25519 Sui keys → "suiprivkey1..."
 *
 * Kompatibel lintas versi @mysten/sui:
 * - Ambil seed 32B dari keypair (via export() jika ada, fallback slice 32B pertama)
 * - Coba encodeSuiPrivateKey dengan beberapa bentuk (seed32 / sk64, dgn/ tanpa schema)
 *
 * Pakai:
 *   npm i @mysten/sui
 *   COUNT=10 OUT=./sui_keys.txt MAP=./keys_map.csv node gen_suikeys.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { encodeSuiPrivateKey } from '@mysten/sui/cryptography';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COUNT = parseInt(process.env.COUNT || '10', 10);
const OUT = process.env.OUT || path.resolve(__dirname, 'sui_keys.txt');
const MAP = process.env.MAP || path.resolve(__dirname, 'keys_map.csv');

function toCsvRow(arr) {
  return arr
    .map((v) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    })
    .join(',');
}
function writeCsv(fp, header, rows) {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  fs.writeFileSync(fp, lines.join('\n'));
}

/** Ambil seed 32B yang valid dari keypair (lintas versi) */
function getSeed32FromKeypair(kp) {
  // 1) Prefer export() kalau ada
  if (typeof kp.export === 'function') {
    try {
      const exp = kp.export(); // { schema: 'ED25519', privateKey: <Uint8Array|Buffer|string> }
      let priv = exp?.privateKey;
      if (typeof priv === 'string') priv = Uint8Array.from(Buffer.from(priv, 'base64'));
      if (priv && typeof priv.length === 'number') {
        const u8 = priv instanceof Uint8Array ? priv : Uint8Array.from(priv);
        if (u8.length === 32) return u8;
      }
    } catch (_) { /* fallback */ }
  }
  // 2) Fallback: getSecretKey() (64B sk||pk) → ambil 32B pertama
  const sk = kp.getSecretKey(); // Uint8Array (biasanya 64)
  const u8 = sk instanceof Uint8Array ? sk : Uint8Array.from(sk);
  if (u8.length === 32) return u8;
  if (u8.length >= 32) return u8.slice(0, 32);
  throw new Error(`unexpected secret key length: ${u8.length}`);
}

/** Beberapa strategi encoding → pilih pertama yang sukses & valid */
function encodeSuiprivkeyRobust({ seed32, sk64 }) {
  const trials = [
    () => encodeSuiPrivateKey({ schema: 'ED25519', secretKey: seed32 }), // versi modern
    () => encodeSuiPrivateKey({ schema: 'ED25519', secretKey: sk64 }),   // kalau versi lib minta 64B
    () => encodeSuiPrivateKey(seed32),                                   // versi lama (tanpa schema)
    () => encodeSuiPrivateKey(sk64),                                     // versi lama + 64B
  ];
  for (const t of trials) {
    try {
      const out = t();
      if (typeof out === 'string' && out.startsWith('suiprivkey1')) return out;
    } catch (_) {}
  }
  throw new Error('encodeSuiPrivateKey gagal untuk semua variasi (seed32 & sk64).');
}

async function main() {
  // optional: tampilkan versi paket (kalau ada)
  try {
    const pkgUrl = pathToFileURL(
      path.resolve(__dirname, 'node_modules/@mysten/sui/package.json')
    ).href;
    const mod = await import(pkgUrl);
    console.log(`[info] @mysten/sui version: ${mod.default?.version || mod.version}`);
  } catch {}

  const keyLines = [];
  const mapRows = [];

  for (let i = 0; i < COUNT; i++) {
    const kp = Ed25519Keypair.generate();
    const addr = kp.getPublicKey().toSuiAddress();
    const sk64 = kp.getSecretKey();
    const seed32 = getSeed32FromKeypair(kp);

    if (seed32.length !== 32) throw new Error(`Seed bukan 32B (got ${seed32.length})`);

    // Robust encode
    const suiPriv = encodeSuiprivkeyRobust({ seed32, sk64 });

    keyLines.push(suiPriv);
    mapRows.push([addr, suiPriv]);
  }

  fs.writeFileSync(OUT, keyLines.join('\n') + '\n');
  writeCsv(MAP, ['address', 'suiprivkey'], mapRows);

  console.log(`✅ Generated ${COUNT} keys`);
  console.log(`   • suiprivkey list : ${OUT}`);
  console.log(`   • address mapping : ${MAP}`);
}

main().catch((e) => {
  console.error('❌ gagal generate:', e);
  process.exit(1);
});
