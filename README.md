```
npm init -y
npm install @mysten/sui dotenv
```
# change .env your privatekey

```
node auto.mjs
```

if you need run privatekey.txt multi account
```
SUI_PRIVATE_KEY="$(cat privatekey.txt)" node auto.mjs
```
