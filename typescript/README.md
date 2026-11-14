# Autopay in TypeScript

The reference implementation. See the [main README](../README.md) for what it does, every setting,
the state file and the safety notes.

Needs Node 22.18 or newer: the tests are TypeScript files that Node runs directly, with no extra tool.

```sh
npm install
npm run build
cp ../.env.example .env     # then edit it
DRY_RUN=1 npm start -- once # prints what it would send
npm start -- watch          # runs until stopped
```

`npm start` loads `.env` from this folder if there is one.

```sh
npm test       # unit tests, no network
npm run lint   # types, eslint, prettier
```

Layout:

| File             | Role                                          |
| ---------------- | --------------------------------------------- |
| `src/config.ts`  | reads and checks the environment              |
| `src/api.ts`     | the Unaligned API calls                       |
| `src/amounts.ts` | decimal string to integer base units, exactly |
| `src/state.ts`   | the state file, written atomically            |
| `src/autopay.ts` | `step()`: one check-and-top-up cycle          |
| `src/main.ts`    | `once` / `watch`, exit codes                  |
