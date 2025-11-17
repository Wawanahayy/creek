// sui-faucet-batch.mjs
// Node ESM script

// Usage:
// 1) npm install @mysten/sui node-fetch bech32
// 2) node sui-faucet-batch.mjs   (Node >=18 recommended)

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

// ========== Helpers key ==========

function decodeSuiprivkey(bech32Str) {
  const { words } = bech32.decode(bech32Str);
  const bytes = bech32.fromWords(words);
  return Uint8Array.from(bytes);
}

function keypairFromBech32PrivateKey(bech32Str) {
  const payload = decodeSuiprivkey(bech32Str);
  if (payload.length < 33) {
    throw new Error("decoded payload too short to contain flag + 32-byte seed");
  }
  const seed = payload.slice(payload.length - 32);
  return Ed25519Keypair.fromSecretKey(seed);
}

// ========== Helpers chain ==========

async function getBalanceForAddress(address) {
  try {
    const coins = await client.getBalance({
      owner: address,
      coinType: "0x2::sui::SUI",
    });
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


async function requestUntilOneSuccess(address, timeLimitMs) {
  const minDelay = 3000; // 3 detik
  const maxDelay = 10000; // 10 detik
  let delay = minDelay;

  const startedAt = Date.now();

  console.log(`\n=== Starting faucet loop for address: ${address} ===`);
  if (timeLimitMs) {
    console.log(
      `Time limit for this address: ${Math.round(timeLimitMs / 1000)} seconds`
    );
  } else {
    console.log(`No time limit (will spam until 1 success).`);
  }

  const initialBalance = await getBalanceForAddress(address);
  console.log(`Initial balance: ${initialBalance}`);

  while (true) {
    // cek time limit
    if (timeLimitMs && Date.now() - startedAt > timeLimitMs) {
      console.log(
        `⏱️ Time limit reached for ${address}, moving to next address (no success yet).`
      );
      return false;
    }

    for (const f of faucetsToTry) {
      try {
        console.log(`Trying faucet ${f.name} -> ${f.host}`);

        const result =
          f.name === "sdk"
            ? await trySdkFaucet(f.host, address)
            : await tryHttpFaucet(f.host, address);

        console.log(
          "Faucet response:",
          JSON.stringify(result).slice(0, 200),
          "…"
        );

        // anggap ini sudah 1x "success" untuk hari ini
        console.log(`✅ Faucet SUCCESS for ${address} via ${f.name}`);
        // opsional: cek balance hanya untuk info
        await sleep(1500);
        const balAfter = await getBalanceForAddress(address);
        console.log(`Balance after success: ${balAfter}`);

        return true; // 1 hari 1 sukses → cukup
      } catch (e) {
        console.warn(`Faucet ${f.name} failed:`, e?.message || e);
      }

      await sleep(1000); // jeda antar faucet
    }

    console.log(
      `All faucets failed this round for ${address}. Waiting ${Math.round(
        delay / 1000
      )}s before next round...`
    );
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

// ========== main ==========

async function main() {
  try {
    const raw = await fs.readFile(PRIVATE_KEY_FILE, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      console.error("privatekey.txt kosong atau tidak ditemukan key.");
      process.exit(1);
    }

    // derive semua address dulu
    const addresses = [];
    for (const line of lines) {
      if (!line.toLowerCase().startsWith("suiprivkey1")) {
        console.log(
          "Skipping non-suiprivkey line (not starting with suiprivkey1)"
        );
        continue;
      }
      try {
        const kp = keypairFromBech32PrivateKey(line);
        const address = kp.getPublicKey().toSuiAddress();
        addresses.push(address);
      } catch (e) {
        console.error(
          "Failed to derive address from a private key line:",
          e?.message || e
        );
      }
    }

    if (addresses.length === 0) {
      console.error("Tidak ada address valid dari privatekey.txt.");
      process.exit(1);
    }

    console.log(`Total derived addresses: ${addresses.length}`);

    // 1 jam per address by default
    const ONE_HOUR_MS = 60 * 60 * 1000;

    const results = [];
    for (const addr of addresses) {
      console.log(
        `\n>>> Processing address (daily target: 1 faucet success): ${addr}`
      );
      const ok = await requestUntilOneSuccess(addr, ONE_HOUR_MS);
      results.push({ address: addr, success: ok });
    }

    // Cari address yang BELUM sukses di run ini
    const failed = results.filter((r) => !r.success);

    if (failed.length === 0) {
      console.log("Semua address dapat minimal 1x faucet success hari ini. 🎉");
      process.exit(0);
    }

    if (failed.length === 1) {
      const addr = failed[0].address;
      console.log(
        `🔥 Only ONE address without success in this run (${addr}) → will spam WITHOUT time limit until success.`
      );
      await requestUntilOneSuccess(addr, null);
    } else {
      console.log(
        `There are ${failed.length} addresses without success in this run. They will be retried on the next day's run.`
      );
    }

    console.log("Run finished.");
    process.exit(0);
  } catch (e) {
    console.error("Fatal error:", e?.message || e);
    process.exit(1);
  }
}

main();
