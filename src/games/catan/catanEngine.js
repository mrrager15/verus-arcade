// catanEngine.js — Core game logic for Colony of Catan

const HEX_SIZE = 54;
export const BOARD_OFFSET = { x: 370, y: 320 };

// 19 hex positions in axial coordinates (flat-top layout)
// Center is (0,0), rings expand outward
export const BOARD_POSITIONS = [
  // Ring 0 (center)
  { q: 0, r: 0 },
  // Ring 1
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
  // Ring 2
  { q: 2, r: 0 }, { q: 2, r: -1 }, { q: 2, r: -2 },
  { q: 1, r: -2 }, { q: 0, r: -2 }, { q: -1, r: -1 },
  { q: -2, r: 0 }, { q: -2, r: 1 }, { q: -2, r: 2 },
  { q: -1, r: 2 }, { q: 0, r: 2 }, { q: 1, r: 1 },
];

export const RESOURCES = {
  WOOD: 'wood',
  BRICK: 'brick',
  ORE: 'ore',
  GRAIN: 'grain',
  WOOL: 'wool',
  DESERT: 'desert',
};

// Standard Catan tile distribution: 4 wood, 3 brick, 3 ore, 4 grain, 4 wool, 1 desert
const RESOURCE_TILES = [
  ...Array(4).fill(RESOURCES.WOOD),
  ...Array(3).fill(RESOURCES.BRICK),
  ...Array(3).fill(RESOURCES.ORE),
  ...Array(4).fill(RESOURCES.GRAIN),
  ...Array(4).fill(RESOURCES.WOOL),
  RESOURCES.DESERT,
];

// Standard number tokens (18 tokens for 18 non-desert hexes)
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// Building costs
export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, grain: 1, wool: 1 },
  city: { grain: 2, ore: 3 },
};

// Player colors
export const PLAYER_COLORS = ['#4a90e2', '#e05c5c', '#5cba6b', '#e0a84a'];
export const PLAYER_NAMES_NPC = ['Scout', 'Pioneer', 'Trader'];

export const WIN_VP = 10;

// ─── Board geometry ───────────────────────────────────────────────────────────

/** Convert axial hex coords to pixel center (flat-top orientation) */
export function hexToPixel(q, r) {
  return {
    x: HEX_SIZE * (3 / 2) * q + BOARD_OFFSET.x,
    y: HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r) + BOARD_OFFSET.y,
  };
}

/** Get the 6 vertex pixel positions of a flat-top hex centered at (cx, cy) */
function hexVertexPositions(cx, cy) {
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i); // flat-top: 0°, 60°, 120°, ...
    verts.push({
      x: parseFloat((cx + HEX_SIZE * Math.cos(angle)).toFixed(2)),
      y: parseFloat((cy + HEX_SIZE * Math.sin(angle)).toFixed(2)),
    });
  }
  return verts;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Board generation ─────────────────────────────────────────────────────────

/**
 * Generates a full Catan board: hexes, vertices, and edges.
 * Each vertex knows which hexes border it.
 * Each edge connects two vertices and records any road placed on it.
 */
export function generateBoard() {
  const resources = shuffle(RESOURCE_TILES);
  const numbers = shuffle(NUMBER_TOKENS);
  let numberIdx = 0;

  // Build hexes
  const hexes = BOARD_POSITIONS.map((pos, i) => {
    const resource = resources[i];
    const { x, y } = hexToPixel(pos.q, pos.r);
    return {
      id: i,
      q: pos.q,
      r: pos.r,
      resource,
      number: resource === RESOURCES.DESERT ? null : numbers[numberIdx++],
      cx: x,
      cy: y,
      vertexIds: [], // filled below
    };
  });

  // Build deduplicated vertex list
  const vertexMap = new Map(); // "x,y" → vertex
  const vertices = [];

  hexes.forEach((hex) => {
    const rawVerts = hexVertexPositions(hex.cx, hex.cy);
    rawVerts.forEach((v) => {
      const key = `${v.x},${v.y}`;
      if (!vertexMap.has(key)) {
        const vertex = {
          id: vertices.length,
          x: v.x,
          y: v.y,
          hexes: [],
          building: null, // null | 'settlement' | 'city'
          owner: null,    // player index or null
        };
        vertexMap.set(key, vertex);
        vertices.push(vertex);
      }
      const vertex = vertexMap.get(key);
      vertex.hexes.push(hex.id);
      hex.vertexIds.push(vertex.id);
    });
  });

  // Build deduplicated edge list
  const edgeMap = new Map(); // "v1-v2" → edge
  const edges = [];

  hexes.forEach((hex) => {
    for (let i = 0; i < 6; i++) {
      const v1id = hex.vertexIds[i];
      const v2id = hex.vertexIds[(i + 1) % 6];
      const key = [v1id, v2id].sort((a, b) => a - b).join('-');
      if (!edgeMap.has(key)) {
        const edge = { id: edges.length, v1: v1id, v2: v2id, road: null };
        edgeMap.set(key, edge);
        edges.push(edge);
      }
    }
  });

  return { hexes, vertices, edges };
}

// ─── Validity checks ──────────────────────────────────────────────────────────

/** Returns all vertex IDs adjacent (connected by an edge) to a given vertex */
export function getAdjacentVertexIds(vertexId, edges) {
  const neighbors = new Set();
  edges.forEach((e) => {
    if (e.v1 === vertexId) neighbors.add(e.v2);
    if (e.v2 === vertexId) neighbors.add(e.v1);
  });
  return [...neighbors];
}

/**
 * Is this vertex a valid spot to place a settlement?
 * Rules: not occupied, no neighbor occupied (distance rule), and connected by road if not setup phase.
 */
export function isValidSettlementSpot(vertexId, vertices, edges, playerId, isSetup) {
  const vertex = vertices[vertexId];
  if (vertex.building) return false; // already built here

  // Distance rule: no adjacent building
  const neighbors = getAdjacentVertexIds(vertexId, edges);
  for (const nId of neighbors) {
    if (vertices[nId].building) return false;
  }

  // In setup, any open vertex is fine
  if (isSetup) return true;

  // In main game, must be connected by the player's own road
  return edges.some(
    (e) => (e.v1 === vertexId || e.v2 === vertexId) && e.road === playerId
  );
}

/**
 * Returns edge IDs that the current player can legally place a road on.
 * In setup, edges must be adjacent to setupVertexId (the just-placed settlement).
 */
export function getValidRoadEdges(edges, vertices, playerId, isSetup, setupVertexId = null) {
  return edges
    .filter((e) => {
      if (e.road !== null) return false; // already has a road

      if (isSetup) {
        if (setupVertexId === null) return false;
        return e.v1 === setupVertexId || e.v2 === setupVertexId;
      }

      // Main game: must connect to player's own road, settlement, or city
      const { v1, v2 } = e;

      const v1Connected =
        vertices[v1].owner === playerId ||
        edges.some((oe) => oe.id !== e.id && oe.road === playerId && (oe.v1 === v1 || oe.v2 === v1));

      const v2Connected =
        vertices[v2].owner === playerId ||
        edges.some((oe) => oe.id !== e.id && oe.road === playerId && (oe.v1 === v2 || oe.v2 === v2));

      return v1Connected || v2Connected;
    })
    .map((e) => e.id);
}

/** Returns vertex IDs where the player can upgrade a settlement to a city */
export function getValidCitySpots(vertices, playerId) {
  return vertices
    .filter((v) => v.owner === playerId && v.building === 'settlement')
    .map((v) => v.id);
}

// ─── Resource & economy ───────────────────────────────────────────────────────

/**
 * Distribute resources to all players based on dice roll.
 * Returns updated players array. Roll of 7 gives nothing (no robber in beta).
 */
export function collectResources(roll, hexes, vertices, players) {
  if (roll === 7) return players;

  const updated = players.map((p) => ({ ...p, resources: { ...p.resources } }));

  hexes.forEach((hex) => {
    if (hex.number !== roll || hex.resource === RESOURCES.DESERT) return;
    hex.vertexIds.forEach((vId) => {
      const v = vertices[vId];
      if (v.building && v.owner !== null) {
        const amount = v.building === 'city' ? 2 : 1;
        updated[v.owner].resources[hex.resource] =
          (updated[v.owner].resources[hex.resource] || 0) + amount;
      }
    });
  });

  return updated;
}

/** Collect resources for second-round setup placement (player gets resources of 2nd settlement hexes) */
export function collectSetupResources(vertexId, hexes, vertices, player) {
  const vertex = vertices[vertexId];
  const newRes = { ...player.resources };
  vertex.hexes.forEach((hId) => {
    const hex = hexes[hId];
    if (hex.resource !== RESOURCES.DESERT) {
      newRes[hex.resource] = (newRes[hex.resource] || 0) + 1;
    }
  });
  return { ...player, resources: newRes };
}

/** Can player afford the given build type? */
export function canAfford(player, type) {
  const cost = COSTS[type];
  return Object.entries(cost).every(([res, amt]) => (player.resources[res] || 0) >= amt);
}

/** Return new player object with cost deducted */
export function deductCost(player, type) {
  const cost = COSTS[type];
  const resources = { ...player.resources };
  Object.entries(cost).forEach(([res, amt]) => {
    resources[res] = (resources[res] || 0) - amt;
  });
  return { ...player, resources };
}

/** 4:1 bank trade. Returns new player object or null if insufficient resources. */
export function bankTrade(player, give, receive) {
  if ((player.resources[give] || 0) < 4) return null;
  const resources = { ...player.resources };
  resources[give] -= 4;
  resources[receive] = (resources[receive] || 0) + 1;
  return { ...player, resources };
}

/** Count VPs for a player */
export function calculateVP(playerId, vertices) {
  return vertices.reduce((vp, v) => {
    if (v.owner !== playerId) return vp;
    return vp + (v.building === 'city' ? 2 : v.building === 'settlement' ? 1 : 0);
  }, 0);
}

/** Roll two dice, return [die1, die2] */
export function rollDice() {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
  ];
}

/** Create the initial players array */
export function createPlayers(humanName) {
  const allNames = [humanName, ...PLAYER_NAMES_NPC];
  return allNames.map((name, i) => ({
    id: i,
    name,
    isNPC: i > 0,
    color: PLAYER_COLORS[i],
    resources: { wood: 0, brick: 0, ore: 0, grain: 0, wool: 0 },
    vp: 0,
  }));
}
