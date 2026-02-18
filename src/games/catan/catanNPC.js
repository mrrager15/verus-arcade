// catanNPC.js — NPC AI decision making

import {
  canAfford,
  isValidSettlementSpot,
  getValidRoadEdges,
  getValidCitySpots,
  RESOURCES,
} from './catanEngine.js';

// ─── Setup phase helpers ───────────────────────────────────────────────────────

/**
 * Score a vertex for initial settlement placement.
 * Higher score = better spot (near productive high-probability hexes).
 */
function scoreVertex(vertexId, vertices, hexes) {
  const vertex = vertices[vertexId];
  // Probability weight: numbers close to 7 are rolled more often
  const probWeight = {
    2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
  };
  let score = 0;
  vertex.hexes.forEach((hId) => {
    const hex = hexes[hId];
    if (hex.resource === RESOURCES.DESERT) return;
    score += probWeight[hex.number] || 0;
  });
  return score;
}

/**
 * NPC picks a settlement vertex during setup.
 * Prefers diverse resources and high probability.
 */
export function npcPickSetupSettlement(playerId, vertices, edges, hexes, isSetup = true) {
  // Collect valid spots
  const candidates = vertices
    .filter((v) => isValidSettlementSpot(v.id, vertices, edges, playerId, isSetup))
    .map((v) => ({
      id: v.id,
      score: scoreVertex(v.id, vertices, hexes) + Math.random() * 2, // small random nudge
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  // Pick from top 3 to add some variety
  const topN = candidates.slice(0, Math.min(3, candidates.length));
  return topN[Math.floor(Math.random() * topN.length)].id;
}

/**
 * NPC picks a road edge during setup (must be adjacent to the just-placed settlement).
 */
export function npcPickSetupRoad(playerId, edges, vertices, setupVertexId) {
  const valid = getValidRoadEdges(edges, vertices, playerId, true, setupVertexId);
  if (!valid.length) return null;
  return valid[Math.floor(Math.random() * valid.length)];
}

// ─── Main game phase ───────────────────────────────────────────────────────────

/**
 * NPC decides what to do on its turn.
 * Returns an array of actions: [{ type, vertexId? edgeId? }]
 * Actions are applied sequentially in CatanGame.
 */
export function npcDecideTurn(playerId, players, vertices, edges, hexes) {
  const player = players[playerId];
  const actions = [];

  // 1. Try to build a city (best VP per resource)
  if (canAfford(player, 'city')) {
    const cityCandidates = getValidCitySpots(vertices, playerId);
    if (cityCandidates.length > 0) {
      // Prefer highest-scoring settlement to upgrade
      const scored = cityCandidates
        .map((vId) => ({ id: vId, score: scoreVertex(vId, vertices, hexes) }))
        .sort((a, b) => b.score - a.score);
      actions.push({ type: 'city', vertexId: scored[0].id });
    }
  }

  // 2. Try to build a settlement
  const validSettlements = vertices.filter((v) =>
    isValidSettlementSpot(v.id, vertices, edges, playerId, false)
  );
  if (canAfford(player, 'settlement') && validSettlements.length > 0) {
    const scored = validSettlements
      .map((v) => ({ id: v.id, score: scoreVertex(v.id, vertices, hexes) + Math.random() }))
      .sort((a, b) => b.score - a.score);
    actions.push({ type: 'settlement', vertexId: scored[0].id });
  }

  // 3. Try to build a road (only if no settlement/city this turn, to save resources)
  if (actions.length === 0 && canAfford(player, 'road')) {
    const validRoads = getValidRoadEdges(edges, vertices, playerId, false);
    if (validRoads.length > 0) {
      // Pick road that expands toward a new settlement spot
      actions.push({
        type: 'road',
        edgeId: validRoads[Math.floor(Math.random() * validRoads.length)],
      });
    }
  }

  return actions;
}
