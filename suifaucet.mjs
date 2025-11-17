// sui-faucet-batch.mjs
// Node ESM script
// - Baca privatekey.txt (1 key per line, bech32 suiprivkey1...)
// - Untuk tiap address: coba faucets sampai balance > 0 lalu lanjut ke next key
// - Backoff exponential: 3s, 6s, 12s, ... max 10 menit
// - Tidak mencetak private key ke log
//
// Usage:
// 1) npm install @mysten/sui node-fetch bech32
//    or if using node-fetch polyfill, the import below handles it.

import fs from "fs/promises";
import fetch from "node-fetch";
import { bech32 } from "bech32";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const NETWORK = "testnet"; // ubah jika perlu
const PRIVATE_KEY_FILE = "privatekey.txt"; // satu key per baris
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

const faucetsToTry = [
  { name: "sdk", host: getFaucetHost(NETWORK) },
  { name: "http", host: `https://faucet.${NETWORK}.sui.io/v2/gas` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeSuiprivkey(bech32Str) {
  const { words } = bech32.decode(bech32Str);
  const bytes = bech32.fromWords(words);
  return Uint8Array.from(bytes);
}

function keypairFromBech32PrivateKey(bech32Str) {
  const payload = decodeSuiprivkey(bech32Str);
  if (payload.length < 33) throw new Error("decoded payload too short to contain flag + 32-byte seed");
  const seed = payload.slice(payload.length - 32);
  return Ed25519Keypair.fromSecretKey(seed);
}

async function getBalanceForAddress(address) {
  try {
    const coins = await client.getBalance({ owner: address, coinType: "0x2::sui::SUI" });
    return coins?.totalBalance ?? 0;
  } catch (e) {
    console.warn("Error fetching balance:", e?.message || e);
    return 0;
  }
}

async function trySdkFaucet(host, recipient) {
  return await requestSuiFromFaucetV2({ host, recipient });
}

async function tryHttpFaucet(host, recipient) {
  const res = await fetch(host, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient } }),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function requestUntilSuccess(address) {
  const minDelay = 3000;          // 1 detik
  const maxDelay = 10000; // 1 
  let delay = minDelay;

  console.log(`\n=== Starting requests for address: ${address} ===`);

  let balance = await getBalanceForAddress(address);
  console.log(`Initial balance: ${balance}`);
  if (balance > 0) {
    console.log("Already funded — skipping.");
    return true;
  }

  while (true) {
    let success = false;

    for (const f of faucetsToTry) {
      try {
        console.log(`Trying faucet ${f.name} -> ${f.host}`);

        const result =
          f.name === "sdk"
            ? await trySdkFaucet(f.host, address)
            : await tryHttpFaucet(f.host, address);

        console.log("Faucet response:", JSON.stringify(result));

        await sleep(1500);
        balance = await getBalanceForAddress(address);
        console.log(`Balance after request: ${balance}`);

        if (balance > 0) {
          console.log(`SUCCESS: ${address} funded!`);
          return true;
        }
      } catch (e) {
        console.warn(`Faucet ${f.name} failed:`, e.message || e);
      }

      await sleep(1000); // jeda antar faucet
    }

    // jika semua faucet gagal → delay diperbesar
    console.log(`All faucets failed. Waiting ${Math.round(delay / 1000)}s...`);
    await sleep(delay);

    // tingkatkan delay
    delay = Math.min(delay * 2, maxDelay);
  }
}


async function main() {
  try {
    const raw = await fs.readFile(PRIVATE_KEY_FILE, "utf-8");
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      console.error("privatekey.txt kosong atau tidak ditemukan key.");
      process.exit(1);
    }

    for (const line of lines) {
      if (!line.toLowerCase().startsWith("suiprivkey1")) {
        console.log("Skipping non-suiprivkey line (not starting with suiprivkey1)");
        continue;
      }

      try {
        const kp = keypairFromBech32PrivateKey(line);
        const address = kp.getPublicKey().toSuiAddress();

        // jalankan loop request sampai berhasil lalu lanjut ke next key
        const res = await requestUntilSuccess(address);
        // apabila butuh catatan sukses/gagal kita bisa tulis ke file, tapi user minta minimal.
        // lanjut ke akun berikutnya
      } catch (e) {
        console.error("Failed to derive address from a private key line:", e?.message || e);
        // continue to next line
      }
    }

    console.log("All keys processed.");
    process.exit(0);
  } catch (e) {
    console.error("Fatal error:", e?.message || e);
    process.exit(1);
  }
}

main();
