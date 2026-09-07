// Chess.com DOM injector
(function() {
  'use strict';

  const API_BASE = 'http://localhost:3002';
  let lastFEN = '';
  let overlayDiv = null;

  function createOverlay() {
    if (overlayDiv) return overlayDiv;
    overlayDiv = document.createElement('div');
    overlayDiv.id = 'chess-ai-hub-overlay';
    overlayDiv.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      width: 320px;
      background: rgba(0, 0, 0, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(20px);
    `;
    document.body.appendChild(overlayDiv);
    return overlayDiv;
  }

  // 从 Chess.com DOM 提取 FEN
  function extractFEN() {
    // Chess.com stores game state in window.chessboard or similar
    // Try multiple strategies:
    
    // 1. From window.chessboard (if exposed)
    if (typeof window.chessboard !== 'undefined' && window.chessboard.getFEN) {
      return window.chessboard.getFEN();
    }

    // 2. From data attributes
    const board = document.querySelector('.board');
    if (board && board.dataset.fen) {
      return board.dataset.fen;
    }

    // 3. Parse from DOM pieces (fallback)
    // This is complex and requires reverse-engineering Chess.com's board structure
    // For MVP, rely on FEN from meta/data attributes

    return null;
  }

  async function getAIAnalysis(fen) {
    try {
      await fetch(`${API_BASE}/api/engine/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'chess' }),
      });

      await fetch(`${API_BASE}/api/engine/new-game`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'chess', fen }),
      });

      const response = await fetch(`${API_BASE}/api/engine/analyze?variant=chess&depth=20&multipv=3`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const json = JSON.parse(line.slice(6));
            if (json.ok && json.analysis) {
              reader.cancel();
              return json.analysis;
            }
          }
        }
        if (lines.length > 3) {
          reader.cancel();
          break;
        }
      }
      return null;
    } catch (err) {
      console.error('[Chess AI Hub] Analysis error:', err);
      return null;
    }
  }

  function renderAnalysis(analysis) {
    const overlay = createOverlay();
    if (!analysis || !analysis.multiPv || analysis.multiPv.length === 0) {
      overlay.innerHTML = `
        <div style="color: #888; font-size: 13px;">
          <strong style="color: #fff;">Chess AI Hub</strong><br/>
          <span style="font-size: 11px;">Analyzing...</span>
        </div>
      `;
      return;
    }

    const winRate = Math.round(analysis.winRate * 100);
    const scoreCp = analysis.scoreCp !== undefined ? (analysis.scoreCp / 100).toFixed(2) : '—';

    let html = `
      <div style="margin-bottom: 12px;">
        <strong style="color: #fff; font-size: 14px;">Chess AI Hub</strong>
        <div style="margin-top: 6px; font-size: 12px; color: #aaa;">
          Win Rate: <strong style="color: ${winRate >= 55 ? '#10B981' : winRate >= 45 ? '#F59E0B' : '#EF4444'};">${winRate}%</strong>
          <span style="margin-left: 12px;">Score: <strong style="color: #818CF8;">${scoreCp > 0 ? '+' : ''}${scoreCp}</strong></span>
        </div>
      </div>
      <div style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; margin-top: 10px;">
        <div style="font-size: 11px; color: #666; text-transform: uppercase; margin-bottom: 8px;">Top Moves</div>
    `;

    for (let i = 0; i < Math.min(3, analysis.multiPv.length); i++) {
      const line = analysis.multiPv[i];
      const moveWr = Math.round(line.winRate * 100);
      const moveCp = line.scoreCp !== undefined ? (line.scoreCp / 100).toFixed(2) : '—';
      html += `
        <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size: 12px;">
          <div style="color: #fff; font-weight: 600; margin-bottom: 3px;">
            #${i + 1} ${line.move}
            <span style="float: right; color: ${moveWr >= 55 ? '#10B981' : moveWr >= 45 ? '#F59E0B' : '#EF4444'}; font-size: 11px;">${moveWr}%</span>
          </div>
          <div style="color: #888; font-size: 10px; font-family: monospace;">
            ${line.pv.slice(0, 6).join(' ')}
          </div>
        </div>
      `;
    }

    html += `</div>`;
    overlay.innerHTML = html;
  }

  let analyzing = false;
  setInterval(async () => {
    if (analyzing) return;
    const fen = extractFEN();
    if (!fen || fen === lastFEN) return;
    
    lastFEN = fen;
    analyzing = true;
    console.log('[Chess AI Hub] New position detected:', fen);
    
    const analysis = await getAIAnalysis(fen);
    if (analysis) {
      renderAnalysis(analysis);
    }
    analyzing = false;
  }, 2000);

  console.log('[Chess AI Hub] Chess.com injector loaded');
})();
