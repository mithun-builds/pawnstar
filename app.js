'use strict';

// ── Constants ─────────────────────────────────────────────
const PIECE_UNICODE = {
  wK:'♚', wQ:'♛', wR:'♜', wB:'♝', wN:'♞', wP:'♟',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};
const BLUNDER_CP    = 200;
const MISTAKE_CP    = 100;
const INACCURACY_CP = 50;
const IMMORTAL_PGN  =
  '1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 ' +
  '6. Nf3 Qh6 7. d3 Nh5 8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 ' +
  '11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8 ' +
  '15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 ' +
  '19. e5 Qxa1+ 20. Ke2 Na6 21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7#';

// ── UI State ───────────────────────────────────────────────
let playerColor   = 'white';
const analysisDepth = 15;
let busy          = false;

// ── Navigator State (populated after analysis) ─────────────
let navSnaps    = [];   // { mv, turn, fenBefore, fenAfter } per move
let navEvals    = [];   // { cp, bestMove, turn } per position (length = snaps + 1)
let navEvents   = {};   // keyed by move index → event object (for flagged moves)
let navStep     = 0;    // current step (0 = start, 1..N = after move N)
let navTotal    = 0;    // total moves

// ── Color / Depth toggles ──────────────────────────────────
function setColor(c) {
  playerColor = c;
  document.getElementById('btnWhite').classList.toggle('active', c === 'white');
  document.getElementById('btnBlack').classList.toggle('active', c === 'black');
}

function updateBtn() {
  const btn    = document.getElementById('analyzeBtn');
  const hasVal = document.getElementById('pgnInput').value.trim().length > 0;
  btn.classList.toggle('ready', hasVal);
}

// ── Sample / Upload ────────────────────────────────────────
function loadSample() {
  document.getElementById('pgnInput').value = IMMORTAL_PGN;
  updateBtn();
}

function resetApp() {
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('progressCard').style.display   = 'none';
  document.getElementById('inputCard').style.display      = 'block';
  document.getElementById('navResetBtn').style.display    = 'none';
  document.getElementById('pgnInput').value               = '';
  navSnaps = []; navEvals = []; navEvents = {}; navStep = 0; navTotal = 0;
  updateBtn();
  document.querySelector('.main').scrollIntoView({ behavior: 'smooth' });
}

// ── Local Stockfish 16 Worker ─────────────────────────────
let sfWorker = null;

function bootEngine(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(url); } catch (e) { return reject(e); }

    const timer = setTimeout(() => {
      w.onerror = null;
      w.terminate();
      reject(new Error('engine timed out'));
    }, timeoutMs);

    w.onerror = () => {
      clearTimeout(timer);
      w.onerror = null;
      w.terminate();
      reject(new Error('worker error'));
    };

    let gotUci = false;
    const onMsg = e => {
      const line = (typeof e.data === 'string' ? e.data : '').trim();
      if (!line) return;
      if (!gotUci && line.includes('uciok')) {
        gotUci = true;
        w.postMessage('setoption name Use NNUE value true');
        w.postMessage('setoption name EvalFile value nn-5af11540bbfe.nnue');
        w.postMessage('isready');
        return;
      }
      if (line.includes('readyok')) {
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.onerror = null;
        resolve(w);
      }
    };
    w.addEventListener('message', onMsg);
    setTimeout(() => w.postMessage('uci'), 500);
  });
}

async function loadStockfishWorker() {
  setProgress('Loading Stockfish 16…', 5);
  return await bootEngine('./stockfish-16.js', 20000);
}

function evaluate(worker, fen, depth) {
  // Detect terminal positions before asking the engine
  const probe = new Chess(fen);
  if (probe.game_over()) {
    if (probe.in_checkmate()) {
      const loser = fen.split(' ')[1];
      return Promise.resolve({ cp: loser === 'w' ? -30000 : 30000, bestMove: null });
    }
    return Promise.resolve({ cp: 0, bestMove: null });
  }

  return new Promise(resolve => {
    let bestCp = 0, bestMove = null;
    const onMsg = e => {
      const line = (typeof e.data === 'string' ? e.data : '').trim();
      if (!line) return;
      const mateM = line.match(/score mate (-?\d+)/);
      const cpM   = line.match(/score cp (-?\d+)/);
      if (mateM) bestCp = parseInt(mateM[1]) > 0 ? 30000 : -30000;
      else if (cpM) bestCp = parseInt(cpM[1]);
      if (line.startsWith('bestmove')) {
        bestMove = line.split(' ')[1] || null;
        worker.removeEventListener('message', onMsg);
        resolve({ cp: bestCp, bestMove });
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage('stop');
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

// ── Board renderer ─────────────────────────────────────────
function parseFen(fen) {
  return fen.split(' ')[0].split('/').map(row => {
    const cells = [];
    for (const ch of row) {
      if ('12345678'.includes(ch)) for (let i = 0; i < +ch; i++) cells.push(null);
      else cells.push({ c: ch === ch.toUpperCase() ? 'w' : 'b', t: ch.toLowerCase() });
    }
    return cells;
  });
}
function pieceGlyph(p) {
  if (!p) return '';
  const key = p.c + p.t.toUpperCase();
  return `<img class="piece-img" src="pieces/${key}.svg" alt="" draggable="false" />`;
}

function renderBoard(fen, fromSq, toSq, flip = 'white', bestFrom = null, bestTo = null) {
  const board = parseFen(fen);
  const FILES = ['a','b','c','d','e','f','g','h'];
  const RANKS = ['8','7','6','5','4','3','2','1'];
  const df = flip === 'black' ? [...FILES].reverse() : FILES;
  const dr = flip === 'black' ? [...RANKS].reverse() : RANKS;

  let html = '<div class="chess-board-container">';
  dr.forEach((rank, ri) => {
    html += '<div class="board-row-outer">';
    html += `<div class="rank-label">${rank}</div><div class="chess-board">`;
    df.forEach((file, fi) => {
      const piece = board[RANKS.indexOf(rank)]?.[FILES.indexOf(file)] ?? null;
      const sq    = file + rank;
      const light = (fi + ri) % 2 === 0;
      let cls = `board-square ${light ? 'light' : 'dark'}`;
      if (sq === bestFrom || sq === bestTo) cls += ' highlight-best';
      if (sq === fromSq || sq === toSq) cls += ' highlight-moved';
      html += `<div class="${cls}" title="${sq}">${piece ? `<span class="piece ${piece.c === 'w' ? 'white-piece' : 'black-piece'}">${pieceGlyph(piece)}</span>` : ''}</div>`;
    });
    html += '</div></div>';
  });
  html += '<div class="board-files-row">';
  df.forEach(f => { html += `<div class="file-label">${f}</div>`; });
  html += '</div></div>';
  return html;
}

// ── Eval utilities ─────────────────────────────────────────
function cpFromWhite(cp, turn) { return turn === 'w' ? cp : -cp; }

function formatCp(cp) {
  if (Math.abs(cp) > 20000) {
    const m = Math.ceil((30000 - Math.abs(cp)) / 2);
    return cp > 0 ? `M${m}` : `-M${m}`;
  }
  const v = (cp / 100).toFixed(2);
  return cp > 0 ? `+${v}` : `${v}`;
}

function evalBarHTML(cpWhite) {
  const pct = 50 + 50 * Math.tanh(cpWhite / 700);
  return `
    <div class="eval-bar-wrap">
      <span class="eval-bar-side" style="text-align:right">Black</span>
      <div class="eval-bar-track"><div class="eval-bar-white" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="eval-bar-side">White</span>
      <div class="eval-bar-score">${formatCp(Math.round(cpWhite))}</div>
    </div>`;
}

function classify(loss) {
  if (loss >= BLUNDER_CP)    return 'blunder';
  if (loss >= MISTAKE_CP)    return 'mistake';
  if (loss >= INACCURACY_CP) return 'inaccuracy';
  return 'best';
}
const SEV_SYM  = { blunder:'??', mistake:'?', inaccuracy:'?!', best:'!!' };
const SEV_ICON = { blunder:'💥', mistake:'⚠️', inaccuracy:'⚡', best:'✓' };

function buildVariation(fenBefore, bestUCI, plyCount = 4) {
  if (!bestUCI || bestUCI === '(none)') return null;
  const temp = new Chess(fenBefore);
  const lines = [];
  let cur = bestUCI;
  for (let i = 0; i < plyCount; i++) {
    const from  = cur.slice(0, 2), to = cur.slice(2, 4);
    const promo = cur.length > 4 ? cur[4] : undefined;
    const legal = temp.moves({ verbose: true });
    const m     = legal.find(mv => mv.from === from && mv.to === to);
    if (!m) break;
    const res = temp.move({ from: m.from, to: m.to, promotion: promo ?? (m.flags.includes('p') ? 'q' : undefined) });
    if (!res) break;
    const mn  = Math.ceil(temp.history().length / 2);
    lines.push(`${res.color === 'b' ? mn + '...' : mn + '.'} ${res.san}`);
    const replies = temp.moves({ verbose: true });
    if (!replies.length) break;
    const reply = replies.find(mv => mv.piece === 'p' && ['d','e'].includes(mv.to[0])) ?? replies[0];
    cur = reply.from + reply.to;
  }
  return lines.length ? lines.join('  ') : null;
}

// ── Progress UI ────────────────────────────────────────────
function setProgress(msg, pct, moveLine = '') {
  const sub  = document.getElementById('progressSub');
  const fill = document.getElementById('progressFill');
  const mvs  = document.getElementById('progressMoves');
  if (sub)  sub.textContent  = msg;
  if (fill) fill.style.width = `${Math.min(100, pct)}%`;
  if (mvs)  mvs.textContent  = moveLine;
}

// ── Analysis ───────────────────────────────────────────────
async function startAnalysis() {
  if (busy) return;
  const pgn   = document.getElementById('pgnInput').value.trim();
  const depth = analysisDepth;

  if (!pgn) {
    const ta = document.getElementById('pgnInput');
    ta.style.animation = 'shake .4s ease';
    ta.style.borderColor = '#ef4444';
    setTimeout(() => { ta.style.animation = ''; ta.style.borderColor = ''; }, 800);
    return;
  }

  const check = new Chess();
  if (!check.load_pgn(pgn)) { alert('Invalid PGN. Please check your game notation.'); return; }

  busy = true;
  document.getElementById('analyzeBtn').disabled = true;
  document.getElementById('inputCard').style.display     = 'none';
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('progressCard').style.display  = 'block';

  try {
    sfWorker = await loadStockfishWorker();

    setProgress('Parsing game…', 9);
    const chess   = new Chess();
    chess.load_pgn(pgn);
    const history = chess.history({ verbose: true });
    if (!history.length) throw new Error('No moves found in PGN.');

    // Build snapshots
    const replay = new Chess();
    const snaps  = history.map(mv => {
      const fenBefore = replay.fen();
      const turn      = fenBefore.split(' ')[1];
      replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      return { mv, turn, fenBefore, fenAfter: replay.fen() };
    });

    // Evaluate all positions
    // Starting position is definitionally equal (0 cp) — skip engine eval
    const evals = [];
    evals.push({ cp: 0, bestMove: null, turn: 'w' });

    for (let i = 0; i < snaps.length; i++) {
      setProgress('Evaluating with Stockfish…', 10 + (i / snaps.length) * 82, `Move ${i+1}/${snaps.length}: ${snaps[i].mv.san}`);
      const ev = await evaluate(sfWorker, snaps[i].fenAfter, depth);
      evals.push({ cp: ev.cp, bestMove: ev.bestMove, turn: snaps[i].fenAfter.split(' ')[1] });
    }

    sfWorker.terminate(); sfWorker = null;

    // Classify & build events map (keyed by move index)
    const eventsMap  = {};
    const eventsList = [];
    const playerTurn = playerColor === 'white' ? 'w' : 'b';

    for (let i = 0; i < snaps.length; i++) {
      const { mv, turn, fenBefore, fenAfter } = snaps[i];
      // Clamp mate scores so we don't blow up loss calculation
      const clampCp = x => Math.max(-1500, Math.min(1500, x));
      const wpBefore = clampCp(cpFromWhite(evals[i].cp, evals[i].turn));
      const wpAfter  = clampCp(cpFromWhite(evals[i+1].cp, evals[i+1].turn));
      const loss     = turn === 'w' ? wpBefore - wpAfter : wpAfter - wpBefore;
      // Checkmate-delivering moves are always best.
      const deliversMate = mv.san.endsWith('#');
      // If the engine's top recommendation equals the move actually played,
      // treat it as best — small eval drift between searches is just noise.
      const engineUci = evals[i].bestMove;
      const playedUci = mv.from + mv.to + (mv.promotion || '');
      const isEngineBest = engineUci && engineUci.slice(0, 4) === playedUci.slice(0, 4);
      const cls = (deliversMate || isEngineBest) ? 'best' : classify(loss);
      const isPlayer = turn === playerTurn;

      const event = { moveNum: Math.ceil((i+1)/2), moveSide: turn, san: mv.san,
        from: mv.from, to: mv.to, piece: mv.piece.toUpperCase(),
        cls, wpBefore, wpAfter, loss, fenBefore, fenAfter,
        variation: cls !== 'best' ? buildVariation(fenBefore, evals[i].bestMove, 4) : null,
        bestMove: evals[i].bestMove, isPlayer, index: i };

      // Store every move's classification in the map for the navigator
      eventsMap[i] = event;

      // Only push notable events for summary stats
      if ((isPlayer && cls !== 'best') || cls === 'blunder') {
        eventsList.push(event);
      }
    }

    // Store in module-level state for navigator
    navSnaps  = snaps;
    navEvals  = evals;
    navEvents = eventsMap;
    navTotal  = snaps.length;
    navStep   = 0;

    setProgress('Generating commentary…', 98);
    await new Promise(r => setTimeout(r, 300));
    renderResults(eventsList, history.length);

  } catch (err) {
    console.error(err);
    document.getElementById('progressCard').style.display = 'none';
    document.getElementById('inputCard').style.display    = 'block';
    alert(`Analysis failed: ${err.message}`);
  } finally {
    busy = false;
    document.getElementById('analyzeBtn').disabled = false;
  }
}

// ── Render Results ─────────────────────────────────────────
function renderResults(events, totalMoves) {
  document.getElementById('progressCard').style.display   = 'none';
  document.getElementById('resultsSection').style.display = 'block';
  document.getElementById('navResetBtn').style.display    = 'inline-block';

  const pEvents      = events.filter(e => e.isPlayer);
  const blunders     = pEvents.filter(e => e.cls === 'blunder').length;
  const mistakes     = pEvents.filter(e => e.cls === 'mistake').length;
  const inaccuracies = pEvents.filter(e => e.cls === 'inaccuracy').length;
  const accuracy     = Math.max(0, Math.round(100 - blunders * 8 - mistakes * 4 - inaccuracies * 2));
  const accCls       = accuracy >= 80 ? 'good' : accuracy >= 60 ? 'ok' : 'bad';

  document.getElementById('summaryStrip').innerHTML =
    [['Accuracy', accuracy + '%', accCls],
     ['Blunders', blunders, 'ugly'],
     ['Mistakes', mistakes, 'bad'],
     ['Inaccuracies', inaccuracies, 'ok'],
     ['Total Moves', totalMoves, 'neutral']]
    .map(([lbl, val, cls]) => `
      <div class="stat-card">
        <div class="stat-label">${lbl}</div>
        <div class="stat-val ${cls}">${val}</div>
      </div>`).join('');

  // Render step 0 (starting position)
  navStep = 0;
  renderStep(navStep);

  document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Step Navigator ────────────────────────────────────────
function renderStep(step) {
  const boardEl   = document.getElementById('navBoard');
  const evalEl    = document.getElementById('navEval');
  const commentEl = document.getElementById('navCommentary');
  const counterEl = document.getElementById('navCounter');
  const moveLabel = document.getElementById('navMoveLabel');

  // Determine FEN and move info for this step
  let fen, fromSq = null, toSq = null;
  if (step === 0) {
    fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  } else {
    const snap = navSnaps[step - 1];
    fen   = snap.fenAfter;
    fromSq = snap.mv.from;
    toSq   = snap.mv.to;
  }

  // Board
  boardEl.innerHTML = renderBoard(fen, fromSq, toSq, playerColor);

  // Eval bar
  const cpWhite = cpFromWhite(navEvals[step].cp, navEvals[step].turn);
  const pctW = Math.max(0, Math.min(100, 50 + 50 * Math.tanh(cpWhite / 700)));
  const pctB = 100 - pctW;
  evalEl.innerHTML = `
    <div class="nav-eval-bar">
      <span class="nav-eval-side white-side">♔ ${Math.round(pctW)}%</span>
      <div class="nav-eval-track">
        <div class="nav-eval-white" style="width:${pctW.toFixed(1)}%"></div>
      </div>
      <span class="nav-eval-side black-side">${Math.round(pctB)}% ♚</span>
    </div>
    <div class="nav-eval-score">${formatCp(Math.round(cpWhite))} eval</div>`;

  // Counter
  counterEl.textContent = `${step}/${navTotal}`;

  // Move label
  if (step === 0) {
    moveLabel.textContent = 'Press → to begin';
    moveLabel.className = 'nav-move-label hint';
  } else {
    const ev = navEvents[step - 1];
    const snap = navSnaps[step - 1];
    const moveNum = Math.ceil(step / 2);
    const dot = snap.turn === 'w' ? `${moveNum}.` : `${moveNum}...`;
    moveLabel.textContent = `${dot} ${snap.mv.san}`;
    moveLabel.className = 'nav-move-label';
  }

  // Commentary — show for every move (including best)
  const ev = step > 0 ? navEvents[step - 1] : null;
  if (ev) {
    // Compute the "best move" SAN from UCI
    let bestSan = null, bestFrom = null, bestTo = null;
    if (ev.bestMove && ev.bestMove !== '(none)') {
      bestFrom = ev.bestMove.slice(0, 2);
      bestTo   = ev.bestMove.slice(2, 4);
      const promo = ev.bestMove.length > 4 ? ev.bestMove[4] : undefined;
      try {
        const sim = new Chess(ev.fenBefore);
        const mv = sim.move({ from: bestFrom, to: bestTo, promotion: promo || 'q' });
        if (mv) bestSan = mv.san;
      } catch (_) {}
    }

    const isBest = ev.cls === 'best';
    const isSameMove = bestSan === ev.san;
    const playedEvalStr = formatCp(Math.round(ev.wpAfter));
    const altEvalStr    = formatCp(Math.round(ev.wpBefore));

    // Always show side-by-side: "You played" on the left, "Best move" on the right.
    // When the played move IS the best move, both columns show the same move but
    // the right stays highlighted green for consistency.
    const sidePlayedLabel = ev.moveSide === 'w' ? 'White played' : 'Black played';

    const samePosition = isBest || isSameMove;

    let bodyHTML;
    if (samePosition) {
      // Played move matches engine's top choice — show a single "Best move" card
      const bestLabel = ev.moveSide === 'w' ? 'White · Best move' : 'Black · Best move';
      bodyHTML = `
        <div class="alt-comparison single">
          <div class="alt-col best-match">
            <div class="alt-label">${bestLabel}</div>
            <div class="alt-move">${ev.san}</div>
            <div class="alt-mini-board best">${renderBoard(ev.fenAfter, ev.from, ev.to, playerColor)}</div>
            <div class="alt-eval gain">${playedEvalStr}</div>
          </div>
        </div>`;
    } else if (bestSan) {
      // Played move differs from engine's top — show side-by-side
      bodyHTML = `
        <div class="alt-comparison">
          <div class="alt-col ${ev.cls}">
            <div class="alt-label">${sidePlayedLabel}</div>
            <div class="alt-move">${ev.san}</div>
            <div class="alt-mini-board ${ev.cls}">${renderBoard(ev.fenAfter, ev.from, ev.to, playerColor)}</div>
            <div class="alt-eval loss">${playedEvalStr}</div>
          </div>
          <div class="alt-col best-match">
            <div class="alt-label">Best move</div>
            <div class="alt-move">${bestSan}</div>
            <div class="alt-mini-board best">${renderBoard(ev.fenBefore, null, null, playerColor, bestFrom, bestTo)}</div>
            <div class="alt-eval gain">${altEvalStr}</div>
          </div>
        </div>`;
    } else {
      // No best move info available — just show what was played
      bodyHTML = `
        <div class="alt-comparison single">
          <div class="alt-col">
            <div class="alt-label">${sidePlayedLabel}</div>
            <div class="alt-move">${ev.san}</div>
            <div class="alt-mini-board">${renderBoard(ev.fenAfter, ev.from, ev.to, playerColor)}</div>
            <div class="alt-eval">${playedEvalStr}</div>
          </div>
        </div>`;
    }

    // Header: severity tag + eval chips (only for non-best moves)
    const headerHTML = !isBest ? `
        <div class="nav-comment-header">
          <span class="sev-tag ${ev.cls}">${ev.cls.toUpperCase()}</span>
          <span class="nav-comment-evals">
            <span class="eval-chip before">${formatCp(Math.round(ev.wpBefore))}</span>
            <span class="eval-arrow">→</span>
            <span class="eval-chip ${ev.loss > 50 ? 'loss' : 'after'}">${playedEvalStr}</span>
          </span>
        </div>` : '';

    commentEl.innerHTML = `
      <div class="nav-comment-card ${ev.cls}">
        ${headerHTML}
        ${bodyHTML}
      </div>`;
    commentEl.style.display = 'block';
  } else {
    commentEl.innerHTML = '';
    commentEl.style.display = 'none';
  }

  // Update button states
  document.getElementById('navFirst').disabled = step === 0;
  document.getElementById('navPrev').disabled  = step === 0;
  document.getElementById('navNext').disabled  = step >= navTotal;
  document.getElementById('navLast').disabled  = step >= navTotal;
}

function navFirst() { navStep = 0; renderStep(navStep); }
function navPrev()  { if (navStep > 0) { navStep--; renderStep(navStep); } }
function navNext()  { if (navStep < navTotal) { navStep++; renderStep(navStep); } }
function navLast()  { navStep = navTotal; renderStep(navStep); }

// ── File Upload ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const pgnInput  = document.getElementById('pgnInput');

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { pgnInput.value = ev.target.result.trim(); updateBtn(); };
    reader.readAsText(file);
    fileInput.value = '';
  });

  pgnInput.addEventListener('input', updateBtn);
  pgnInput.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startAnalysis();
  });

  // Arrow key navigation for move navigator
  document.addEventListener('keydown', e => {
    if (navTotal === 0) return;
    const results = document.getElementById('resultsSection');
    if (results.style.display === 'none') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); navNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); navPrev(); }
    else if (e.key === 'Home') { e.preventDefault(); navFirst(); }
    else if (e.key === 'End') { e.preventDefault(); navLast(); }
  });

  // Drag-and-drop on upload zone
  const zone = document.getElementById('uploadZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = '#111'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (file) { const r = new FileReader(); r.onload = ev => { pgnInput.value = ev.target.result.trim(); updateBtn(); }; r.readAsText(file); }
  });
});
