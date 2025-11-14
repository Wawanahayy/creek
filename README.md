```
npm init -y
npm install @mysten/sui dotenv
```
# change .env your privatekey

```
node auto.mjs
```

if you need run privatekey.txt multi account

Gnerate wallet
``` 
npm i @mysten/sui bip39 ed25519-hd-key tweetnacl @noble/hashes
``` 
```
node gen_suikeys.mjs                        # default -> 1 mnemonic × 10 keys
```
