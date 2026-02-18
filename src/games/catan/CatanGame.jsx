// CatanGame.jsx — Main game component for Colony of Catan

import React, { useState, useEffect, useRef, useCallback } from 'react';
import CatanBoard from './CatanBoard';
import {
  generateBoard,
  createPlayers,
  rollDice,
  collectResources,
  collectSetupResources,
  canAfford,
  deductCost,
  bankTrade,
  calculateVP,
  getValidRoadEdges,
  getValidCitySpots,
  isValidSettlementSpot,
  WIN_VP,
  RESOURCES,
} from './catanEngine';
import { npcPickSetupSettlement, npcPickSetupRoad, npcDecideTurn } from './catanNPC';
import './catan.css';

const RESOURCE_ICONS = { wood: '🌲', brick: '🧱', ore: '⛰️', grain: '🌾', wool: '🐑' };
const RESOURCE_NAMES = { wood: 'Wood', brick: 'Brick', ore: 'Ore', grain: 'Grain', wool: 'Wool' };
const ALL_RESOURCES = ['wood', 'brick', 'ore', 'grain', 'wool'];

/* ─── Phase constants ───────────────────────────────────────── */
const PHASE = {
  NAME_ENTRY:    'NAME_ENTRY',
  SETUP_SETTLE:  'SETUP_SETTLE',  // player placing settlement in setup
  SETUP_ROAD:    'SETUP_ROAD',    // player placing road in setup
  ROLL:          'ROLL',
  COLLECT:       'COLLECT',
  BUILD:         'BUILD',
  GAME_OVER:     'GAME_OVER',
};

/* ─── Setup order: 0,1,2,3,3,2,1,0 ─────────────────────────── */
function buildSetupOrder() {
  const fwd = [0, 1, 2, 3];
  return [...fwd, ...[...fwd].reverse()]; // 8 turns total
}
const SETUP_ORDER = buildSetupOrder();
const SETUP_ROUND2_START = 4; // index where reverse round starts

/* ═══════════════════════════════════════════════════════════════ */

export default function CatanGame({ identity, onExit }) {
  const [playerName, setPlayerName] = useState('');
  const [phase, setPhase] = useState(PHASE.NAME_ENTRY);
  const [board, setBoard] = useState(null);
  const [players, setPlayers] = useState([]);
  const [setupIdx, setSetupIdx] = useState(0);       // index into SETUP_ORDER
  const [setupVertex, setSetupVertex] = useState(null); // last placed settlement in setup
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [dice, setDice] = useState([null, null]);
  const [log, setLog] = useState([]);
  const [winner, setWinner] = useState(null);
  const [tradeGive, setTradeGive] = useState('');
  const [tradeReceive, setTradeReceive] = useState('');
  const [buildMode, setBuildMode] = useState(null); // null | 'settlement' | 'road' | 'city'
  const logRef = useRef(null);
  const npcTimer = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const addLog = useCallback((msg) => {
    setLog((prev) => [...prev.slice(-60), msg]);
  }, []);

  /* ─── Start game ─────────────────────────────────────────────── */
  function startGame() {
    if (!playerName.trim()) return;
    const newBoard = generateBoard();
    const newPlayers = createPlayers(playerName.trim());
    setBoard(newBoard);
    setPlayers(newPlayers);
    setSetupIdx(0);
    setSetupVertex(null);
    setPhase(PHASE.SETUP_SETTLE);
    setCurrentPlayer(SETUP_ORDER[0]);
    addLog('Game started! Place your first settlement.');
  }

  /* ─── Valid spots helpers ─────────────────────────────────────── */
  const validSettlements = () => {
    if (!board) return [];
    const cp = currentPlayer;
    const isSetup = phase === PHASE.SETUP_SETTLE;
    if (phase === PHASE.SETUP_SETTLE || (phase === PHASE.BUILD && buildMode === 'settlement')) {
      return board.vertices
        .filter((v) => isValidSettlementSpot(v.id, board.vertices, board.edges, cp, isSetup))
        .map((v) => v.id);
    }
    return [];
  };

  const validRoads = () => {
    if (!board) return [];
    if (phase === PHASE.SETUP_ROAD) {
      return getValidRoadEdges(board.edges, board.vertices, currentPlayer, true, setupVertex);
    }
    if (phase === PHASE.BUILD && buildMode === 'road') {
      return getValidRoadEdges(board.edges, board.vertices, currentPlayer, false);
    }
    return [];
  };

  const validCities = () => {
    if (!board) return [];
    if (phase === PHASE.BUILD && buildMode === 'city') {
      return getValidCitySpots(board.vertices, currentPlayer);
    }
    return [];
  };

  /* ─── Vertex click ───────────────────────────────────────────── */
  function handleVertexClick(vId) {
    if (currentPlayer !== 0) return; // Only human player clicks

    if (phase === PHASE.SETUP_SETTLE) {
      placeSettlement(vId, true);
    } else if (phase === PHASE.BUILD && buildMode === 'settlement') {
      if (!canAfford(players[0], 'settlement')) return;
      if (!isValidSettlementSpot(vId, board.vertices, board.edges, 0, false)) return;
      placeSettlement(vId, false);
      setBuildMode(null);
    } else if (phase === PHASE.BUILD && buildMode === 'city') {
      if (!canAfford(players[0], 'city')) return;
      if (board.vertices[vId].owner !== 0 || board.vertices[vId].building !== 'settlement') return;
      placeCity(vId);
      setBuildMode(null);
    }
  }

  /* ─── Edge click ─────────────────────────────────────────────── */
  function handleEdgeClick(eId) {
    if (currentPlayer !== 0) return;

    if (phase === PHASE.SETUP_ROAD) {
      const validE = getValidRoadEdges(board.edges, board.vertices, 0, true, setupVertex);
      if (!validE.includes(eId)) return;
      placeRoad(eId, true);
    } else if (phase === PHASE.BUILD && buildMode === 'road') {
      if (!canAfford(players[0], 'road')) return;
      const validE = getValidRoadEdges(board.edges, board.vertices, 0, false);
      if (!validE.includes(eId)) return;
      placeRoad(eId, false);
      setBuildMode(null);
    }
  }

  /* ─── Place settlement ───────────────────────────────────────── */
  function placeSettlement(vId, isSetup) {
  const cp = currentPlayer;
  const newVertices = board.vertices.map((v) =>
    v.id === vId ? { ...v, building: 'settlement', owner: cp } : v
  );

  let newPlayers;
  if (isSetup) {
    newPlayers = players.map((p) => ({ ...p }));
    if (setupIdx >= SETUP_ROUND2_START) {
      newPlayers[cp] = collectSetupResources(vId, board.hexes, newVertices, newPlayers[cp]);
    }
  } else {
    newPlayers = players.map((p) =>
      p.id === cp ? deductCost(p, 'settlement') : p
    );
  }

  newPlayers = newPlayers.map((p) => ({
    ...p,
    vp: calculateVP(p.id, newVertices),
  }));

  const newBoard = { ...board, vertices: newVertices };
  setBoard(newBoard);
  setPlayers(newPlayers);
  setSetupVertex(vId);

  addLog(`${players[cp].name} placed a settlement.`);

  if (isSetup) {
    setPhase(PHASE.SETUP_ROAD);
  }

  checkWin(newPlayers, newVertices);
}

  /* ─── Place road ─────────────────────────────────────────────── */
  function placeRoad(eId, isSetup) {
    const cp = currentPlayer;
    const newEdges = board.edges.map((e) =>
      e.id === eId ? { ...e, road: cp } : e
    );

    let newPlayers = [...players];
    if (!isSetup) {
      newPlayers = players.map((p) => p.id === cp ? deductCost(p, 'road') : p);
    }

    const newBoard = { ...board, edges: newEdges };
    setBoard(newBoard);
    setPlayers(newPlayers);

    addLog(`${players[cp].name} built a road.`);

    if (isSetup) {
      advanceSetup(newBoard, newPlayers);
    }
  }

  /* ─── Place city ─────────────────────────────────────────────── */
  function placeCity(vId) {
    const cp = currentPlayer;
    const newVertices = board.vertices.map((v) =>
      v.id === vId ? { ...v, building: 'city' } : v
    );
    let newPlayers = players.map((p) => p.id === cp ? deductCost(p, 'city') : p);
    newPlayers = newPlayers.map((p) => ({ ...p, vp: calculateVP(p.id, newVertices) }));

    setBoard({ ...board, vertices: newVertices });
    setPlayers(newPlayers);
    addLog(`${players[cp].name} upgraded to a city! 🏙️`);
    checkWin(newPlayers, newVertices);
  }

  /* ─── Setup advancement ──────────────────────────────────────── */
  function advanceSetup(currentBoard, currentPlayers) {
    const nextSetupIdx = setupIdx + 1;

    if (nextSetupIdx >= SETUP_ORDER.length) {
      // Setup complete, start main game with player 0
      setSetupIdx(0);
      setSetupVertex(null);
      setCurrentPlayer(0);
      setPhase(PHASE.ROLL);
      addLog('─── Setup complete! Game begins. Player 1: roll the dice! ───');
      return;
    }

    const nextPlayer = SETUP_ORDER[nextSetupIdx];
    setSetupIdx(nextSetupIdx);
    setSetupVertex(null);
    setCurrentPlayer(nextPlayer);

    if (nextPlayer !== 0) {
      // NPC goes next during setup
      setPhase(PHASE.SETUP_SETTLE);
      setTimeout(() => {
        runNPCSetup(nextSetupIdx, nextPlayer, currentBoard, currentPlayers);
      }, 800);
    } else {
      setPhase(PHASE.SETUP_SETTLE);
      const round = nextSetupIdx < SETUP_ROUND2_START ? 1 : 2;
      addLog(`Your turn (Round ${round}): Place a settlement.`);
    }
  }

  /* ─── NPC setup turn ─────────────────────────────────────────── */
  function runNPCSetup(idx, npcId, currentBoard, currentPlayers) {
    const isRound2 = idx >= SETUP_ROUND2_START;

    // Pick settlement
    const sVId = npcPickSetupSettlement(npcId, currentBoard.vertices, currentBoard.edges, currentBoard.hexes, true);
    if (sVId === null) {
      advanceSetupAfterNPC(idx, currentBoard, currentPlayers);
      return;
    }

    const newVertices = currentBoard.vertices.map((v) =>
      v.id === sVId ? { ...v, building: 'settlement', owner: npcId } : v
    );

    let newPlayers = [...currentPlayers];
    if (isRound2) {
      newPlayers[npcId] = collectSetupResources(sVId, currentBoard.hexes, newVertices, newPlayers[npcId]);
    }
    newPlayers = newPlayers.map((p) => ({ ...p, vp: calculateVP(p.id, newVertices) }));

    addLog(`${currentPlayers[npcId].name} placed a settlement.`);

    // Pick road
    const rEId = npcPickSetupRoad(npcId, currentBoard.edges, newVertices, sVId);
    let newEdges = currentBoard.edges;
    if (rEId !== null) {
      newEdges = currentBoard.edges.map((e) => e.id === rEId ? { ...e, road: npcId } : e);
      addLog(`${currentPlayers[npcId].name} built a road.`);
    }

    const newBoard = { ...currentBoard, vertices: newVertices, edges: newEdges };
    setBoard(newBoard);
    setPlayers(newPlayers);

    setTimeout(() => {
      advanceSetupAfterNPC(idx, newBoard, newPlayers);
    }, 400);
  }

  function advanceSetupAfterNPC(idx, currentBoard, currentPlayers) {
    const nextIdx = idx + 1;
    if (nextIdx >= SETUP_ORDER.length) {
      setSetupIdx(0);
      setSetupVertex(null);
      setCurrentPlayer(0);
      setPhase(PHASE.ROLL);
      addLog('─── Setup complete! Game begins. Your turn: roll the dice! ───');
      return;
    }
    const nextPlayer = SETUP_ORDER[nextIdx];
    setSetupIdx(nextIdx);
    setSetupVertex(null);
    setCurrentPlayer(nextPlayer);

    if (nextPlayer !== 0) {
      setTimeout(() => {
        runNPCSetup(nextIdx, nextPlayer, currentBoard, currentPlayers);
      }, 600);
    } else {
      const round = nextIdx < SETUP_ROUND2_START ? 1 : 2;
      setPhase(PHASE.SETUP_SETTLE);
      addLog(`Your turn (Round ${round}): Place a settlement.`);
    }
  }

  /* ─── Dice roll ──────────────────────────────────────────────── */
  function handleRoll() {
    if (phase !== PHASE.ROLL || currentPlayer !== 0) return;
    const [d1, d2] = rollDice();
    const total = d1 + d2;
    setDice([d1, d2]);
    addLog(`You rolled ${d1} + ${d2} = ${total}${total === 7 ? ' 🎲 Lucky 7 — no resources this roll!' : ''}`);

    const newPlayers = collectResources(total, board.hexes, board.vertices, players).map((p) => ({
      ...p,
      vp: calculateVP(p.id, board.vertices),
    }));
    setPlayers(newPlayers);
    setPhase(PHASE.BUILD);
  }

  /* ─── End turn ───────────────────────────────────────────────── */
  function handleEndTurn() {
    if (phase !== PHASE.BUILD || currentPlayer !== 0) return;
    setBuildMode(null);
    advanceTurn(1, board, players);
  }

  function advanceTurn(nextPlayerOffset, currentBoard, currentPlayers) {
    const nextPlayer = (currentPlayer + nextPlayerOffset) % 4;
    setCurrentPlayer(nextPlayer);

    if (nextPlayer !== 0) {
      setPhase(PHASE.ROLL); // placeholder while NPC thinks
      addLog(`${currentPlayers[nextPlayer].name}'s turn...`);
      npcTimer.current = setTimeout(() => {
        runNPCTurn(nextPlayer, currentBoard, currentPlayers);
      }, 900);
    } else {
      setPhase(PHASE.ROLL);
      setDice([null, null]);
      addLog('Your turn — roll the dice!');
    }
  }

  /* ─── NPC main turn ──────────────────────────────────────────── */
  function runNPCTurn(npcId, currentBoard, currentPlayers) {
    // Roll dice for NPC
    const [d1, d2] = rollDice();
    const total = d1 + d2;
    setDice([d1, d2]);
    addLog(`${currentPlayers[npcId].name} rolled ${d1}+${d2}=${total}`);

    let newPlayers = collectResources(total, currentBoard.hexes, currentBoard.vertices, currentPlayers).map((p) => ({
      ...p,
      vp: calculateVP(p.id, currentBoard.vertices),
    }));

    let newBoard = { ...currentBoard };

    // NPC decides actions
    const actions = npcDecideTurn(npcId, newPlayers, newBoard.vertices, newBoard.edges, newBoard.hexes);

    actions.forEach((action) => {
      if (action.type === 'settlement') {
        newBoard = {
          ...newBoard,
          vertices: newBoard.vertices.map((v) =>
            v.id === action.vertexId ? { ...v, building: 'settlement', owner: npcId } : v
          ),
        };
        newPlayers = newPlayers.map((p) =>
          p.id === npcId ? deductCost(p, 'settlement') : p
        );
        addLog(`${currentPlayers[npcId].name} built a settlement! 🏠`);
      } else if (action.type === 'city') {
        newBoard = {
          ...newBoard,
          vertices: newBoard.vertices.map((v) =>
            v.id === action.vertexId ? { ...v, building: 'city' } : v
          ),
        };
        newPlayers = newPlayers.map((p) =>
          p.id === npcId ? deductCost(p, 'city') : p
        );
        addLog(`${currentPlayers[npcId].name} built a city! 🏙️`);
      } else if (action.type === 'road') {
        newBoard = {
          ...newBoard,
          edges: newBoard.edges.map((e) =>
            e.id === action.edgeId ? { ...e, road: npcId } : e
          ),
        };
        newPlayers = newPlayers.map((p) =>
          p.id === npcId ? deductCost(p, 'road') : p
        );
        addLog(`${currentPlayers[npcId].name} built a road. 🛤️`);
      }
    });

    // Recompute VP
    newPlayers = newPlayers.map((p) => ({
      ...p,
      vp: calculateVP(p.id, newBoard.vertices),
    }));

    setBoard(newBoard);
    setPlayers(newPlayers);

    if (checkWin(newPlayers, newBoard.vertices)) return;

    // Next player
    const nextPlayer = (npcId + 1) % 4;
    setCurrentPlayer(nextPlayer);
    if (nextPlayer !== 0) {
      npcTimer.current = setTimeout(() => {
        addLog(`${newPlayers[nextPlayer].name}'s turn...`);
        runNPCTurn(nextPlayer, newBoard, newPlayers);
      }, 900);
    } else {
      setPhase(PHASE.ROLL);
      setDice([null, null]);
      addLog('Your turn — roll the dice!');
    }
  }

  /* ─── Win check ──────────────────────────────────────────────── */
  function checkWin(currentPlayers, currentVertices) {
    for (const p of currentPlayers) {
      const vp = calculateVP(p.id, currentVertices);
      if (vp >= WIN_VP) {
        setPhase(PHASE.GAME_OVER);
        setWinner(p);
        addLog(`🏆 ${p.name} wins with ${vp} Victory Points!`);
        return true;
      }
    }
    return false;
  }

  /* ─── Bank trade ──────────────────────────────────────────────── */
  function handleBankTrade() {
    if (!tradeGive || !tradeReceive || tradeGive === tradeReceive) return;
    const result = bankTrade(players[0], tradeGive, tradeReceive);
    if (!result) { addLog('Not enough resources for 4:1 trade.'); return; }
    const newPlayers = players.map((p) => (p.id === 0 ? { ...result, vp: p.vp } : p));
    setPlayers(newPlayers);
    addLog(`You traded 4 ${RESOURCE_NAMES[tradeGive]} → 1 ${RESOURCE_NAMES[tradeReceive]}.`);
    setTradeGive('');
    setTradeReceive('');
  }

  /* ─── Build mode toggle ──────────────────────────────────────── */
  function toggleBuild(type) {
    setBuildMode((prev) => (prev === type ? null : type));
  }

  /* ─── Cleanup on unmount ─────────────────────────────────────── */
  useEffect(() => () => clearTimeout(npcTimer.current), []);

  /* ═══════════════════════════════════════════════════════════════ *
   *  RENDER
   * ═══════════════════════════════════════════════════════════════ */

  if (phase === PHASE.NAME_ENTRY) {
    return (
      <div className="catan-name-entry">
        <div className="catan-splash">
          <h1 className="catan-title">Colony of Catan</h1>
          <p className="catan-subtitle">Build. Trade. Conquer.</p>
          {identity && <p className="catan-id-info">Playing as: <strong>{identity}</strong></p>}
          <div className="catan-name-form">
            <input
              className="catan-name-input"
              type="text"
              placeholder="Enter your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && startGame()}
              maxLength={20}
              autoFocus
            />
            <button className="catan-btn catan-btn-primary" onClick={startGame}>
              Start Game
            </button>
          </div>
          <div className="catan-rules">
            <p>🏠 Settlements = 1 VP &nbsp;|&nbsp; 🏙️ Cities = 2 VP &nbsp;|&nbsp; 🎯 Reach 10 VP to win</p>
            <p>🎲 Roll 7 = no resources (no robber in beta)</p>
          </div>
          {onExit && (
            <button className="catan-btn catan-btn-ghost" onClick={onExit}>
              ← Back to Arcade
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!board) return <div className="catan-loading">Loading board...</div>;

  const humanPlayer = players[0];
  const isMyTurn = currentPlayer === 0;

  // Build action labels
  const phaseLabel = {
    [PHASE.SETUP_SETTLE]: isMyTurn ? '📍 Place your settlement' : `${players[currentPlayer]?.name} is placing a settlement...`,
    [PHASE.SETUP_ROAD]: isMyTurn ? '🛤️ Place your road' : `${players[currentPlayer]?.name} is placing a road...`,
    [PHASE.ROLL]: isMyTurn ? '🎲 Roll the dice!' : `${players[currentPlayer]?.name} is rolling...`,
    [PHASE.BUILD]: isMyTurn ? '🔨 Build or end your turn' : `${players[currentPlayer]?.name} is building...`,
    [PHASE.GAME_OVER]: `🏆 Game Over!`,
  }[phase] || '';

  return (
    <div className="catan-layout">
      {/* ── Left sidebar: player info ── */}
      <aside className="catan-sidebar catan-sidebar-left">
        <div className="catan-sidebar-header">Players</div>
        {players.map((p) => (
          <div
            key={p.id}
            className={`catan-player-card ${p.id === currentPlayer ? 'active' : ''}`}
            style={{ borderColor: p.color }}
          >
            <div className="catan-player-name" style={{ color: p.color }}>
              {p.isNPC ? '🤖 ' : '👤 '}{p.name}
            </div>
            <div className="catan-player-vp">
              <span className="vp-number">{p.vp}</span>
              <span className="vp-label"> VP</span>
            </div>
            {p.id === 0 && (
              <div className="catan-resources-grid">
                {ALL_RESOURCES.map((res) => (
                  <div key={res} className="catan-resource-chip">
                    <span>{RESOURCE_ICONS[res]}</span>
                    <span>{p.resources[res] || 0}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Dice display */}
        <div className="catan-dice-display">
          {dice[0] !== null ? (
            <>
              <span className="die">{['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][dice[0]]}</span>
              <span className="die">{['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][dice[1]]}</span>
              <span className="dice-total">= {dice[0] + dice[1]}</span>
            </>
          ) : (
            <span className="dice-waiting">—</span>
          )}
        </div>
      </aside>

      {/* ── Board ── */}
      <main className="catan-board-area">
        <div className="catan-phase-banner">{phaseLabel}</div>
        <CatanBoard
          hexes={board.hexes}
          vertices={board.vertices}
          edges={board.edges}
          validSettlements={validSettlements()}
          validRoads={validRoads()}
          validCities={validCities()}
          onVertexClick={handleVertexClick}
          onEdgeClick={handleEdgeClick}
          players={players}
          phase={phase}
          currentPlayer={currentPlayer}
        />
        {phase === PHASE.GAME_OVER && winner && (
          <div className="catan-win-overlay">
            <div className="catan-win-box">
              <div className="catan-win-trophy">🏆</div>
              <h2>{winner.name} wins!</h2>
              <p>{winner.vp} Victory Points</p>
              <button className="catan-btn catan-btn-primary" onClick={() => window.location.reload()}>
                Play Again
              </button>
              {onExit && (
                <button className="catan-btn catan-btn-ghost" onClick={onExit}>
                  Back to Arcade
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Right sidebar: actions ── */}
      <aside className="catan-sidebar catan-sidebar-right">
        <div className="catan-sidebar-header">Actions</div>

        {/* Roll dice */}
        {phase === PHASE.ROLL && isMyTurn && (
          <button className="catan-btn catan-btn-dice" onClick={handleRoll}>
            🎲 Roll Dice
          </button>
        )}

        {/* Build buttons */}
        {phase === PHASE.BUILD && isMyTurn && (
          <div className="catan-build-section">
            <div className="catan-build-title">Build</div>

            <button
              className={`catan-btn catan-build-btn ${buildMode === 'road' ? 'active' : ''} ${!canAfford(humanPlayer, 'road') ? 'disabled' : ''}`}
              onClick={() => canAfford(humanPlayer, 'road') && toggleBuild('road')}
            >
              🛤️ Road
              <span className="catan-cost">🌲🧱</span>
            </button>

            <button
              className={`catan-btn catan-build-btn ${buildMode === 'settlement' ? 'active' : ''} ${!canAfford(humanPlayer, 'settlement') ? 'disabled' : ''}`}
              onClick={() => canAfford(humanPlayer, 'settlement') && toggleBuild('settlement')}
            >
              🏠 Settlement
              <span className="catan-cost">🌲🧱🌾🐑</span>
            </button>

            <button
              className={`catan-btn catan-build-btn ${buildMode === 'city' ? 'active' : ''} ${!canAfford(humanPlayer, 'city') ? 'disabled' : ''}`}
              onClick={() => canAfford(humanPlayer, 'city') && toggleBuild('city')}
            >
              🏙️ City
              <span className="catan-cost">🌾🌾⛰️⛰️⛰️</span>
            </button>

            {buildMode && (
              <div className="catan-build-hint">
                Click the board to place your {buildMode}
              </div>
            )}

            {/* 4:1 Bank Trade */}
            <div className="catan-trade-section">
              <div className="catan-build-title" style={{ marginTop: '12px' }}>Bank Trade (4:1)</div>
              <div className="catan-trade-row">
                <select className="catan-select" value={tradeGive} onChange={(e) => setTradeGive(e.target.value)}>
                  <option value="">Give 4...</option>
                  {ALL_RESOURCES.map((r) => (
                    <option key={r} value={r} disabled={(humanPlayer.resources[r] || 0) < 4}>
                      {RESOURCE_ICONS[r]} {RESOURCE_NAMES[r]} ({humanPlayer.resources[r] || 0})
                    </option>
                  ))}
                </select>
                <span className="catan-trade-arrow">→</span>
                <select className="catan-select" value={tradeReceive} onChange={(e) => setTradeReceive(e.target.value)}>
                  <option value="">Get 1...</option>
                  {ALL_RESOURCES.filter((r) => r !== tradeGive).map((r) => (
                    <option key={r} value={r}>{RESOURCE_ICONS[r]} {RESOURCE_NAMES[r]}</option>
                  ))}
                </select>
              </div>
              <button
                className="catan-btn catan-btn-trade"
                onClick={handleBankTrade}
                disabled={!tradeGive || !tradeReceive}
              >
                Trade
              </button>
            </div>

            <button className="catan-btn catan-btn-end" onClick={handleEndTurn}>
              End Turn →
            </button>
          </div>
        )}

        {/* Game log */}
        <div className="catan-log" ref={logRef}>
          {log.map((msg, i) => (
            <div key={i} className="catan-log-entry">{msg}</div>
          ))}
        </div>
      </aside>
    </div>
  );
}
