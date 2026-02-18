// CatanBoard.jsx — SVG hex board renderer

import React from 'react';

const RESOURCE_FILLS = {
  wood:   '#1e5c1e',
  brick:  '#7a2c10',
  ore:    '#4a4a5e',
  grain:  '#b89020',
  wool:   '#5a9c3a',
  desert: '#b09050',
};

const RESOURCE_EMOJI = {
  wood:   '🌲',
  brick:  '🧱',
  ore:    '⛰️',
  grain:  '🌾',
  wool:   '🐑',
  desert: '🏜️',
};

export default function CatanBoard({
  hexes,
  vertices,
  edges,
  validSettlements = [],
  validRoads = [],
  validCities = [],
  onVertexClick,
  onEdgeClick,
  players,
}) {
  const W = 740;
  const H = 660;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', maxWidth: W, display: 'block', userSelect: 'none' }}
    >
      {/* Ocean */}
      <rect width={W} height={H} fill="#0d1f3c" rx="12" />

      {/* ── Hexes ── */}
      {hexes.map((hex) => {
        const points = hex.vertexIds
          .map((vId) => `${vertices[vId].x},${vertices[vId].y}`)
          .join(' ');
        const isDesert = hex.resource === 'desert';

        return (
          <g key={hex.id}>
            <polygon
              points={points}
              fill={RESOURCE_FILLS[hex.resource]}
              stroke="#0a1628"
              strokeWidth={2.5}
            />
            {/* Inner border glow */}
            <polygon
              points={points}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />
            {/* Resource icon */}
            <text
              x={hex.cx}
              y={hex.cy - (hex.number ? 22 : 8)}
              textAnchor="middle"
              fontSize={22}
              style={{ pointerEvents: 'none' }}
            >
              {RESOURCE_EMOJI[hex.resource]}
            </text>
            {/* Number token */}
            {hex.number && (
              <g>
                <circle
                  cx={hex.cx}
                  cy={hex.cy + 6}
                  r={17}
                  fill="#f5e8cc"
                  stroke="#8b7040"
                  strokeWidth={1.5}
                />
                <text
                  x={hex.cx}
                  y={hex.cy + 12}
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight="bold"
                  fill={hex.number === 6 || hex.number === 8 ? '#c0392b' : '#2c2010'}
                  fontFamily="Georgia, serif"
                  style={{ pointerEvents: 'none' }}
                >
                  {hex.number}
                </text>
                {/* Probability dots */}
                {[6, 8, 5, 9].includes(hex.number) && (
                  <g>
                    {Array.from({ length: Math.min(5, Math.abs(hex.number - 7) <= 1 ? 5 : 4) }).map((_, i, arr) => (
                      <circle
                        key={i}
                        cx={hex.cx - (arr.length - 1) * 3 + i * 6}
                        cy={hex.cy + 22}
                        r={2}
                        fill={hex.number === 6 || hex.number === 8 ? '#c0392b' : '#6b5030'}
                      />
                    ))}
                  </g>
                )}
              </g>
            )}
          </g>
        );
      })}

      {/* ── Roads (existing) ── */}
      {edges.map((edge) => {
        if (edge.road === null) return null;
        const v1 = vertices[edge.v1];
        const v2 = vertices[edge.v2];
        const color = players[edge.road]?.color || '#aaa';
        return (
          <line
            key={edge.id}
            x1={v1.x} y1={v1.y}
            x2={v2.x} y2={v2.y}
            stroke={color}
            strokeWidth={6}
            strokeLinecap="round"
          />
        );
      })}

      {/* ── Valid road spots (pulsing) ── */}
      {validRoads.map((eId) => {
        const edge = edges[eId];
        const v1 = vertices[edge.v1];
        const v2 = vertices[edge.v2];
        const mx = (v1.x + v2.x) / 2;
        const my = (v1.y + v2.y) / 2;
        return (
          <g key={`road-target-${eId}`} style={{ cursor: 'pointer' }} onClick={() => onEdgeClick(eId)}>
            <line
              x1={v1.x} y1={v1.y}
              x2={v2.x} y2={v2.y}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={10}
              strokeLinecap="round"
            />
            <circle cx={mx} cy={my} r={7} fill="rgba(255,255,255,0.7)" />
            <circle cx={mx} cy={my} r={5} fill="#ffffff">
              <animate attributeName="r" values="5;7;5" dur="1.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0.4;0.9" dur="1.2s" repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}

      {/* ── Buildings (existing) ── */}
      {vertices.map((vertex) => {
        if (!vertex.building) return null;
        const { x, y } = vertex;
        const color = players[vertex.owner]?.color || '#fff';
        if (vertex.building === 'settlement') {
          return (
            <g key={`building-${vertex.id}`}>
              {/* House body */}
              <rect x={x - 8} y={y - 7} width={16} height={13} fill={color} stroke="#fff" strokeWidth={1.5} rx={1} />
              {/* Roof */}
              <polygon
                points={`${x},${y - 17} ${x - 10},${y - 7} ${x + 10},${y - 7}`}
                fill={color}
                stroke="#fff"
                strokeWidth={1.5}
              />
            </g>
          );
        }
        if (vertex.building === 'city') {
          return (
            <g key={`building-${vertex.id}`}>
              {/* Main block */}
              <rect x={x - 11} y={y - 10} width={22} height={18} fill={color} stroke="#fff" strokeWidth={2} rx={1} />
              {/* Tower */}
              <rect x={x - 5} y={y - 20} width={10} height={12} fill={color} stroke="#fff" strokeWidth={1.5} rx={1} />
              {/* Crown top */}
              <rect x={x - 7} y={y - 22} width={4} height={4} fill={color} stroke="#fff" strokeWidth={1} />
              <rect x={x} y={y - 22} width={4} height={4} fill={color} stroke="#fff" strokeWidth={1} />
              <rect x={x + 3} y={y - 22} width={4} height={4} fill={color} stroke="#fff" strokeWidth={1} />
            </g>
          );
        }
        return null;
      })}

      {/* ── Valid settlement spots ── */}
      {validSettlements.map((vId) => {
        const { x, y } = vertices[vId];
        return (
          <g key={`settle-target-${vId}`} style={{ cursor: 'pointer' }} onClick={() => onVertexClick(vId)}>
            <circle cx={x} cy={y} r={14} fill="rgba(255,255,255,0.15)" stroke="#ffffff" strokeWidth={2} strokeDasharray="4,3" />
            <circle cx={x} cy={y} r={5} fill="rgba(255,255,255,0.8)">
              <animate attributeName="r" values="5;8;5" dur="1.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="1.2s" repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}

      {/* ── Valid city upgrade spots ── */}
      {validCities.map((vId) => {
        const { x, y } = vertices[vId];
        return (
          <g key={`city-target-${vId}`} style={{ cursor: 'pointer' }} onClick={() => onVertexClick(vId)}>
            <circle cx={x} cy={y} r={16} fill="none" stroke="#ffd700" strokeWidth={2.5} strokeDasharray="5,3" />
            <circle cx={x} cy={y} r={6} fill="#ffd700" opacity={0.7}>
              <animate attributeName="r" values="6;9;6" dur="1s" repeatCount="indefinite" />
            </circle>
          </g>
        );
      })}
    </svg>
  );
}
