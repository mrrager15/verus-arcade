import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ═══════════════════════════════════════════════════════════════
// COLONY ONE — Verus Arcade
// Proof-of-gameplay: action log + hash chain = tamper-proof scores
// ═══════════════════════════════════════════════════════════════

// ── CRYPTO PRIMITIVES ──
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function hashStr(str) { return fnv(str).toString(16).padStart(8, "0"); }
function rng(id, sol, salt = "") { return fnv(`${id}::sol${sol}::${salt}`) / 0xffffffff; }
function rngR(id, sol, salt, min, max) { return Math.floor(rng(id, sol, salt) * (max - min + 1)) + min; }
function chainHash(prev, data) { return hashStr(`${prev}::${JSON.stringify(data)}`); }

// ── PLANET GENERATION ──
const PLANET_TYPES = [
  { name: "Arid Wasteland", icon: "🏜", color: "#c4713b", atmo: 0.2, tempBase: 45, resMod: 0.8, waterMod: 0.3, stormChance: 0.25 },
  { name: "Frozen Tundra", icon: "🧊", color: "#7ba7c9", atmo: 0.5, tempBase: -40, resMod: 0.7, waterMod: 0.9, stormChance: 0.3 },
  { name: "Volcanic Ridge", icon: "🌋", color: "#d44a2e", atmo: 0.3, tempBase: 60, resMod: 1.3, waterMod: 0.2, stormChance: 0.2 },
  { name: "Dust Basin", icon: "🌑", color: "#8a7e6b", atmo: 0.1, tempBase: -10, resMod: 1.0, waterMod: 0.5, stormChance: 0.35 },
  { name: "Crystal Mesa", icon: "💎", color: "#6b5b95", atmo: 0.4, tempBase: 15, resMod: 1.2, waterMod: 0.6, stormChance: 0.15 },
  { name: "Moss Plateau", icon: "🌿", color: "#4a7c59", atmo: 0.7, tempBase: 22, resMod: 0.9, waterMod: 0.8, stormChance: 0.1 },
];

function genPlanet(id) {
  const r = fnv(id + "::planet") / 0xffffffff;
  const base = PLANET_TYPES[Math.floor(r * PLANET_TYPES.length)];
  return {
    ...base,
    gravity: +(0.3 + fnv(id + "::gravity") / 0xffffffff * 0.9).toFixed(2),
    solar: +(0.5 + fnv(id + "::solar") / 0xffffffff * 1.0).toFixed(2),
    designation: `${id.toUpperCase()}-${Math.floor(fnv(id + "::des") / 0xffffffff * 900 + 100)}`,
  };
}

// ── WEATHER & EVENTS ──
function getWeather(id, sol, planet) {
  const r = rng(id, sol, "weather");
  const temp = Math.round(planet.tempBase + (rng(id, sol, "tempvar") - 0.5) * 30);
  if (r < planet.stormChance * 0.4) return { cond: "Dust Storm", icon: "🌪", temp, eMod: 0.3, danger: 0.6 };
  if (r < planet.stormChance * 0.7) return { cond: "High Winds", icon: "💨", temp, eMod: 0.6, danger: 0.2 };
  if (r < planet.stormChance) return { cond: "Solar Flare", icon: "⚡", temp, eMod: 1.8, danger: 0.4 };
  if (r < planet.stormChance + 0.15) return { cond: "Overcast", icon: "☁", temp, eMod: 0.7, danger: 0 };
  return { cond: "Clear", icon: "☀", temp, eMod: 1.0, danger: 0 };
}

function getEvent(id, sol) {
  const r = rng(id, sol, "event");
  if (r < 0.06) return { text: "Meteor impact — free materials!", type: "bonus", res: "materials", amt: 8 };
  if (r < 0.11) return { text: "Underground ice pocket found!", type: "bonus", res: "water", amt: 6 };
  if (r < 0.16) return { text: "Equipment malfunction!", type: "damage", res: "energy", amt: -5 };
  if (r < 0.20) return { text: "Toxic gas vent!", type: "damage", res: "o2", amt: -4 };
  if (r < 0.24) return { text: "Strange crystals — morale boost!", type: "morale", amt: 8 };
  return null;
}

// ── BUILDINGS ──
const BUILDINGS = {
  solar: { name: "Solar Array", icon: "☀", cost: { materials: 4 }, prod: "energy" },
  o2gen: { name: "O₂ Generator", icon: "🫧", cost: { materials: 5, energy: 2 }, prod: "o2" },
  greenhouse: { name: "Greenhouse", icon: "🌱", cost: { materials: 6, water: 2 }, prod: "food" },
  waterex: { name: "Water Extractor", icon: "💧", cost: { materials: 5, energy: 2 }, prod: "water" },
  mine: { name: "Mining Rig", icon: "⛏", cost: { materials: 3, energy: 2 }, prod: "materials" },
  habitat: { name: "Habitat Pod", icon: "🏠", cost: { materials: 8, energy: 3 }, prod: "housing" },
  shield: { name: "Storm Shield", icon: "🛡", cost: { materials: 10, energy: 4 }, prod: "shield" },
};

function calcProd(buildings, planet, weather) {
  const c = (k) => buildings.filter(b => b === k).length;
  return {
    energy: Math.round(c("solar") * 3 * planet.solar * weather.eMod),
    o2: Math.round(c("o2gen") * 3 * (0.5 + planet.atmo)),
    food: c("greenhouse") * 2,
    water: Math.round(c("waterex") * 2 * planet.waterMod + c("waterex")),
    materials: Math.round(c("mine") * 2 * planet.resMod),
  };
}
function calcCons(col) { return { o2: col * 2, food: col, water: col, energy: col }; }

const TOTAL_SOLS = 30;

// ── REPLAY ENGINE ──
// Replays entire game from seed + action log. Returns final state or error.
function replayGame(seed, actionLog) {
  const planet = genPlanet(seed);
  let st = {
    colonists: 3, maxCol: 5, morale: 60,
    res: { o2: 20, food: 15, water: 12, energy: 15, materials: 10 },
    buildings: ["solar", "o2gen", "waterex"],
  };
  let prev = hashStr(`genesis::${seed}`);
  const log = [];

  for (const entry of actionLog) {
    const { sol, actions } = entry;
    const expected = chainHash(prev, { sol, actions });
    if (entry.hash !== expected) {
      return { valid: false, error: `Hash mismatch at sol ${sol}! Chain broken.` };
    }

    // Apply actions deterministically
    let actIdx = 0;
    for (const act of actions) {
      if (act === "explore") {
        const r = rng(seed, sol, `explore${actIdx}`);
        if (r < 0.35) st.res.materials += rngR(seed, sol, `exmat${actIdx}`, 2, 6);
        else if (r < 0.55) st.res.water += rngR(seed, sol, `exwat${actIdx}`, 1, 4);
        else if (r < 0.70) st.res.food += rngR(seed, sol, `exfood${actIdx}`, 1, 3);
        else { st.res.materials += 1; st.res.water += 1; }
      } else if (act === "gather") {
        st.res.materials += Math.round(2 * planet.resMod) + 1;
      } else if (act === "rest") {
        st.morale = Math.min(100, st.morale + 8);
      } else if (act.startsWith("build:")) {
        const bk = act.split(":")[1];
        const b = BUILDINGS[bk];
        if (b) {
          for (const [rk, rv] of Object.entries(b.cost)) st.res[rk] -= rv;
          st.buildings.push(bk);
          if (bk === "habitat") st.maxCol += 2;
        }
      }
      actIdx++;
    }

    // End-of-sol simulation (deterministic)
    const weather = getWeather(seed, sol, planet);
    const event = getEvent(seed, sol);
    const prod = calcProd(st.buildings, planet, weather);
    const cons = calcCons(st.colonists);

    st.res.energy += prod.energy; st.res.o2 += prod.o2;
    st.res.food += prod.food; st.res.water += prod.water;
    st.res.materials += prod.materials;
    st.res.o2 -= cons.o2; st.res.food -= cons.food;
    st.res.water -= cons.water; st.res.energy -= cons.energy;

    // Storm damage
    const shieldN = st.buildings.filter(b => b === "shield").length;
    const shieldR = Math.min(0.8, shieldN * 0.4);
    if (weather.danger > 0.3) {
      const dmgR = rng(seed, sol, "stormdmg");
      const actualD = weather.danger * (1 - shieldR);
      if (dmgR < actualD) {
        const lost = Math.round(3 * actualD);
        st.res.materials = Math.max(0, st.res.materials - lost);
        st.res.energy = Math.max(0, st.res.energy - lost);
      }
    }

    // Event
    if (event) {
      if (event.type === "bonus" && event.res) st.res[event.res] += event.amt;
      else if (event.type === "damage" && event.res) st.res[event.res] = Math.max(0, st.res[event.res] + event.amt);
      else if (event.type === "morale") st.morale = Math.min(100, st.morale + event.amt);
    }

    // Deaths
    let deaths = 0;
    if (st.res.o2 < 0) { deaths += Math.ceil(Math.abs(st.res.o2) / 3); st.res.o2 = 0; }
    if (st.res.food < 0) { deaths += Math.ceil(Math.abs(st.res.food) / 4); st.res.food = 0; }
    if (st.res.water < 0) { deaths += Math.ceil(Math.abs(st.res.water) / 3); st.res.water = 0; }
    if (st.res.energy < 0) { st.res.energy = 0; st.morale = Math.max(0, st.morale - 10); }
    deaths = Math.min(deaths, st.colonists);
    st.colonists -= deaths;

    if (deaths > 0) st.morale = Math.max(0, st.morale - deaths * 12);
    if (st.res.o2 < 5 || st.res.food < 3) st.morale = Math.max(0, st.morale - 5);
    if (st.res.o2 > 10 && st.res.food > 8 && st.res.water > 6) st.morale = Math.min(100, st.morale + 2);

    if (st.morale > 70 && st.colonists < st.maxCol && sol > 5 && rng(seed, sol, "arrival") > 0.7) {
      st.colonists++;
    }

    Object.keys(st.res).forEach(k => { st.res[k] = Math.max(0, Math.round(st.res[k])); });

    log.push({ sol, deaths, colonists: st.colonists });
    prev = entry.hash;

    if (st.colonists <= 0) break;
  }

  const survived = st.colonists > 0;
  const score = survived
    ? st.colonists * 100 + st.morale * 2 + st.buildings.length * 30 + Object.values(st.res).reduce((a, b) => a + b, 0)
    : actionLog.length * 10;

  return { valid: true, finalState: st, survived, score, finalHash: prev };
}

// ── UI HELPERS ──
function StarField() {
  const stars = Array.from({ length: 50 }, (_, i) => ({
    x: fnv(`s${i}x`) / 0xffffffff * 100, y: fnv(`s${i}y`) / 0xffffffff * 100,
    s: 0.5 + fnv(`s${i}s`) / 0xffffffff * 1.5, o: 0.3 + fnv(`s${i}o`) / 0xffffffff * 0.7,
    d: 2 + fnv(`s${i}d`) / 0xffffffff * 4,
  }));
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
      {stars.map((s, i) => <div key={i} style={{
        position: "absolute", left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s,
        borderRadius: "50%", background: "#fff", opacity: s.o,
        animation: `tw ${s.d}s ease-in-out infinite`, animationDelay: `${s.d * 0.3}s`,
      }} />)}
      <style>{`@keyframes tw { 0%,100% { opacity:0.3 } 50% { opacity:1 } }`}</style>
    </div>
  );
}

function ChainPanel({ verusId, actionLog, genesis, verifyResult }) {
  const [open, setOpen] = useState(false);
  if (!verusId) return null;
  const head = actionLog.length > 0 ? actionLog[actionLog.length - 1].hash : genesis;
  return (
    <div onClick={() => setOpen(!open)} style={{
      background: "rgba(0,8,4,0.9)", border: "1px solid #0f3320", borderRadius: 4,
      padding: "8px 12px", fontFamily: "'Courier New', monospace", fontSize: 10,
      color: "#22c55e", marginTop: 14, maxHeight: open ? 600 : 56,
      overflow: "hidden", transition: "max-height 0.3s", cursor: "pointer",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#16a34a", fontWeight: 700 }}>⛓ PROOF-OF-GAMEPLAY CHAIN</span>
        <span style={{ color: "#333", fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </div>
      <div style={{ color: "#0f5a2a", fontSize: 9 }}>
        ID: <span style={{ color: "#22c55e" }}>{verusId}.Verus Arcade@</span> · Head: <span style={{ color: "#4ade80" }}>{head}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "#0a4a1f", marginBottom: 4 }}>genesis → <span style={{ color: "#4ade80" }}>{genesis}</span></div>
          {actionLog.map((e, i) => (
            <div key={i} style={{ marginBottom: 3, paddingLeft: 8, borderLeft: "2px solid #0a3318" }}>
              <div style={{ color: "#0f5a2a" }}>Sol {e.sol} · <span style={{ color: "#4ade80" }}>{e.hash}</span></div>
              <div style={{ color: "#0a4a1f", fontSize: 9 }}>actions: [{e.actions.join(", ")}]</div>
            </div>
          ))}
          {verifyResult && (
            <div style={{
              marginTop: 8, padding: "6px 8px", borderRadius: 3,
              background: verifyResult.valid ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${verifyResult.valid ? "#22c55e" : "#ef4444"}`,
            }}>
              <span style={{ color: verifyResult.valid ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                {verifyResult.valid
                  ? `✓ VERIFIED — Score: ${verifyResult.score}, ${verifyResult.finalState.colonists} colonists`
                  : `✗ INVALID — ${verifyResult.error}`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResBar({ label, icon, value, max, color, prod, cons }) {
  const pct = Math.min(100, (value / Math.max(max, 1)) * 100);
  const net = (prod || 0) - (cons || 0);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
        <span style={{ color: "#8899aa" }}>{icon} {label}</span>
        <span>
          <span style={{ color: "#c8d6e5", fontWeight: 700, fontFamily: "monospace" }}>{value}</span>
          {net !== 0 && <span style={{ color: net > 0 ? "#22c55e" : "#ef4444", fontSize: 10, marginLeft: 4 }}>{net > 0 ? "+" : ""}{net}/sol</span>}
        </span>
      </div>
      <div style={{ height: 4, background: "#1a2332", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: pct < 20 ? "#ef4444" : color, borderRadius: 2, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

// ── GAME STATE ──
const mkInit = () => ({
  phase: "title", verusId: "", planet: null, sol: 0,
  colonists: 3, maxCol: 5, morale: 60,
  res: { o2: 20, food: 15, water: 12, energy: 15, materials: 10 },
  buildings: ["solar", "o2gen", "waterex"],
  history: [], solResult: null,
  // Proof-of-gameplay
  actionLog: [], genesis: "",
  solActions: [], // actions taken this sol (before end-sol)
  verifyResult: null, dead: false,
});

// ── MAIN GAME ──
export default function ColonyOne() {
  const [state, setState] = useState(mkInit());
  const up = useCallback((p) => setState(prev => ({ ...prev, ...p })), []);
  const navigate = useNavigate();

  const startGame = () => {
    const id = state.verusId.trim().replace(/@/g, "");
    if (!id) return;
    const planet = genPlanet(id);
    const genesis = hashStr(`genesis::${id}`);
    up({ ...mkInit(), phase: "briefing", verusId: id, planet, sol: 1, genesis });
  };

  const beginMission = () => up({ phase: "plan", solActions: [] });

  const actionsLeft = 2 - state.solActions.length;
  const canAct = actionsLeft > 0;

  const doAction = (actionStr) => {
    if (!canAct) return;

    // Apply action to local state immediately (for UI feedback)
    const newRes = { ...state.res };
    let newMorale = state.morale;
    let newBuildings = [...state.buildings];
    let newMaxCol = state.maxCol;
    const actIdx = state.solActions.length;

    if (actionStr === "explore") {
      const r = rng(state.verusId, state.sol, `explore${actIdx}`);
      if (r < 0.35) newRes.materials += rngR(state.verusId, state.sol, `exmat${actIdx}`, 2, 6);
      else if (r < 0.55) newRes.water += rngR(state.verusId, state.sol, `exwat${actIdx}`, 1, 4);
      else if (r < 0.70) newRes.food += rngR(state.verusId, state.sol, `exfood${actIdx}`, 1, 3);
      else { newRes.materials += 1; newRes.water += 1; }
    } else if (actionStr === "gather") {
      newRes.materials += Math.round(2 * state.planet.resMod) + 1;
    } else if (actionStr === "rest") {
      newMorale = Math.min(100, newMorale + 8);
    } else if (actionStr.startsWith("build:")) {
      const bk = actionStr.split(":")[1];
      const b = BUILDINGS[bk];
      for (const [rk, rv] of Object.entries(b.cost)) newRes[rk] -= rv;
      newBuildings.push(bk);
      if (bk === "habitat") newMaxCol += 2;
    }

    up({
      res: newRes, morale: newMorale,
      buildings: newBuildings, maxCol: newMaxCol,
      solActions: [...state.solActions, actionStr],
    });
  };

  const canBuild = (key) => {
    const b = BUILDINGS[key];
    return canAct && Object.entries(b.cost).every(([rk, rv]) => (state.res[rk] || 0) >= rv);
  };

  // ── END SOL: record actions, hash-chain them, simulate outcomes ──
  const endSol = () => {
    const actionData = { sol: state.sol, actions: state.solActions };
    const prev = state.actionLog.length > 0
      ? state.actionLog[state.actionLog.length - 1].hash
      : state.genesis;
    const actionHash = chainHash(prev, actionData);

    const weather = getWeather(state.verusId, state.sol, state.planet);
    const event = getEvent(state.verusId, state.sol);
    const prod = calcProd(state.buildings, state.planet, weather);
    const cons = calcCons(state.colonists);

    const newRes = { ...state.res };
    newRes.energy += prod.energy; newRes.o2 += prod.o2;
    newRes.food += prod.food; newRes.water += prod.water;
    newRes.materials += prod.materials;
    newRes.o2 -= cons.o2; newRes.food -= cons.food;
    newRes.water -= cons.water; newRes.energy -= cons.energy;

    let stormDmg = "";
    const shieldN = state.buildings.filter(b => b === "shield").length;
    const shieldR = Math.min(0.8, shieldN * 0.4);
    if (weather.danger > 0.3) {
      const dmgR = rng(state.verusId, state.sol, "stormdmg");
      const actualD = weather.danger * (1 - shieldR);
      if (dmgR < actualD) {
        const lost = Math.round(3 * actualD);
        newRes.materials = Math.max(0, newRes.materials - lost);
        newRes.energy = Math.max(0, newRes.energy - lost);
        stormDmg = `Storm damage! -${lost} materials & energy${shieldN > 0 ? ` (${Math.round(shieldR*100)}% shielded)` : ""}`;
      }
    }

    let eventLog = "";
    let newMorale = state.morale;
    if (event) {
      eventLog = event.text;
      if (event.type === "bonus" && event.res) newRes[event.res] += event.amt;
      else if (event.type === "damage" && event.res) newRes[event.res] = Math.max(0, newRes[event.res] + event.amt);
      else if (event.type === "morale") newMorale = Math.min(100, newMorale + event.amt);
    }

    let deaths = 0; let deathCause = [];
    if (newRes.o2 < 0) { deaths += Math.ceil(Math.abs(newRes.o2) / 3); deathCause.push("suffocation"); newRes.o2 = 0; }
    if (newRes.food < 0) { deaths += Math.ceil(Math.abs(newRes.food) / 4); deathCause.push("starvation"); newRes.food = 0; }
    if (newRes.water < 0) { deaths += Math.ceil(Math.abs(newRes.water) / 3); deathCause.push("dehydration"); newRes.water = 0; }
    if (newRes.energy < 0) { newRes.energy = 0; newMorale = Math.max(0, newMorale - 10); }
    deaths = Math.min(deaths, state.colonists);
    const newCol = state.colonists - deaths;

    if (deaths > 0) newMorale = Math.max(0, newMorale - deaths * 12);
    if (newRes.o2 < 5 || newRes.food < 3) newMorale = Math.max(0, newMorale - 5);
    if (newRes.o2 > 10 && newRes.food > 8 && newRes.water > 6) newMorale = Math.min(100, newMorale + 2);

    let arrival = false;
    if (newMorale > 70 && newCol < state.maxCol && state.sol > 5 && rng(state.verusId, state.sol, "arrival") > 0.7) {
      arrival = true;
    }

    Object.keys(newRes).forEach(k => { newRes[k] = Math.max(0, Math.round(newRes[k])); });

    const result = { sol: state.sol, weather, event: eventLog, stormDmg, prod, cons, deaths, deathCause: deathCause.join(", "), arrival };
    const isDead = (arrival ? newCol + 1 : newCol) <= 0;

    up({
      phase: isDead ? "gameover" : "result",
      res: newRes,
      colonists: arrival ? newCol + 1 : newCol,
      morale: newMorale,
      solResult: result,
      history: [...state.history, result],
      actionLog: [...state.actionLog, { ...actionData, hash: actionHash }],
      dead: isDead,
    });
  };

  const nextSol = () => {
    if (state.sol >= TOTAL_SOLS) {
      const vr = replayGame(state.verusId, state.actionLog);
      up({ phase: "gameover", verifyResult: vr });
    } else {
      up({ phase: "plan", sol: state.sol + 1, solActions: [], solResult: null });
    }
  };

  const resetGame = () => setState(mkInit());

  const weather = state.planet && state.sol > 0 ? getWeather(state.verusId, state.sol, state.planet) : null;
  const prod = state.planet ? calcProd(state.buildings, state.planet, weather || { eMod: 1 }) : null;
  const cons = calcCons(state.colonists);

  // ── STYLES ──
  const S = {
    bg: "#080c14", card: "rgba(12,20,33,0.85)", border: "#1a2a3e",
    acc: "#f59e0b", green: "#22c55e", red: "#ef4444", blue: "#3b82f6", cyan: "#06b6d4",
    text: "#c8d6e5", dim: "#5a6a7e", bright: "#e8f0fc",
    font: "'Courier New', monospace", body: "'Segoe UI', sans-serif",
  };
  const box = { maxWidth: 540, margin: "0 auto", padding: 16, fontFamily: S.body, color: S.text, background: S.bg, minHeight: "100vh", position: "relative", zIndex: 1 };
  const cd = { background: S.card, border: `1px solid ${S.border}`, borderRadius: 6, padding: "14px 16px", marginBottom: 10 };
  const bn = (pri = false, dis = false) => ({
    padding: "9px 16px", border: pri ? "none" : `1px solid ${S.border}`, borderRadius: 4,
    background: dis ? "#1a2030" : pri ? `linear-gradient(135deg, ${S.acc}, #d97706)` : "rgba(20,30,48,0.8)",
    color: dis ? "#3a4a5a" : pri ? "#000" : S.text,
    fontFamily: S.font, fontSize: 12, fontWeight: 700, cursor: dis ? "default" : "pointer",
    letterSpacing: 0.5, textTransform: "uppercase",
  });
  const lb = { fontSize: 9, textTransform: "uppercase", letterSpacing: 2, color: S.dim, fontFamily: S.font, fontWeight: 700, marginBottom: 6 };

  // ════════ TITLE ════════
  if (state.phase === "title") {
    return (
      <div style={{ ...box, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <StarField />
        <div style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 48, marginBottom: 4, filter: "drop-shadow(0 0 12px rgba(245,158,11,0.4))" }}>🪐</div>
          <h1 style={{ fontSize: 32, fontWeight: 900, color: S.bright, margin: "8px 0 2px", fontFamily: S.font, letterSpacing: 3 }}>COLONY ONE</h1>
          <div style={{ fontSize: 10, letterSpacing: 4, color: S.acc, fontFamily: S.font, fontWeight: 700, marginBottom: 28 }}>VERUS ARCADE · PROOF-OF-GAMEPLAY</div>
          <div style={{ ...cd, textAlign: "left", fontSize: 13, lineHeight: 1.8 }}>
            <p style={{ margin: "0 0 10px" }}>Land on a procedurally generated planet. Survive <strong style={{ color: S.acc }}>30 sols</strong>. Every action is hash-chained — tamper-proof and verifiable.</p>
            <p style={{ margin: 0, fontSize: 11, color: S.dim }}>Your VerusID generates the planet. Same ID = same world. Scores are mathematically provable.</p>
          </div>
          <div style={{ ...cd, textAlign: "left" }}>
            <div style={lb}>Commander ID</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="text" value={state.verusId} onChange={(e) => up({ verusId: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && startGame()} placeholder="commander"
                style={{ flex: 1, padding: "10px 12px", border: `1px solid ${S.border}`, borderRadius: 4, fontFamily: S.font, fontSize: 14, color: S.acc, background: "rgba(0,0,0,0.4)", outline: "none" }} />
              <span style={{ fontSize: 11, color: S.dim, fontFamily: S.font }}>.Verus Arcade@</span>
            </div>
          </div>
          <button onClick={startGame} style={{ ...bn(true), width: "100%", padding: 14, fontSize: 14, letterSpacing: 2 }}>🚀 LAUNCH MISSION</button>
          <button onClick={() => navigate('/')} style={{ ...bn(), width: "100%", padding: 10, fontSize: 11, marginTop: 8, borderColor: "#5a6a7e", color: "#5a6a7e" }}>← BACK TO ARCADE</button>
        </div>
      </div>
    );
  }

  // ════════ BRIEFING ════════
  if (state.phase === "briefing") {
    const p = state.planet;
    return (
      <div style={box}><StarField /><div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 56, marginBottom: 4 }}>{p.icon}</div>
          <div style={{ ...lb, color: S.acc, letterSpacing: 3 }}>PLANETARY SURVEY</div>
          <h2 style={{ fontSize: 22, fontWeight: 900, color: S.bright, margin: "4px 0", fontFamily: S.font }}>{p.designation}</h2>
          <div style={{ fontSize: 14, color: p.color, fontWeight: 700 }}>{p.name}</div>
        </div>
        <div style={cd}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { l: "Gravity", v: `${p.gravity}g`, c: p.gravity > 0.8 ? S.red : S.green },
              { l: "Solar", v: `${(p.solar * 100).toFixed(0)}%`, c: p.solar > 1 ? S.acc : S.cyan },
              { l: "Atmosphere", v: `${(p.atmo * 100).toFixed(0)}%`, c: p.atmo > 0.5 ? S.green : S.red },
              { l: "Temperature", v: `${p.tempBase}°C`, c: Math.abs(p.tempBase) > 30 ? S.red : S.green },
              { l: "Resources", v: `${(p.resMod * 100).toFixed(0)}%`, c: p.resMod > 1 ? S.green : S.acc },
              { l: "Storm Risk", v: `${(p.stormChance * 100).toFixed(0)}%`, c: p.stormChance > 0.25 ? S.red : S.green },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ ...lb, marginBottom: 2 }}>{l}</div><div style={{ fontSize: 15, fontWeight: 700, color: c, fontFamily: S.font }}>{v}</div></div>
            ))}
          </div>
        </div>
        <div style={{ ...cd, fontSize: 12, lineHeight: 1.7, color: S.dim }}>
          <strong style={{ color: S.text }}>Mission:</strong> 3 colonists, basic equipment. Survive 30 sols. 2 actions per sol.
        </div>
        <button onClick={beginMission} style={{ ...bn(true), width: "100%", padding: 14, fontSize: 13, letterSpacing: 2 }}>🛬 BEGIN COLONIZATION</button>
        <button onClick={resetGame} style={{ ...bn(), width: "100%", padding: 10, fontSize: 11, marginTop: 6, borderColor: S.red, color: S.red }}>↺ RESTART</button>
      </div></div>
    );
  }

  // ════════ PLAN ════════
  if (state.phase === "plan") {
    return (
      <div style={box}><StarField /><div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <div>
            <div style={{ ...lb, marginBottom: 0 }}>Sol {state.sol}/{TOTAL_SOLS}</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: S.bright, fontFamily: S.font }}>{state.planet.designation}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: S.dim }}>{weather.icon} {weather.cond} · {weather.temp}°C</div>
            <button onClick={resetGame} style={{ ...bn(), padding: "4px 12px", fontSize: 10, marginTop: 4, borderColor: S.red, color: S.red }}>↺ RESTART</button>
          </div>
        </div>

        <div style={{ ...cd, display: "flex", justifyContent: "space-around", textAlign: "center", padding: 10 }}>
          <div><div style={{ fontSize: 9, color: S.dim, fontFamily: S.font }}>COLONISTS</div><div style={{ fontSize: 18, fontWeight: 900, color: S.bright }}>{state.colonists}<span style={{ fontSize: 11, color: S.dim }}>/{state.maxCol}</span></div></div>
          <div><div style={{ fontSize: 9, color: S.dim, fontFamily: S.font }}>MORALE</div><div style={{ fontSize: 18, fontWeight: 900, color: state.morale > 50 ? S.green : state.morale > 25 ? S.acc : S.red }}>{state.morale}%</div></div>
          <div><div style={{ fontSize: 9, color: S.dim, fontFamily: S.font }}>ACTIONS</div><div style={{ fontSize: 18, fontWeight: 900, color: actionsLeft > 0 ? S.acc : S.dim }}>{actionsLeft}</div></div>
        </div>

        <div style={cd}>
          <div style={lb}>Resources</div>
          <ResBar label="Oxygen" icon="🫧" value={state.res.o2} max={60} color={S.cyan} cons={cons.o2} prod={prod.o2} />
          <ResBar label="Food" icon="🌾" value={state.res.food} max={40} color={S.green} cons={cons.food} prod={prod.food} />
          <ResBar label="Water" icon="💧" value={state.res.water} max={40} color={S.blue} cons={cons.water} prod={prod.water} />
          <ResBar label="Energy" icon="⚡" value={state.res.energy} max={50} color={S.acc} cons={cons.energy} prod={prod.energy} />
          <ResBar label="Materials" icon="🪨" value={state.res.materials} max={60} color="#8b95a5" prod={prod.materials} />
        </div>

        {/* Actions taken this sol */}
        {state.solActions.length > 0 && (
          <div style={{ ...cd, padding: "8px 16px" }}>
            <div style={lb}>Actions this Sol</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {state.solActions.map((a, i) => (
                <span key={i} style={{ background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "3px 8px", fontSize: 10, color: S.acc, fontFamily: S.font }}>{a}</span>
              ))}
            </div>
          </div>
        )}

        <div style={cd}>
          <div style={lb}>Actions</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button onClick={() => doAction("explore")} disabled={!canAct} style={bn(false, !canAct)}>🔭 Explore</button>
            <button onClick={() => doAction("gather")} disabled={!canAct} style={bn(false, !canAct)}>🪨 Gather</button>
            <button onClick={() => doAction("rest")} disabled={!canAct} style={bn(false, !canAct)}>😴 Rest</button>
            <div style={{ fontSize: 10, color: S.dim, display: "flex", alignItems: "center", justifyContent: "center" }}>or build ↓</div>
          </div>
        </div>

        <div style={cd}>
          <div style={lb}>Build (1 action)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {Object.entries(BUILDINGS).map(([k, b]) => (
              <button key={k} onClick={() => doAction(`build:${k}`)} disabled={!canBuild(k)} style={{ ...bn(false, !canBuild(k)), textAlign: "left", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{b.icon} {b.name}</span>
                <span style={{ fontSize: 9, color: !canBuild(k) ? "#2a3a4a" : S.dim }}>{Object.entries(b.cost).map(([r, v]) => `${v} ${r}`).join(", ")}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ ...cd, padding: "8px 16px" }}>
          <div style={lb}>Structures</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {state.buildings.map((b, i) => (
              <span key={i} style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 3, padding: "3px 7px", fontSize: 10, color: S.acc, fontFamily: S.font }}>
                {BUILDINGS[b]?.icon} {BUILDINGS[b]?.name}
              </span>
            ))}
          </div>
        </div>

        <button onClick={endSol} style={{ ...bn(true), width: "100%", padding: 14, fontSize: 13, letterSpacing: 2 }}>⏳ END SOL {state.sol}</button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesis={state.genesis} />
      </div></div>
    );
  }

  // ════════ RESULT ════════
  if (state.phase === "result" && state.solResult) {
    const r = state.solResult;
    const lastAct = state.actionLog[state.actionLog.length - 1];
    return (
      <div style={box}><StarField /><div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ ...lb, color: S.acc }}>SOL {r.sol} REPORT</div>
            <div style={{ fontSize: 32 }}>{r.weather.icon}</div>
            <div style={{ fontSize: 13, color: S.dim }}>{r.weather.cond} · {r.weather.temp}°C</div>
          </div>
          <button onClick={resetGame} style={{ ...bn(), padding: "4px 12px", fontSize: 10, borderColor: S.red, color: S.red }}>↺ RESTART</button>
        </div>

        <div style={{
          background: "rgba(0,8,4,0.7)", borderRadius: 4, padding: "5px 10px",
          fontFamily: S.font, fontSize: 10, color: "#22c55e", textAlign: "center", margin: "8px 0 10px",
        }}>
          ⛓ Hash: <span style={{ color: "#4ade80" }}>{lastAct.hash}</span> · [{lastAct.actions.join(", ")}]
        </div>

        {r.event && <div style={{ ...cd, borderColor: S.acc, background: "rgba(245,158,11,0.05)", textAlign: "center", fontSize: 13, fontWeight: 700, color: S.acc }}>{r.event}</div>}
        {r.stormDmg && <div style={{ ...cd, borderColor: S.red, background: "rgba(239,68,68,0.05)", textAlign: "center", fontSize: 12, color: S.red }}>{r.stormDmg}</div>}

        <div style={cd}>
          <div style={lb}>Production → Consumption</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
            {["o2", "food", "water", "energy"].map(k => {
              const net = (r.prod[k] || 0) - (r.cons[k] || 0);
              return (<div key={k}><div style={{ fontSize: 9, color: S.dim, textTransform: "uppercase" }}>{k === "o2" ? "O₂" : k}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: net >= 0 ? S.green : S.red, fontFamily: S.font }}>{net >= 0 ? "+" : ""}{net}</div></div>);
            })}
          </div>
        </div>

        {r.deaths > 0 && <div style={{ ...cd, borderColor: S.red, background: "rgba(239,68,68,0.08)", textAlign: "center" }}>
          <div style={{ fontSize: 20, color: S.red, fontWeight: 900 }}>💀 {r.deaths} lost</div>
          <div style={{ fontSize: 12, color: S.red, marginTop: 4 }}>{r.deathCause}</div>
        </div>}

        {r.arrival && <div style={{ ...cd, borderColor: S.green, background: "rgba(34,197,94,0.06)", textAlign: "center", fontSize: 13, color: S.green, fontWeight: 700 }}>🛬 New colonist arrived!</div>}

        <div style={{ ...cd, display: "flex", justifyContent: "space-around", textAlign: "center" }}>
          {[
            { l: "COLONISTS", v: state.colonists, c: S.bright },
            { l: "MORALE", v: `${state.morale}%`, c: state.morale > 50 ? S.green : S.red },
            { l: "STRUCTURES", v: state.buildings.length, c: S.acc },
          ].map(({ l, v, c }) => (
            <div key={l}><div style={{ fontSize: 9, color: S.dim, fontFamily: S.font }}>{l}</div><div style={{ fontSize: 20, fontWeight: 900, color: c }}>{v}</div></div>
          ))}
        </div>

        <button onClick={nextSol} style={{ ...bn(true), width: "100%", padding: 14, fontSize: 13, letterSpacing: 2 }}>
          {state.sol >= TOTAL_SOLS ? "📊 MISSION COMPLETE" : `➜ SOL ${state.sol + 1}`}
        </button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesis={state.genesis} />
      </div></div>
    );
  }

  // ════════ GAME OVER ════════
  if (state.phase === "gameover") {
    const surv = !state.dead && state.colonists > 0;
    const totalDeaths = state.history.reduce((s, h) => s + h.deaths, 0);
    const score = surv
      ? state.colonists * 100 + state.morale * 2 + state.buildings.length * 30 + Object.values(state.res).reduce((a, b) => a + b, 0)
      : state.sol * 10;
    const rank = surv ? (score > 800 ? "S" : score > 600 ? "A" : score > 400 ? "B" : "C") : (state.sol > 20 ? "D" : "F");
    const rc = { S: S.acc, A: S.green, B: S.blue, C: S.text, D: "#c97932", F: S.red }[rank];
    const vr = state.verifyResult;
    const head = state.actionLog.length > 0 ? state.actionLog[state.actionLog.length - 1].hash : state.genesis;

    return (
      <div style={box}><StarField /><div style={{ position: "relative", zIndex: 1, textAlign: "center", paddingTop: 16 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>{surv ? "🏆" : "💀"}</div>
        <h2 style={{ fontSize: 24, fontWeight: 900, color: S.bright, fontFamily: S.font, margin: "0 0 4px" }}>{surv ? "MISSION COMPLETE" : "COLONY LOST"}</h2>
        <div style={{ fontSize: 12, color: S.dim, marginBottom: 12 }}>{surv ? `Survived ${TOTAL_SOLS} sols` : `Perished on Sol ${state.sol}`}</div>
        <div style={{ fontSize: 64, fontWeight: 900, color: rc, fontFamily: S.font, lineHeight: 1, margin: "8px 0", textShadow: `0 0 30px ${rc}40` }}>{rank}</div>
        <div style={{ ...lb, color: S.acc, marginBottom: 12 }}>SCORE: {score}</div>

        {vr && (
          <div style={{
            padding: "10px 14px", borderRadius: 6, marginBottom: 12, textAlign: "left",
            background: vr.valid ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
            border: `1px solid ${vr.valid ? S.green : S.red}`,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: vr.valid ? S.green : S.red, textAlign: "center" }}>
              {vr.valid ? "✓ PROOF-OF-GAMEPLAY VERIFIED" : "✗ VERIFICATION FAILED"}
            </div>
            <div style={{ fontSize: 11, color: S.dim, marginTop: 4, textAlign: "center" }}>
              {vr.valid ? `Replayed ${state.actionLog.length} sols. Score: ${vr.score}. ${vr.finalState.colonists} colonists.` : vr.error}
            </div>
            <div style={{ fontFamily: S.font, fontSize: 10, color: S.acc, marginTop: 4, textAlign: "center" }}>Chain head: {head}</div>
          </div>
        )}

        <div style={cd}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, textAlign: "center" }}>
            {[
              { l: "Sols", v: surv ? TOTAL_SOLS : state.sol },
              { l: "Colonists", v: state.colonists, c: state.colonists > 0 ? S.green : S.red },
              { l: "Deaths", v: totalDeaths, c: totalDeaths > 0 ? S.red : S.green },
              { l: "Structures", v: state.buildings.length },
              { l: "Morale", v: `${state.morale}%`, c: state.morale > 50 ? S.green : S.red },
              { l: "Planet", v: state.planet.name },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ ...lb, marginBottom: 2 }}>{l}</div><div style={{ fontSize: 14, fontWeight: 700, color: c || S.bright, fontFamily: S.font }}>{v}</div></div>
            ))}
          </div>
        </div>

        <div style={cd}>
          <div style={lb}>Mission Log</div>
          <div style={{ maxHeight: 160, overflow: "auto" }}>
            {state.history.map(h => (
              <div key={h.sol} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", borderBottom: `1px solid ${S.border}`, color: S.dim }}>
                <span>Sol {h.sol} {h.weather.icon}</span>
                <span>{h.deaths > 0 ? `💀${h.deaths}` : "✓"}</span>
                <span style={{ color: h.event ? S.acc : "transparent", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.event || "—"}</span>
              </div>
            ))}
          </div>
        </div>

        <button onClick={resetGame} style={{ ...bn(true), width: "100%", padding: 14, fontSize: 14, letterSpacing: 2 }}>🚀 NEW MISSION</button>
        <ChainPanel verusId={state.verusId} actionLog={state.actionLog} genesis={state.genesis} verifyResult={state.verifyResult} />

        <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(0,8,4,0.9)", borderRadius: 4, fontFamily: S.font, fontSize: 10, color: "#22c55e", textAlign: "left" }}>
          <div style={{ color: "#0f5a2a" }}>// On-chain proof (stored in VerusID):</div>
          <div style={{ color: "#4ade80" }}>vrsc::arcade.colony.seed → "{state.verusId}"</div>
          <div style={{ color: "#4ade80" }}>vrsc::arcade.colony.actions → [{state.actionLog.length} chained entries]</div>
          <div style={{ color: "#4ade80" }}>vrsc::arcade.colony.chainhead → "{head}"</div>
          <div style={{ color: "#0f5a2a", marginTop: 4 }}>// Edit any action → hash chain breaks → score rejected</div>
        </div>
      </div></div>
    );
  }

  return null;
}
