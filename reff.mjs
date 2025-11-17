#!/usr/bin/env node
/**
 * reff_sui.mjs — Creek Aura referral (prioritas "suiprivkey1...")
 * FIX: gunakan Ed25519Keypair.fromSecretKey() (32B seed atau 64B secret)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ORIGIN      = process.env.ORIGIN      || 'https://beta.creek.finance';
const API_BASE    = process.env.API_BASE    || 'https://api-test.creek.finance';
const INVITE_CODE = process.env.INVITE_CODE || '';
const INPUT       = process.env.INPUT       || 'privatekey.txt';
const OUTDIR      = process.env.OUTDIR      || 'out';
const PAGE_SIZE   = +process.env.PAGE_SIZE || 100;
const RATE_MS     = +process.env.RATE_MS   || 600;
const MAX_RETRY   = +process.env.MAX_RETRY || 3;
const CHECK_ONLY  = process.env.CHECK_ONLY === '1';
const ALLOW_FALLBACK = process.env.ALLOW_FALLBACK === '1';
const UA = process.env.UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const sleep  = (ms)=>new Promise(r=>setTimeout(r,ms));
const jitter = (ms)=>ms + Math.floor(Math.random()*200);
const randReqId = (n=9)=>Array.from({length:n},()=> 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('');
const readLines = (f)=> fs.existsSync(f) ? fs.readFileSync(f,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean) : [];

function makeAgent(){
  const socks = process.env.SOCKS_PROXY || '';
  const all   = process.env.ALL_PROXY || '';
  const https = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (socks) return new SocksProxyAgent(socks);
  if (all && all.startsWith('socks')) return new SocksProxyAgent(all);
  if (https) return new HttpsProxyAgent(https);
  return undefined;
}
const agent = makeAgent();

const http = axios.create({
  baseURL: API_BASE,
  timeout: 25_000,
  headers: {
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': ORIGIN,
    'referer': `${ORIGIN}/`,
    'user-agent': UA,
    'accept-language': 'en-GB,en;q=0.5',
    'sec-ch-ua': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'sec-gpc': '1',
  },
  ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
});

async function withRetry(fn, label){
  let lastErr;
  for (let i=0;i<MAX_RETRY;i++){
    try { return await fn(); }
    catch(e){
      lastErr = e;
      const ms = jitter(500 + i*400);
      console.warn(`[warn] ${label} gagal (try ${i+1}/${MAX_RETRY}): ${e?.response?.status || e.code || e.message}; retry ${ms}ms`);
      await sleep(ms);
    }
  }
  throw lastErr;
}

// ===== API =====
const getInfo = (addr)=> withRetry(
  ()=> http.get(`/api/user/info/${addr}`, { headers:{'x-request-id':randReqId()} }),
  `getInfo(${addr})`
).then(r=>r.data);

const connect = (addr, code)=> withRetry(
  ()=> http.post(`/api/user/connect`, { walletAddress: addr, inviteCode: code }, { headers:{'x-request-id':randReqId()} }),
  `connect(${addr})`
).then(r=>r.data);

async function getInvitees(addr, pageSize=PAGE_SIZE){
  let page=1, out=[];
  while(true){
    const res = await withRetry(
      ()=> http.get(`/api/user/invitees/${addr}?page=${page}&page_size=${pageSize}`, { headers:{'x-request-id':randReqId()} }),
      `invitees(${addr})#${page}`
    );
    const payload = res.data;
    const list = payload?.data?.list || payload?.data || [];
    if (!Array.isArray(list) || list.length===0) break;
    out = out.concat(list);
    page++;
    await sleep(jitter(RATE_MS));
  }
  return out;
}

// ===== suiprivkey → address (pakai fromSecretKey) =====
const isSuipriv = (s)=> typeof s==='string' && s.startsWith('suiprivkey1');

function addressFromSuipriv(s){
  const { schema, secretKey } = decodeSuiPrivateKey(s); // secretKey: Uint8Array (32B seed pada ED25519)
  if (schema !== 'ED25519') throw new Error(`unsupported schema: ${schema}`);
  const kp = Ed25519Keypair.fromSecretKey(secretKey);   // <— FIX: fromSecretKey, bukan fromSeed
  return kp.getPublicKey().toSuiAddress();
}

// ===== optional fallback (hex/base64) – juga via fromSecretKey =====
function tryDecodeHex(sk){
  const h = sk.startsWith('0x') ? sk.slice(2) : sk;
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  try { return Uint8Array.from(Buffer.from(h,'hex')); } catch { return null; }
}
function tryDecodeBase64(sk){
  try {
    const b = Uint8Array.from(Buffer.from(sk,'base64'));
    return b.length ? b : null;
  } catch { return null; }
}
function addressFromRawBytes(bytes){
  // Ed25519Keypair.fromSecretKey menerima 32B (seed) *atau* 64B (secret)
  const kp = Ed25519Keypair.fromSecretKey(bytes.length === 32 ? bytes : bytes.slice(0,64));
  return kp.getPublicKey().toSuiAddress();
}

// ===== CSV =====
const toCsvRow = (a)=> a.map(v=>{
  const s=String(v??''); return (s.includes(',')||s.includes('"')||s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s;
}).join(',');
const writeCsv = (fp, header, rows)=>{
  const lines=[toCsvRow(header), ...rows.map(toCsvRow)];
  fs.writeFileSync(fp, lines.join('\n'));
};

// ===== main =====
async function main(){
  const lines = readLines(path.resolve(__dirname, INPUT));
  if (lines.length===0){
    console.error(`[err] ${INPUT} kosong. Isi dengan suiprivkey (satu per baris).`);
    process.exit(1);
  }
  if (!INVITE_CODE && !CHECK_ONLY){
    console.error(`[err] INVITE_CODE belum di-set (contoh: INVITE_CODE=VVXWHGWL). Atau pakai CHECK_ONLY=1`);
    process.exit(1);
  }

  const summary = [];
  console.log(`== Creek Aura Referral (keys=${lines.length}; strict=${!ALLOW_FALLBACK}) ==`);
  if (agent) console.log('Proxy ON');

  for (let i=0;i<lines.length;i++){
    const keyLine = lines[i];
    console.log(`\n[${i+1}/${lines.length}] key(first12)=${keyLine.slice(0,12)}…`);

    let addr;
    try {
      if (isSuipriv(keyLine)) {
        addr = addressFromSuipriv(keyLine);
      } else if (ALLOW_FALLBACK) {
        const bytes = tryDecodeHex(keyLine) ?? tryDecodeBase64(keyLine);
        if (!bytes) throw new Error('unsupported key format (enable ALLOW_FALLBACK=1 to parse hex/base64)');
        addr = addressFromRawBytes(bytes);
      } else {
        throw new Error('baris bukan suiprivkey1… (set ALLOW_FALLBACK=1 kalau mau dukung hex/base64)');
      }
      console.log(` - derived address: ${addr}`);
    } catch(e){
      console.warn(` - gagal derive: ${e.message}`);
      continue;
    }

    await sleep(jitter(RATE_MS));
    let info=null, created=false;

    const first = await getInfo(addr).catch(e=>e);
    if (first?.response){
      const st = first.response.status;
      const body = first.response.data;
      if (st===404 || body?.msg==='User not found' || body?.code===404){
        console.log(' - user belum terdaftar (404).');
      } else {
        console.warn(` - getInfo error http=${st} body=${JSON.stringify(body)}`);
      }
    } else if (first?.code===0 || first?.data){
      info = first;
    }

    if (!info && !CHECK_ONLY){
      await sleep(jitter(RATE_MS));
      const cc = await connect(addr, INVITE_CODE);
      if (cc?.code===0 && cc?.data?.user){
        created = !!cc.data.invitation_created;
        console.log(` - connect OK (created=${created}) · invite_code=${cc.data?.user?.invite_code || cc.data?.invite_code || '-'}`);
      } else {
        console.warn(` - connect gagal resp=${JSON.stringify(cc)}`);
      }
      await sleep(jitter(RATE_MS));
      info = await getInfo(addr).catch(()=>null);
    }

    if (!info?.data){
      console.warn(' - info tidak tersedia. lanjut…');
      continue;
    }

    const d  = info.data || {};
    const u  = d.user || {};
    const myInvite = u.invite_code || d.invite_code || '-';
    const totalPts = d.total_points ?? 0;
    const invites  = d.invite_count ?? 0;
    const rank     = d.rank ?? '';
    console.log(` - invite_code=${myInvite} total_points=${totalPts} invite_count=${invites} rank=${rank}`);

    const invitees = await getInvitees(addr);
    console.log(` - invitees fetched: ${invitees.length}`);

    const fDetail = path.resolve(__dirname, OUTDIR, `invitees_${addr}.csv`);
    writeCsv(
      fDetail,
      ['inviter','invitee','joined_at','points','tasks_completed','raw_json'],
      invitees.map(it=>[
        addr,
        it.address || it.wallet_address || '',
        it.joined_at || it.created_at || '',
        it.points ?? it.total_points ?? '',
        it.tasks_completed ?? '',
        JSON.stringify(it),
      ])
    );

    summary.push([
      addr,
      myInvite,
      totalPts,
      invites,
      d.invitees_total_points ?? '',
      d.has_checked_in_today ? 1 : 0,
      created ? 1 : 0,
    ]);

    console.log(` - CSV: ${fDetail}`);
  }

  const fSum = path.resolve(__dirname, OUTDIR, 'ref_summary_sui.csv');
  writeCsv(fSum,
    ['address','invite_code','total_points','invite_count','invitees_total_points','checked_in_today','connected_now'],
    summary
  );
  console.log(`\n✅ Done. Summary → ${fSum}`);
}

main().catch((e)=>{
  console.error('[fatal]', e?.response?.status, e?.response?.data || e);
  process.exit(1);
});
