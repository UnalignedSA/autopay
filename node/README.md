# Autopay in JavaScript

Plain Node.js (ES modules, no build step, no TypeScript), with JSDoc types where they help a reader. It
behaves exactly like the [TypeScript reference](../typescript). See the [main README](../README.md) for
what it does, every setting, the state file and the safety notes.

Needs Node 22.9 or newer (for `--env-file-if-exists`).

```sh
npm install
cp ../.env.example .env      # then edit it
DRY_RUN=1 npm start -- once  # prints what it would send
npm start -- watch           # runs until stopped
```

`npm start` loads `.env` from this folder if there is one (Node's `--env-file-if-exists`). Node ends an
unquoted value at `#`: wrap any value that contains `#`, `$`, spaces or quotes in single quotes, which Node
takes literally. You can also run `node src/main.js once`
yourself with the variables set in the environment.

```sh
npm test       # unit tests (node --test), no network
npm run lint   # eslint and prettier
```

Layout:

| File             | Role                                          |
| ---------------- | --------------------------------------------- |
| `src/config.js`  | reads and checks the environment              |
| `src/api.js`     | the Unaligned API calls                       |
| `src/amounts.js` | decimal string to integer base units, exactly |
| `src/state.js`   | the state file, written atomically            |
| `src/autopay.js` | `step()`: one check-and-top-up cycle          |
| `src/payers/`    | one wallet per chain family                   |
| `src/main.js`    | `once` / `watch`, exit codes                  |
