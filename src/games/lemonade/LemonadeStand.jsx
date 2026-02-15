import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../verus/AuthContext.jsx";
import { loadGame } from "../../verus/api.js";

// ═══════════════════════════════════════════════════════════════
// VERUS ARCADE — LEMONADE STAND
// Proof-of-gameplay: action log + hash chain = tamper-proof scores
// ═══════════════════════════════════════════════════════════════

// ── CRYPTO PRIMITIVES ──
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function hashStr(str) { return fnv(str).toString(16).padStart(8, "0"); }
function rng(id, day, salt = "") { return fnv(`${id}::day${day}::${salt}`) / 0xffffffff; }
function chainHash(prevHash, actionData) { return hashStr(`${prevHash}::${JSON.stringify(actionData)}`); }

// ── DETERMINISTIC GAME ENGINE ──
function getWeather(id, day) {
  const r = rng(id, day, "weather");
  if (r < 0.15) return { type: "storm", label: "⛈ Thunderstorm", tempBase: 55, modifier: 0.05 };
  if (r < 0.30) return { type: "rain", label: "🌧 Rainy", tempBase: 60, modifier: 0.25 };
  if (r < 0.50) return { type: "cloudy", label: "☁ Cloudy", tempBase: 68, modifier: 0.55 };
  if (r < 0.75) return { type: "sunny", label: "☀ Sunny", tempBase: 78, modifier: 0.85 };
  return { type: "hot", label: "🔥 Hot & Dry", tempBase: 92, modifier: 1.0 };
}
function getTemp(id, day, weather) { return Math.round(weather.tempBase + (rng(id, day, "temp") - 0.5) * 16); }
function getEvent(id, day) {
  const r = rng(id, day, "event");
  if (r < 0.08) return { label: "🚧 Street closed!", salesMod: 0.3 };
  if (r < 0.14) return { label: "🎪 Festival — huge crowds!", salesMod: 1.8 };
  if (r < 0.20) return { label: "📰 Featured in local paper!", salesMod: 1.5 };
  if (r < 0.25) return { label: "🐝 Bees swarmed your stand!", salesMod: 0.4 };
  return null;
}
function calcDemand(id, day, weather, temp, price, quality, event) {
  const base = 30 + temp * 0.8;
  const wd = base * weather.modifier;
  const pf = Math.max(0, 1.3 - price / 3.0);
  const qf = 0.5 + quality * 0.6;
  const noise = 0.8 + rng(id, day, "noise") * 0.4;
  let d = wd * pf * qf * noise;
  if (event) d *= event.salesMod;
  return Math.max(0, Math.round(d));
}

const RECIPES = [
  { name: "Sour & Watery", lemons: 0.5, sugar: 1, ice: 2, quality: 0.3 },
  { name: "Light & Tangy", lemons: 1, sugar: 2, ice: 3, quality: 0.55 },
  { name: "Classic", lemons: 1.5, sugar: 3, ice: 4, quality: 0.75 },
  { name: "Sweet & Lemony", lemons: 2, sugar: 4, ice: 5, quality: 1.0 },
];
const SUPPLY_PRICES = { lemons: 0.50, sugar: 0.25, cups: 0.10, ice: 0.15 };
const TOTAL_DAYS = 14;

function calcScore(cash, reputation, history) {
  const profit = cash - 20;
  const totalSold = history.reduce((s, h) => s + h.sold, 0);
  return Math.round(profit * 10 + reputation * 2 + totalSold);
}

// ── REPLAY ENGINE ──
function replayGame(seed, actionLog) {
  let state = { cash: 20, reputation: 50, inventory: { lemons: 0, sugar: 0, cups: 0, ice: 0 } };
  let prevHash = hashStr(`genesis::${seed}`);
  const results = [];
  for (const entry of actionLog) {
    const { day, buys, recipeIndex, price } = entry;
    const expectedHash = chainHash(prevHash, { day, buys, recipeIndex, price });
    if (entry.hash !== expectedHash) return { valid: false, error: `Hash mismatch at day ${day}` };
    const buyCost = buys.lemons*SUPPLY_PRICES.lemons + buys.sugar*SUPPLY_PRICES.sugar + buys.cups*SUPPLY_PRICES.cups + buys.ice*SUPPLY_PRICES.ice;
    state.cash -= buyCost;
    state.inventory.lemons += buys.lemons; state.inventory.sugar += buys.sugar;
    state.inventory.cups += buys.cups; state.inventory.ice += buys.ice;
    const recipe = RECIPES[recipeIndex];
    const weather = getWeather(seed, day); const temp = getTemp(seed, day, weather); const event = getEvent(seed, day);
    const canMake = Math.min(Math.floor(state.inventory.lemons/recipe.lemons), Math.floor(state.inventory.sugar/recipe.sugar), Math.floor(state.inventory.ice/recipe.ice), state.inventory.cups);
    const demand = calcDemand(seed, day, weather, temp, price, recipe.quality, event);
    const sold = Math.min(canMake, demand); const revenue = sold * price;
    state.inventory.lemons -= sold*recipe.lemons; state.inventory.sugar -= sold*recipe.sugar;
    state.inventory.ice -= sold*recipe.ice; state.inventory.cups -= sold;
    const melt = 0.5 + rng(seed, day, "melt") * 0.3;
    state.inventory.ice = Math.floor(state.inventory.ice * (1 - melt));
    state.cash += revenue;
    let repD = 0;
    if (sold > 0 && recipe.quality >= 0.7) repD += 3;
    if (sold > 0 && recipe.quality < 0.5) repD -= 2;
    if (price > 2.5) repD -= 2;
    if (price <= 1.0 && recipe.quality >= 0.7) repD += 2;
    if (demand > canMake) repD -= 1;
    state.reputation = Math.max(0, Math.min(100, state.reputation + repD));
    results.push({ day, weather: weather.label, sold, demand, revenue, repD });
    prevHash = entry.hash;
  }
  return { valid: true, finalState: state, results, finalHash: prevHash };
}

// ── UI COMPONENTS ──
function LemonPixel({ size = 60 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ imageRendering: "pixelated" }}>
      <rect x="6" y="1" width="1" height="1" fill="#4a7c3f" /><rect x="7" y="1" width="1" height="1" fill="#4a7c3f" />
      <rect x="7" y="2" width="1" height="1" fill="#4a7c3f" /><rect x="5" y="3" width="6" height="1" fill="#f5d442" />
      <rect x="4" y="4" width="8" height="1" fill="#f5d442" /><rect x="3" y="5" width="10" height="1" fill="#f5d442" />
      <rect x="3" y="6" width="10" height="1" fill="#f7e86a" /><rect x="3" y="7" width="10" height="1" fill="#f7e86a" />
      <rect x="3" y="8" width="10" height="1" fill="#f5d442" /><rect x="3" y="9" width="10" height="1" fill="#f5d442" />
      <rect x="4" y="10" width="8" height="1" fill="#f5d442" /><rect x="5" y="11" width="6" height="1" fill="#e8c431" />
    </svg>
  );
}

function ChainPanel({ verusId, actionLog, genesisHash, verifyResult }) {
  const [open, setOpen] = useState(false);
  if (!verusId) return null;
  const lastHash = actionLog.length > 0 ? actionLog[actionLog.length - 1].hash : genesisHash;
  return (
    <div onClick={() => setOpen(!open)} style={{
      background: "#0a0e14", border: "1px solid #1a3a2a", borderRadius: 6, padding: "10px 14px",
      fontFamily: "'Courier New', monospace", fontSize: 10, color: "#3ddc84", marginTop: 12,
      maxHeight: open ? 600 : 56, overflow: "hidden", transition: "max-height 0.3s", cursor: "pointer",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#6ec87a", fontWeight: 700 }}>⛓ PROOF-OF-GAMEPLAY CHAIN</span>
        <span style={{ color: "#555", fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </div>
      <div style={{ color: "#2a7a4a", fontSize: 9 }}>
        Head: <span style={{ color: "#5feba7" }}>{lastHash}</span> · {actionLog.length} actions
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "#1a6a3a", marginBottom: 4 }}>genesis → <span style={{ color: "#5feba7" }}>{genesisHash}</span></div>
          {actionLog.map((entry, i) => (
            <div key={i} style={{ marginBottom: 3, paddingLeft: 8, borderLeft: "2px solid #0f3320" }}>
              <div style={{ color: "#1a6a3a" }}>Day {entry.day} · <span style={{ color: "#5feba7" }}>{entry.hash}</span></div>
              <div style={{ color: "#0f5a2a", fontSize: 9 }}>
                buys:[{entry.buys.lemons}L {entry.buys.sugar}S {entry.buys.cups}C {entry.buys.ice}I]
                · {RECIPES[entry.recipeIndex].name} · ${entry.price.toFixed(2)}
              </div>
            </div>
          ))}
          {verifyResult && (
            <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 3,
              background: verifyResult.valid ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${verifyResult.valid ? "#22c55e" : "#ef4444"}`,
            }}>
              <span style={{ color: verifyResult.valid ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                {verifyResult.valid ? "✓ VERIFIED" : "✗ INVALID"} — {verifyResult.valid
                  ? `$${verifyResult.finalState.cash.toFixed(2)} cash, ${verifyResult.finalState.reputation} rep`
                  : verifyResult.error}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── MAIN GAME ──
const mkInit = () => ({
  phase: "title", verusId: "", day: 0,
  cash: 20.0, reputation: 50,
  inventory: { lemons: 0, sugar: 0, cups: 0, ice: 0 },
  recipeIndex: 1, price: 1.00,
  history: [], todayResult: null,
  buyAmounts: { lemons: 10, sugar: 20, cups: 20, ice: 15 },
  actionLog: [], genesisHash: "",
  pendingBuys: null, verifyResult: null,
  // On-chain integration
  chainSaveStatus: null, // null | "saving" | "saved" | "error"
  chainSaveTxid: null,
  chainStats: null, // { gamesPlayed, highscore, totalPoints, bestGrade, lastPlayed }
  loadingChainData: false,
});

export default function LemonadeStand() {
  const [state, setState] = useState(mkInit());
  const up = useCallback((p) => setState(prev => ({ ...prev, ...p })), []);
  const navigate = useNavigate();
  const { user } = useAuth();

  // Load previous stats when logged in
  useEffect(() => {
    if (user && state.phase === "title" && !state.loadingChainData && state.chainStats === null) {
      up({ loadingChainData: true });
      loadGame(user.fullname || user.identity + "@", "lemonade")
        .then(data => {
          up({
            loadingChainData: false,
            chainStats: data.found ? (data.stats || { gamesPlayed: 0, highscore: data.score || 0, totalPoints: 0, bestGrade: "F" }) : { gamesPlayed: 0, highscore: 0, totalPoints: 0, bestGrade: "F" },
            verusId: user.identity,
          });
        })
        .catch(() => up({ loadingChainData: false, verusId: user.identity }));
    }
  }, [user, state.phase]);

  const startGame = () => {
    const id = user ? user.identity : state.verusId.trim().replace(/@/g, "");
    if (!id) return;
    const genesis = hashStr(`genesis::${id}`);
    const fresh = mkInit();
    up({ ...fresh, phase: "plan", verusId: id, day: 1, genesisHash: genesis, chainStats: state.chainStats });
  };

  const totalCost = () => {
    const b = state.buyAmounts;
    return b.lemons*SUPPLY_PRICES.lemons + b.sugar*SUPPLY_PRICES.sugar + b.cups*SUPPLY_PRICES.cups + b.ice*SUPPLY_PRICES.ice;
  };

  const buySupplies = () => {
    const cost = totalCost();
    if (cost > state.cash) return;
    const prev = state.pendingBuys || { lemons: 0, sugar: 0, cups: 0, ice: 0 };
    up({
      cash: state.cash - cost,
      inventory: {
        lemons: state.inventory.lemons + state.buyAmounts.lemons, sugar: state.inventory.sugar + state.buyAmounts.sugar,
        cups: state.inventory.cups + state.buyAmounts.cups, ice: state.inventory.ice + state.buyAmounts.ice,
      },
      pendingBuys: {
        lemons: prev.lemons + state.buyAmounts.lemons, sugar: prev.sugar + state.buyAmounts.sugar,
        cups: prev.cups + state.buyAmounts.cups, ice: prev.ice + state.buyAmounts.ice,
      },
    });
  };

  const simulateDay = () => {
    const buys = state.pendingBuys || { lemons: 0, sugar: 0, cups: 0, ice: 0 };
    const actionData = { day: state.day, buys, recipeIndex: state.recipeIndex, price: state.price };
    const prevHash = state.actionLog.length > 0 ? state.actionLog[state.actionLog.length - 1].hash : state.genesisHash;
    const actionHash = chainHash(prevHash, actionData);
    const recipe = RECIPES[state.recipeIndex];
    const weather = getWeather(state.verusId, state.day); const temp = getTemp(state.verusId, state.day, weather);
    const event = getEvent(state.verusId, state.day);
    const canMake = Math.min(Math.floor(state.inventory.lemons/recipe.lemons), Math.floor(state.inventory.sugar/recipe.sugar), Math.floor(state.inventory.ice/recipe.ice), state.inventory.cups);
    const demand = calcDemand(state.verusId, state.day, weather, temp, state.price, recipe.quality, event);
    const sold = Math.min(canMake, demand); const revenue = sold * state.price;
    const newInv = { ...state.inventory };
    newInv.lemons -= sold*recipe.lemons; newInv.sugar -= sold*recipe.sugar;
    newInv.ice -= sold*recipe.ice; newInv.cups -= sold;
    const melt = 0.5 + rng(state.verusId, state.day, "melt") * 0.3;
    newInv.ice = Math.floor(newInv.ice * (1 - melt));
    Object.keys(newInv).forEach(k => { newInv[k] = Math.max(0, newInv[k]); });
    let repD = 0;
    if (sold > 0 && recipe.quality >= 0.7) repD += 3;
    if (sold > 0 && recipe.quality < 0.5) repD -= 2;
    if (state.price > 2.5) repD -= 2;
    if (state.price <= 1.0 && recipe.quality >= 0.7) repD += 2;
    if (demand > canMake) repD -= 1;
    const result = { day: state.day, weather: weather.label, temp, event: event?.label || null, demand, maxCups: canMake, sold, revenue, recipe: recipe.name, price: state.price, repD };
    up({
      phase: "result", cash: state.cash + revenue,
      reputation: Math.max(0, Math.min(100, state.reputation + repD)),
      inventory: newInv, todayResult: result,
      history: [...state.history, result],
      actionLog: [...state.actionLog, { ...actionData, hash: actionHash }],
      pendingBuys: null,
    });
  };

  const nextDay = () => {
    if (state.day >= TOTAL_DAYS) {
      const vResult = replayGame(state.verusId, state.actionLog);
      up({ phase: "gameover", verifyResult: vResult });
    } else {
      up({ phase: "plan", day: state.day + 1, todayResult: null, pendingBuys: null });
    }
  };

  // Manual save — only called after user confirms
  const saveToChain = () => {
    if (state.chainSaveStatus) return; // prevent double-click
    const score = calcScore(state.cash, state.reputation, state.history);
    const head = state.actionLog[state.actionLog.length - 1].hash;
    const profit = state.cash - 20;
    const grade = profit > 40 ? "S" : profit > 25 ? "A" : profit > 15 ? "B" : profit > 5 ? "C" : profit > 0 ? "D" : "F";
    const prevHigh = state.chainStats?.highscore || 0;
    const isNewHigh = score > prevHigh;

    up({ chainSaveStatus: "saving" });
    const body = {
      identity: user.fullname || user.identity + "@",
      game: "lemonade",
      actionLog: state.actionLog,
      chainHead: head,
      score,
      grade,
      isNewHigh,
    };

    fetch("http://localhost:3001/api/game/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(result => {
        if (result.success) {
          up({
            chainSaveStatus: "saved",
            chainSaveTxid: result.txid,
            chainStats: result.stats || state.chainStats,
          });
        } else {
          up({ chainSaveStatus: "error" });
        }
      })
      .catch(() => up({ chainSaveStatus: "error" }));
  };

  const resetGame = () => {
    const cs = state.chainStats;
    const init = mkInit();
    setState({ ...init, verusId: user ? user.identity : "", chainStats: cs });
  };

  const weather = state.verusId && state.day > 0 ? getWeather(state.verusId, state.day) : null;

  // ── STYLES ──
  const bg = "#fdf6e3"; const crd = "#fffef8"; const acc = "#d4a017";
  const accD = "#9a7412"; const grn = "#3a7d44"; const red = "#c0392b";
  const tD = "#2c1810"; const tM = "#5a4630"; const bdr = "#e8d5a3";
  const CS = { maxWidth: 520, margin: "0 auto", padding: "20px 16px", fontFamily: "'Georgia', serif", color: tD, background: bg, minHeight: "100vh" };
  const CD = { background: crd, border: `2px solid ${bdr}`, borderRadius: 8, padding: "16px 18px", marginBottom: 12, boxShadow: "0 2px 8px rgba(180,150,80,0.1)" };
  const BN = (pri = false, dis = false) => ({
    padding: "10px 20px", border: pri ? "none" : `2px solid ${acc}`, borderRadius: 6,
    background: dis ? "#e8e0cc" : pri ? `linear-gradient(135deg, ${acc}, #e8b82e)` : "transparent",
    color: dis ? "#aaa" : pri ? "#fff" : accD, fontFamily: "'Georgia', serif", fontSize: 14,
    fontWeight: 700, cursor: dis ? "default" : "pointer", letterSpacing: 0.5,
  });
  const LB = { fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, color: tM, fontWeight: 700, marginBottom: 4, fontFamily: "'Courier New', monospace" };

  // ════════ TITLE ════════
  if (state.phase === "title") {
    return (
      <div style={CS}>
        <div style={{ textAlign: "center", paddingTop: 40 }}>
          <LemonPixel size={80} />
          <h1 style={{ fontSize: 28, fontWeight: 700, color: tD, margin: "16px 0 4px" }}>Lemonade Stand</h1>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 3, color: acc, fontFamily: "'Courier New', monospace", fontWeight: 700, marginBottom: 24 }}>
            Verus Arcade · Proof-of-Gameplay
          </div>
          <div style={{ ...CD, textAlign: "left", fontSize: 13, lineHeight: 1.7, color: tM }}>
            <p style={{ margin: "0 0 10px" }}>
              Your <strong>VerusID</strong> seeds the game world. Every decision is recorded in a <strong>hash chain</strong> — tamper-proof and verifiable by anyone.
            </p>
            <p style={{ margin: 0, fontSize: 12, fontStyle: "italic", color: "#8a7a5a" }}>
              Run a lemonade stand for 14 days. Buy supplies, pick recipes, set prices. Beat the weather.
            </p>
          </div>

          {/* Logged-in user panel */}
          {user ? (
            <div style={{ ...CD, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: grn }} />
                <span style={{ fontFamily: "'Courier New', monospace", fontSize: 13, color: grn, fontWeight: 700 }}>
                  {user.fullname || user.identity + "@"}
                </span>
              </div>
              {state.loadingChainData ? (
                <div style={{ fontSize: 12, color: tM, fontStyle: "italic" }}>Loading chain data...</div>
              ) : state.chainStats && state.chainStats.highscore > 0 ? (
                <div style={{ fontSize: 12, color: tM }}>
                  <div>Highscore: <strong style={{ color: acc }}>{state.chainStats.highscore} pts</strong> (Grade: {state.chainStats.bestGrade})</div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>Games played: {state.chainStats.gamesPlayed} · Total XP: {state.chainStats.totalPoints}</div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: tM }}>No previous games found — let's play!</div>
              )}
            </div>
          ) : (
            <div style={{ ...CD, textAlign: "left" }}>
              <div style={LB}>VerusID (manual)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="text" value={state.verusId} onChange={(e) => up({ verusId: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && startGame()} placeholder="myname"
                  style={{ flex: 1, padding: "10px 12px", border: `2px solid ${bdr}`, borderRadius: 6, fontFamily: "'Courier New', monospace", fontSize: 15, color: tD, background: "#fffef5", outline: "none" }} />
                <span style={{ fontSize: 11, color: tM, fontFamily: "'Courier New', monospace" }}>.Verus Arcade@</span>
              </div>
              <div style={{ fontSize: 11, color: "#8a7a5a", marginTop: 6, fontStyle: "italic" }}>
                ⚠ Playing without login — scores won't be saved on-chain.{" "}
                <span onClick={() => navigate("/login")} style={{ color: acc, cursor: "pointer", textDecoration: "underline" }}>Log in</span>
              </div>
            </div>
          )}

          <button onClick={startGame} disabled={!user && !state.verusId.trim()} style={{ ...BN(true, !user && !state.verusId.trim()), width: "100%", padding: "14px 20px", fontSize: 16 }}>🍋 Start Game</button>
          <button onClick={() => navigate('/')} style={{ ...BN(), width: "100%", padding: "10px 20px", fontSize: 12, marginTop: 8, borderColor: "#5a6a7e", color: "#5a6a7e" }}>← Back to Arcade</button>
        </div>
      </div>
    );
  }

  // ════════ PLAN ════════
  if (state.phase === "plan") {
    const cost = totalCost(); const canAfford = cost <= state.cash;
    return (
      <div style={CS}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ ...LB, marginBottom: 0 }}>Day {state.day}/{TOTAL_DAYS}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {user ? (user.fullname || user.identity + "@") : state.verusId + ".Verus Arcade@"}
            </div>
          </div>
          <button onClick={resetGame} style={{ ...BN(), padding: "6px 14px", fontSize: 11, borderColor: red, color: red }}>↺ Restart</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
          {[
            { l: "Cash", v: `$${state.cash.toFixed(2)}`, c: grn },
            { l: "Rep", v: `${state.reputation}/100`, c: state.reputation > 60 ? grn : state.reputation > 30 ? acc : red },
            { l: "Weather", v: weather ? weather.label : "—" },
          ].map(({ l, v, c }) => (
            <div key={l} style={{ background: crd, border: `1px solid ${bdr}`, borderRadius: 6, padding: "8px", textAlign: "center" }}>
              <div style={{ ...LB, fontSize: 9 }}>{l}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: c || tD }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={CD}>
          <div style={{ ...LB, marginBottom: 8 }}>Inventory</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
            {[["🍋","Lemons",state.inventory.lemons],["🧂","Sugar",state.inventory.sugar],["🥤","Cups",state.inventory.cups],["🧊","Ice",state.inventory.ice]].map(([ic,nm,val]) => (
              <div key={nm}><div style={{ fontSize: 16 }}>{ic}</div><div style={{ fontSize: 15, fontWeight: 700 }}>{val}</div><div style={{ fontSize: 9, color: tM }}>{nm}</div></div>
            ))}
          </div>
        </div>
        <div style={CD}>
          <div style={{ ...LB, marginBottom: 8 }}>Buy Supplies</div>
          {["lemons","sugar","cups","ice"].map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 13, width: 100, textTransform: "capitalize" }}>{item} <span style={{ color: "#aaa", fontSize: 11 }}>${SUPPLY_PRICES[item].toFixed(2)}</span></span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => up({ buyAmounts: { ...state.buyAmounts, [item]: Math.max(0, state.buyAmounts[item] - 5) } })} style={{ ...BN(), padding: "4px 10px", fontSize: 14, borderRadius: 4 }}>−</button>
                <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, width: 30, textAlign: "center" }}>{state.buyAmounts[item]}</span>
                <button onClick={() => up({ buyAmounts: { ...state.buyAmounts, [item]: state.buyAmounts[item] + 5 } })} style={{ ...BN(), padding: "4px 10px", fontSize: 14, borderRadius: 4 }}>+</button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 8, borderTop: `1px solid ${bdr}` }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Total: <span style={{ color: canAfford ? grn : red }}>${cost.toFixed(2)}</span></span>
            <button onClick={buySupplies} disabled={!canAfford || cost === 0} style={{ ...BN(canAfford && cost > 0, !canAfford || cost === 0), padding: "8px 16px" }}>Buy</button>
          </div>
        </div>
        <div style={CD}>
          <div style={{ ...LB, marginBottom: 8 }}>Recipe</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {RECIPES.map((r, i) => (
              <button key={i} onClick={() => up({ recipeIndex: i })} style={{
                padding: "8px 10px", border: `2px solid ${i === state.recipeIndex ? acc : bdr}`,
                borderRadius: 6, background: i === state.recipeIndex ? "#fdf0c8" : crd, cursor: "pointer",
                textAlign: "left", fontFamily: "'Georgia', serif",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: i === state.recipeIndex ? accD : tM }}>{r.name}</div>
                <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>{"★".repeat(Math.ceil(r.quality*4))}{"☆".repeat(4-Math.ceil(r.quality*4))}</div>
              </button>
            ))}
          </div>
        </div>
        <div style={CD}>
          <div style={{ ...LB, marginBottom: 8 }}>Price per Cup</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
            <button onClick={() => up({ price: Math.max(0.25, state.price - 0.25) })} style={{ ...BN(), padding: "8px 16px", fontSize: 18 }}>−</button>
            <span style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: accD, minWidth: 80, textAlign: "center" }}>${state.price.toFixed(2)}</span>
            <button onClick={() => up({ price: Math.min(5.0, state.price + 0.25) })} style={{ ...BN(), padding: "8px 16px", fontSize: 18 }}>+</button>
          </div>
        </div>
        <button onClick={simulateDay} style={{ ...BN(true), width: "100%", padding: "14px", fontSize: 16 }}>🍋 Open for Business!</button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesisHash={state.genesisHash} />
      </div>
    );
  }

  // ════════ RESULT ════════
  if (state.phase === "result" && state.todayResult) {
    const r = state.todayResult;
    const lastAct = state.actionLog[state.actionLog.length - 1];
    return (
      <div style={CS}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ ...LB, marginBottom: 4 }}>Day {r.day} Results</div>
            <div style={{ fontSize: 28, marginBottom: 4 }}>{r.weather}</div>
            <div style={{ fontSize: 13, color: tM }}>{r.temp}°F — {r.recipe}</div>
          </div>
          <button onClick={resetGame} style={{ ...BN(), padding: "6px 14px", fontSize: 11, borderColor: red, color: red }}>↺ Restart</button>
        </div>
        <div style={{
          background: "#0a0e14", borderRadius: 4, padding: "6px 10px",
          fontFamily: "'Courier New', monospace", fontSize: 10, color: "#3ddc84",
          textAlign: "center", marginBottom: 10, marginTop: 8,
        }}>
          ⛓ Hash: <span style={{ color: "#5feba7" }}>{lastAct.hash}</span> · Chained to {r.day > 1 ? `day ${r.day - 1}` : "genesis"}
        </div>
        {r.event && <div style={{ ...CD, background: "#fff8e1", borderColor: acc, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{r.event}</div>}
        <div style={CD}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, textAlign: "center" }}>
            {[
              { l: "Demand", v: `${r.demand} cups` }, { l: "Could Make", v: `${r.maxCups} cups`, c: tM },
              { l: "Sold", v: r.sold, c: r.sold > 0 ? grn : red }, { l: "Revenue", v: `$${r.revenue.toFixed(2)}`, c: r.revenue > 0 ? grn : red },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ ...LB, fontSize: 9 }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700, color: c || tD }}>{v}</div></div>
            ))}
          </div>
        </div>
        <div style={{ ...CD, display: "flex", justifyContent: "space-around", textAlign: "center" }}>
          <div><div style={{ ...LB, fontSize: 9 }}>Cash</div><div style={{ fontSize: 20, fontWeight: 700, color: grn }}>${state.cash.toFixed(2)}</div></div>
          <div><div style={{ ...LB, fontSize: 9 }}>Rep</div><div style={{ fontSize: 20, fontWeight: 700, color: state.reputation > 60 ? grn : acc }}>{state.reputation}<span style={{ fontSize: 12, color: r.repD >= 0 ? grn : red, marginLeft: 4 }}>{r.repD >= 0 ? "+" : ""}{r.repD}</span></div></div>
        </div>
        {r.demand > r.maxCups && <div style={{ textAlign: "center", fontSize: 12, color: red, fontStyle: "italic", marginBottom: 8 }}>Ran out! {r.demand - r.maxCups} left thirsty.</div>}
        <button onClick={nextDay} style={{ ...BN(true), width: "100%", padding: "14px", fontSize: 16 }}>
          {state.day >= TOTAL_DAYS ? "📊 Final Results" : `➜ Day ${state.day + 1}`}
        </button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesisHash={state.genesisHash} />
      </div>
    );
  }

  // ════════ GAME OVER ════════
  if (state.phase === "gameover") {
    const totalRev = state.history.reduce((s, h) => s + h.revenue, 0);
    const totalSold = state.history.reduce((s, h) => s + h.sold, 0);
    const profit = state.cash - 20;
    const score = calcScore(state.cash, state.reputation, state.history);
    const grade = profit > 40 ? "S" : profit > 25 ? "A" : profit > 15 ? "B" : profit > 5 ? "C" : profit > 0 ? "D" : "F";
    const gc = { S: "#d4a017", A: grn, B: "#5a9bd5", C: tM, D: "#c97932", F: red }[grade];
    const vr = state.verifyResult;
    const head = state.actionLog.length > 0 ? state.actionLog[state.actionLog.length - 1].hash : state.genesisHash;
    const isNewHigh = !state.chainStats || state.chainStats.highscore === 0 || score > state.chainStats.highscore;

    return (
      <div style={CS}>
        <div style={{ textAlign: "center", paddingTop: 20 }}>
          <LemonPixel size={60} />
          <h2 style={{ fontSize: 24, margin: "12px 0 4px" }}>Summer's Over!</h2>
          <div style={{ fontSize: 60, fontWeight: 900, color: gc, lineHeight: 1, margin: "8px 0", fontFamily: "'Courier New', monospace" }}>{grade}</div>
          <div style={{ ...LB, fontSize: 10, marginBottom: 4 }}>Entrepreneur Grade</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: acc, fontFamily: "'Courier New', monospace", marginBottom: 12 }}>
            {score} pts
            {isNewHigh && <span style={{ fontSize: 12, color: grn, marginLeft: 8 }}>🏆 NEW HIGH!</span>}
          </div>

          {/* Verification */}
          {vr && (
            <div style={{
              padding: "10px 14px", borderRadius: 6, marginBottom: 12,
              background: vr.valid ? "rgba(58,125,68,0.1)" : "rgba(192,57,43,0.1)",
              border: `2px solid ${vr.valid ? grn : red}`,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: vr.valid ? grn : red }}>
                {vr.valid ? "✓ PROOF-OF-GAMEPLAY VERIFIED" : "✗ VERIFICATION FAILED"}
              </div>
              <div style={{ fontSize: 11, color: tM, marginTop: 4 }}>
                {vr.valid ? `Replayed ${state.actionLog.length} actions. Cash: $${vr.finalState.cash.toFixed(2)}, Rep: ${vr.finalState.reputation}` : vr.error}
              </div>
            </div>
          )}

          {/* On-chain save */}
          {user && (
            <div style={{
              padding: "10px 14px", borderRadius: 6, marginBottom: 12,
              background: state.chainSaveStatus === "saved" ? "rgba(58,125,68,0.08)"
                : state.chainSaveStatus === "error" ? "rgba(192,57,43,0.08)"
                : "rgba(212,160,23,0.06)",
              border: `1px solid ${
                state.chainSaveStatus === "saved" ? grn
                : state.chainSaveStatus === "error" ? red
                : bdr
              }`,
            }}>
              {state.chainSaveStatus === "saving" && (
                <div style={{ fontSize: 12, color: acc, fontFamily: "'Courier New', monospace", textAlign: "center" }}>
                  ⏳ Saving to Verus testnet...
                </div>
              )}
              {state.chainSaveStatus === "saved" && (
                <div>
                  <div style={{ fontSize: 12, color: grn, fontWeight: 700, fontFamily: "'Courier New', monospace", textAlign: "center" }}>
                    ✓ SAVED ON-CHAIN
                  </div>
                  <div style={{ fontSize: 10, color: tM, marginTop: 2, fontFamily: "'Courier New', monospace", wordBreak: "break-all", textAlign: "center" }}>
                    txid: {state.chainSaveTxid}
                  </div>
                </div>
              )}
              {state.chainSaveStatus === "error" && (
                <div style={{ fontSize: 12, color: red, fontFamily: "'Courier New', monospace", textAlign: "center" }}>
                  ✗ Save failed — try again later
                </div>
              )}
              {!state.chainSaveStatus && isNewHigh && (
                <div>
                  <div style={{ fontSize: 12, color: acc, fontFamily: "'Courier New', monospace", marginBottom: 8, textAlign: "center" }}>
                    🏆 New highscore! Save to blockchain?
                  </div>
                  <div style={{ fontSize: 10, color: tM, marginBottom: 10, textAlign: "center", fontStyle: "italic" }}>
                    Updates your proof-of-gameplay + stats (costs a small tx fee)
                  </div>
                  <button onClick={saveToChain} disabled={!!state.chainSaveStatus} style={{ ...BN(true, !!state.chainSaveStatus), width: "100%", padding: "10px", fontSize: 13 }}>
                    ⛓ Save Highscore On-Chain
                  </button>
                </div>
              )}
              {!state.chainSaveStatus && !isNewHigh && (
                <div>
                  <div style={{ fontSize: 12, color: tM, fontFamily: "'Courier New', monospace", marginBottom: 8, textAlign: "center" }}>
                    Your highscore is {state.chainStats?.highscore || 0} pts — this game: {score} pts
                  </div>
                  <div style={{ fontSize: 10, color: tM, marginBottom: 10, textAlign: "center", fontStyle: "italic" }}>
                    Updates stats only (games played, total XP). Proof stays from your highscore game. (costs a small tx fee)
                  </div>
                  <button onClick={saveToChain} disabled={!!state.chainSaveStatus} style={{ ...BN(false, !!state.chainSaveStatus), width: "100%", padding: "10px", fontSize: 12, borderColor: acc, color: accD }}>
                    📊 Update Stats On-Chain
                  </button>
                </div>
              )}
            </div>
          )}

          {!user && (
            <div style={{
              padding: "8px 14px", borderRadius: 6, marginBottom: 12,
              background: "rgba(90,106,126,0.08)", border: "1px solid #2a3a4e",
              fontSize: 12, color: "#5a6a7e", fontFamily: "'Courier New', monospace",
            }}>
              Score not saved — <span onClick={() => navigate("/login")} style={{ color: acc, cursor: "pointer", textDecoration: "underline" }}>log in</span> to save on-chain
            </div>
          )}
        </div>

        <div style={CD}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, textAlign: "center" }}>
            {[
              { l: "Final Cash", v: `$${state.cash.toFixed(2)}` },
              { l: "Profit", v: `$${profit.toFixed(2)}`, c: profit >= 0 ? grn : red },
              { l: "Revenue", v: `$${totalRev.toFixed(2)}` },
              { l: "Cups Sold", v: totalSold },
              { l: "Avg Price", v: `$${(totalRev / Math.max(totalSold, 1)).toFixed(2)}` },
              { l: "Final Rep", v: `${state.reputation}/100` },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ ...LB, fontSize: 9 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: c || tD }}>{v}</div></div>
            ))}
          </div>
        </div>
        <div style={CD}>
          <div style={{ ...LB, marginBottom: 8 }}>Day-by-Day</div>
          <div style={{ maxHeight: 180, overflow: "auto" }}>
            {state.history.map(h => (
              <div key={h.day} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${bdr}`, color: tM }}>
                <span>Day {h.day} {h.weather.split(" ")[0]}</span>
                <span>{h.sold}/{h.demand}</span>
                <span style={{ color: h.revenue > 0 ? grn : red, fontWeight: 700 }}>${h.revenue.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
        <button onClick={resetGame} style={{ ...BN(true), width: "100%", padding: 14, fontSize: 14 }}>🍋 New Game</button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesisHash={state.genesisHash} verifyResult={state.verifyResult} />
        <div style={{
          marginTop: 12, padding: "10px 14px", background: "#0a0e14", borderRadius: 6,
          fontFamily: "'Courier New', monospace", fontSize: 10, color: "#3ddc84",
        }}>
          <div style={{ color: "#1a6a3a" }}>// On-chain data (contentmultimap):</div>
          <div style={{ color: "#5feba7" }}>stats.gamesPlayed → {(state.chainStats?.gamesPlayed || 0) + 1}</div>
          <div style={{ color: "#5feba7" }}>stats.highscore → {isNewHigh ? score : state.chainStats?.highscore || 0}</div>
          <div style={{ color: "#5feba7" }}>stats.totalPoints → {(state.chainStats?.totalPoints || 0) + score}</div>
          <div style={{ color: "#5feba7" }}>stats.bestGrade → "{isNewHigh ? grade : state.chainStats?.bestGrade || grade}"</div>
          <div style={{ color: "#5feba7" }}>proof.actions → [{state.actionLog.length} chained entries]</div>
          <div style={{ color: "#5feba7" }}>proof.chainhead → "{head}"</div>
          {state.chainSaveTxid && <div style={{ color: "#5feba7" }}>txid → "{state.chainSaveTxid}"</div>}
          <div style={{ color: "#1a6a3a", marginTop: 4 }}>// Verify: replay(seed, actions) → hash must match chainhead</div>
        </div>
      </div>
    );
  }

  return null;
}
