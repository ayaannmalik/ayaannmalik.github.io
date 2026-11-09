# Browser chess engine

The game uses Stockfish.js **19.0.1**, the lightweight single-threaded build,
with `UCI_LimitStrength=true` and `UCI_Elo=1800`. Each move gets one second of
search. This is an approximate playing-strength target, **not a calibrated
Chess.com 1800 rating**. Stockfish's Elo calibration is anchored to CCRL at
120s+1s; the browser build, time budget and opponent pool also affect strength.

- Upstream: <https://github.com/nmrugg/stockfish.js/tree/v19.0.1>
- Source revision: `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`
- Source and build instructions: <https://github.com/nmrugg/stockfish.js/archive/refs/tags/v19.0.1.tar.gz>
- Network: <https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue>
- Distribution: <https://www.npmjs.com/package/stockfish/v/19.0.1>
- License: [GPL v3](LICENSE.txt); original notices remain in the engine file.
- Rating options: <https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html>

Unmodified files from `stockfish@19.0.1/bin/` (SHA-256):

```
ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a  stockfish-19-lite-single.js
ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de  stockfish-19-lite-single.wasm
```

The JavaScript and WASM files must remain adjacent. The worker is started only
when the engine needs to play; its small build requires neither shared memory
nor special cross-origin headers. A new game terminates the old worker and
reapplies the strength settings. Loading/search errors stop play with a retry
message; they never fall back to unrestricted best-move play.
