# PawnStar

A browser-based chess game analyzer powered by Stockfish 16. Paste any PGN, step through every move, and compare what you played to the engine's best alternative.

**Live site:** https://mithun-builds.github.io/pawnstar/

## Features

- **Stockfish 16 NNUE** running locally in a Web Worker — no API, no rate limits
- Move-by-move navigator with keyboard arrow support
- Visual eval bar showing white/black advantage
- Side-by-side comparison: your move vs engine's best move
- Accuracy, blunder, mistake, and inaccuracy counts per game
- Fully offline once loaded

## Running locally

A local web server is required (browsers block Web Workers over `file://`):

```bash
# macOS — double-click run.command, or run from terminal:
./run.command

# or manually:
python3 -m http.server 8080
```

Then open http://localhost:8080

## License

GPL v3. See [LICENSE](LICENSE) for third-party component attributions (Stockfish, chess.js, Cburnett pieces, Poppins font).
