#!/usr/bin/env node
/**
 * gen_suikeys.mjs — derive Sui Ed25519 keys + optional AES-GCM encryption for outputs
 *
 * Usage:
 *   node gen_suikeys.mjs                        # default -> 1 mnemonic × 10 keys
 *   node gen_suikeys.mjs default 2 10           # generate 2 mnemonics × 10 keys
 *   node gen_suikeys.mjs phrase "<mnemonic>" 10
 *   node gen_suikeys.mjs --encrypt              # prompt passphrase to encrypt outputs
 *   ENC_PASSPHRASE="pass" node gen_suikeys.mjs --encrypt
 *
 * Install:
 *   npm i @mysten/sui bip39 ed25519-hd-key tweetnacl @noble/hashes
 *
 * Outputs:
 *   - privatekey.txt   (plaintext or JSON-encrypted depending on --encrypt)
 *   - mnemonics.txt     (plaintext or JSON-encrypted depending on --encrypt)
 *   - map.csv           (always plaintext CSV mapping)
 *
 * Security:
 *   - If you use --encrypt, passphrase is required to decrypt outputs later.
 *   - Keep passphrase safe; lost passphrase => lost keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import readline from 'node:readline';
import bip39 from 'bip39';
import { encodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2b';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRIVATE_OUT = path.resolve(process.cwd(), 'privatekey.txt');
const MNEMONIC_OUT = path.resolve(process.cwd(), 'mnemonics.txt');
const MAP_OUT = path.resolve(process.cwd(), 'map.csv');

const DEFAULT_PHRASES = 1;
const DEFAULT_KEYS_PER_PHRASE = 10;

/* --------------------------- encryption utils --------------------------- */

function randBytes(n) {
  return crypto.randomBytes(n);
}
function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}
function fromB64(s) {
  return Buffer.from(s, 'base64');
}

/**
 * Derive AES-256-GCM key from passphrase and salt using PBKDF2.
 * iterations moderately high (200k).
 */
function deriveKeyFromPassphrase(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 200_000, 32, 'sha256'); // returns Buffer
}

/**
 * Encrypt plaintext (string/Buffer) with passphrase.
 * Returns JSON string with base64 fields: { salt, iv, ct }.
 */
function encryptWithPassphrase(passphrase, plaintext) {
  const salt = randBytes(16);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  const iv = randBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ptBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct1 = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store ct as ct||tag
  const ctAll = Buffer.concat([ct1, tag]);
  const obj = { salt: toB64(salt), iv: toB64(iv), ct: toB64(ctAll) };
  return JSON.stringify(obj);
}

/**
 * Decrypt JSON produced by encryptWithPassphrase using passphrase.
 * Returns Buffer plaintext.
 */
function decryptWithPassphrase(passphrase, jsonStr) {
  const obj = JSON.parse(jsonStr);
  const salt = fromB64(obj.salt);
  const iv = fromB64(obj.iv);
  const ctAll = fromB64(obj.ct);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  const tag = ctAll.slice(ctAll.length - 16);
  const ct = ctAll.slice(0, ctAll.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt;
}

/* prompt passphrase silently (no echo) */
function promptPassphrase(promptText = 'Passphrase: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // hide input by muting output
    const mutableStdout = rl.output;
    const onDataHandler = (char) => {
      char = char + '';
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          mutableStdout.write('\n');
          break;
        default:
          mutableStdout.write('*');
          break;
      }
    };
    process.stdin.on('data', onDataHandler);
    rl.question(promptText, (answer) => {
      process.stdin.removeListener('data', onDataHandler);
      rl.close();
      // ensure newline shown
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/* --------------------------- crypto / sui utils --------------------------- */

function bufHex(b) {
  if (!b) return '';
  if (Buffer.isBuffer(b)) return b.toString('hex');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('hex');
  return String(b);
}

function encodeSuiprivkeyFromPriv32(priv32) {
  const trials = [
    () => encodeSuiPrivateKey({ schema: 'ED25519', secretKey: priv32 }),
    () => encodeSuiPrivateKey(priv32),
  ];
  for (const t of trials) {
    try {
      const out = t();
      if (typeof out === 'string' && out.startsWith('suiprivkey1')) return out;
    } catch (_) {}
  }
  throw new Error('encodeSuiPrivateKey failed for priv32.');
}

function suiAddressFromPubkey(pubkeyBytes) {
  const flag = new Uint8Array([0x00]); // Ed25519 flag
  const input = new Uint8Array(flag.length + pubkeyBytes.length);
  input.set(flag, 0);
  input.set(pubkeyBytes, flag.length);
  const hash = blake2b(input, { dkLen: 32 });
  return '0x' + Buffer.from(hash).toString('hex');
}

function derivePriv32FromMnemonic(mnemonic, path) {
  const seed = bip39.mnemonicToSeedSync(mnemonic); // Buffer
  const derived = derivePath(path, seed);
  return derived.key; // Buffer (32)
}

/* --------------------------- file helpers --------------------------- */

function writePlainOrEncryptedFile(fp, contentStr, encrypt, passphrase) {
  if (!encrypt) {
    fs.appendFileSync(fp, contentStr);
    return;
  }
  // if file doesn't exist, create empty then encrypt whole file? We'll append encrypted chunks as separate JSON lines.
  // Approach: write each appended secret as its own JSON line (one encrypted object per secret) so we can append safely.
  // contentStr should include trailing newline if desired.
  const json = encryptWithPassphrase(passphrase, contentStr);
  fs.appendFileSync(fp, json + '\n');
}

/* --------------------------- CSV helpers --------------------------- */

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
function writeCsvHeaderIfMissing(fp, headerArr) {
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, toCsvRow(headerArr) + '\n');
}
function appendCsvRow(fp, arr) {
  fs.appendFileSync(fp, toCsvRow(arr) + '\n');
}

/* --------------------------- main derivation logic --------------------------- */

const argv = process.argv.slice(2);
// check for --encrypt flag
const wantsEncrypt = argv.includes('--encrypt');
// remove the flag from argv processed later
const filteredArgs = argv.filter((a) => a !== '--encrypt');

let mode = 'default';
let arg1 = undefined;
let arg2 = undefined;
if (filteredArgs.length === 0) {
  mode = 'default';
} else {
  mode = filteredArgs[0];
  arg1 = filteredArgs[1];
  arg2 = filteredArgs[2];
}

(async () => {
  try {
    // prepare encryption passphrase if requested
    let passphrase = process.env.ENC_PASSPHRASE || null;
    if (wantsEncrypt && !passphrase) {
      passphrase = await promptPassphrase('Enter encryption passphrase: ');
      if (!passphrase) {
        console.error('No passphrase provided. Aborting.');
        process.exit(1);
      }
    }

    const pathType = (process.env.PATH_TYPE || 'hardened').toLowerCase();
    const PATH_TEMPLATE = pathType === 'nonhardened' ? "m/44'/784'/0'/0/{index}" : "m/44'/784'/0'/0'/{index}'";

    // ensure map csv header
    writeCsvHeaderIfMissing(MAP_OUT, ['mnemonic_index', 'mnemonic', 'index', 'path', 'address', 'pubkey_hex', 'private_key_hex', 'suiprivkey']);

    // prepare (create or truncate) output files if not exists
    if (!fs.existsSync(PRIVATE_OUT)) fs.writeFileSync(PRIVATE_OUT, '');
    if (!fs.existsSync(MNEMONIC_OUT)) fs.writeFileSync(MNEMONIC_OUT, '');

    if (mode === 'phrase') {
      if (!arg1 || !arg2) {
        console.error('Usage: node gen_suikeys.mjs phrase "<mnemonic>" <count>');
        process.exit(1);
      }
      const mnemonic = String(arg1).trim();
      const count = parseInt(arg2, 10);
      if (!bip39.validateMnemonic(mnemonic)) {
        console.error('Error: provided mnemonic is invalid.');
        process.exit(1);
      }

      // append mnemonic to mnemonics file (encrypted or plaintext)
      const mnemonicLine = mnemonic + '\n';
      writePlainOrEncryptedFile(MNEMONIC_OUT, mnemonicLine, wantsEncrypt, passphrase);

      for (let i = 0; i < count; i++) {
        const path = PATH_TEMPLATE.replace('{index}', String(i));
        const priv32 = derivePriv32FromMnemonic(mnemonic, path); // Buffer
        const kp = nacl.sign.keyPair.fromSeed(priv32);
        const pub = kp.publicKey;
        const address = suiAddressFromPubkey(pub);
        const pubkey_hex = bufHex(pub);
        const private_key_hex = bufHex(priv32);
        const suiprivkey = encodeSuiprivkeyFromPriv32(priv32);

        // write private key: either plaintext suiprivkey + newline, or encrypted JSON-line
        writePlainOrEncryptedFile(PRIVATE_OUT, suiprivkey + '\n', wantsEncrypt, passphrase);

        appendCsvRow(MAP_OUT, [-1, mnemonic, i, path, address, pubkey_hex, private_key_hex, suiprivkey]);
      }

      console.log(`✅ Derived ${count} keys from provided mnemonic. Files updated: ${PRIVATE_OUT}, ${MAP_OUT}, ${MNEMONIC_OUT}`);
      process.exit(0);
    }

    // default mode: generate phrasesCount mnemonics; each produce keysPerPhrase keys
    const phrasesCount = arg1 ? Math.max(1, parseInt(arg1, 10) || DEFAULT_PHRASES) : DEFAULT_PHRASES;
    const keysPerPhrase = arg2 ? Math.max(1, parseInt(arg2, 10) || DEFAULT_KEYS_PER_PHRASE) : DEFAULT_KEYS_PER_PHRASE;

    let total = 0;
    for (let mIdx = 0; mIdx < phrasesCount; mIdx++) {
      const mnemonic = bip39.generateMnemonic(256);
      // store mnemonic (encrypted or not)
      writePlainOrEncryptedFile(MNEMONIC_OUT, mnemonic + '\n', wantsEncrypt, passphrase);

      for (let i = 0; i < keysPerPhrase; i++) {
        const path = PATH_TEMPLATE.replace('{index}', String(i));
        const priv32 = derivePriv32FromMnemonic(mnemonic, path); // Buffer
        const kp = nacl.sign.keyPair.fromSeed(priv32);
        const pub = kp.publicKey;
        const address = suiAddressFromPubkey(pub);
        const pubkey_hex = bufHex(pub);
        const private_key_hex = bufHex(priv32);
        const suiprivkey = encodeSuiprivkeyFromPriv32(priv32);

        // write private key: plaintext suiprivkey (or encrypted json line)
        writePlainOrEncryptedFile(PRIVATE_OUT, suiprivkey + '\n', wantsEncrypt, passphrase);

        appendCsvRow(MAP_OUT, [mIdx, mnemonic, i, path, address, pubkey_hex, private_key_hex, suiprivkey]);
        total++;
      }
      console.log(` - mnemonic #${mIdx} generated with ${keysPerPhrase} keys`);
    }

    console.log(`✅ Done. total keys generated: ${total}`);
    console.log(`Files:`);
    console.log(`  • private keys: ${PRIVATE_OUT} ${wantsEncrypt ? '(encrypted)' : ''}`);
    console.log(`  • mnemonics   : ${MNEMONIC_OUT} ${wantsEncrypt ? '(encrypted)' : ''}`);
    console.log(`  • mapping csv : ${MAP_OUT}`);
    console.log('');
    console.log('Security: If you used --encrypt, keep the passphrase safe. Losing it means losing access to the keys.');
  } catch (e) {
    console.error('❌ Error:', e);
    process.exit(1);
  }
})();
