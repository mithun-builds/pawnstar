# PawnStar

A local, browser-based chess game analyzer powered by Stockfish 16. Paste any PGN, step through every move, and see engine evaluations with side-by-side "you played" vs "better move" comparisons.

## Features

- **Stockfish 16 NNUE** running locally in a Web Worker — no API, no rate limits
- Move-by-move navigator with keyboard arrow support
- Visual eval bar (white/black advantage %)
- Side-by-side comparison: move you played vs engine's best move
- Accuracy, blunder, mistake, and inaccuracy counts
- Fully offline once loaded

## Running locally

A local web server is required (browsers block Web Workers over `file://`):

```bash
# macOS / Linux
./run.command

# or manually
python3 -m http.server 8080
```

Then open http://localhost:8080

## Hosting publicly

This is a static site — any static host works. See [deployment instructions](#deployment) below.

## Deployment

### GitHub Pages
1. Push this repo to GitHub
2. Settings → Pages → Source: `main` branch, `/` root
3. Site goes live at `https://USERNAME.github.io/REPO/`

### Netlify / Vercel / Cloudflare Pages
Drop the folder in (or connect the GitHub repo). No build step required.

Note: the NNUE weights file (`nn-5af11540bbfe.nnue`) is ~38MB. GitHub Pages serves it fine; some free tiers may compress or time out.

## License

GPL v3. See [LICENSE](LICENSE) for third-party component attributions (Stockfish, chess.js, Cburnett pieces, Poppins font).
