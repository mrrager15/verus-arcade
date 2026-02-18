import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../verus/AuthContext.jsx";
import { getLeaderboard } from "../verus/api.js";

const PERIODS = [
  { key: "allTime", label: "All Time" },
  { key: "weekly", label: "This Week" },
  { key: "daily", label: "Today" },
];

const GAMES = [
  { key: "lemonade", label: "Lemonade Stand", icon: "🍋" },
];

export default function Leaderboard() {
  const [game, setGame] = useState("lemonade");
  const [period, setPeriod] = useState("allTime");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    setLoading(true);
    getLeaderboard(game, period)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [game, period]);

  const bg = "#0a0e14";
  const card = "#111820";
  const border = "#1a2a3a";
  const cyan = "#00cccc";
  const gold = "#f5a623";
  const silver = "#c0c0c0";
  const bronze = "#cd7f32";
  const text = "#c8d6e5";
  const textDim = "#5a6a7e";
  const mono = "'Courier New', monospace";

  return (
    <div style={{
      minHeight: "100vh", background: bg, color: text,
      fontFamily: "'Georgia', serif", padding: "20px 16px",
    }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div>
            <div style={{
              fontSize: 10, textTransform: "uppercase", letterSpacing: 3,
              color: cyan, fontFamily: mono, fontWeight: 700, marginBottom: 4,
            }}>
              Verus Arcade
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#fff", margin: 0 }}>Leaderboard</h1>
          </div>
          <button onClick={() => navigate("/")} style={{
            padding: "8px 16px", border: `1px solid ${border}`, borderRadius: 6,
            background: "transparent", color: textDim, fontFamily: mono, fontSize: 11,
            cursor: "pointer",
          }}>← Back</button>
        </div>

        {/* Game selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {GAMES.map(g => (
            <button key={g.key} onClick={() => setGame(g.key)} style={{
              padding: "8px 16px", border: `1px solid ${game === g.key ? cyan : border}`,
              borderRadius: 6, background: game === g.key ? "rgba(0,204,204,0.08)" : card,
              color: game === g.key ? cyan : textDim, fontFamily: mono, fontSize: 12,
              cursor: "pointer", fontWeight: 700,
            }}>{g.icon} {g.label}</button>
          ))}
        </div>

        {/* Period selector */}
        <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={{
              padding: "6px 14px", border: "none", borderRadius: 4,
              background: period === p.key ? cyan : "rgba(255,255,255,0.05)",
              color: period === p.key ? bg : textDim,
              fontFamily: mono, fontSize: 11, cursor: "pointer", fontWeight: 700,
            }}>{p.label}</button>
          ))}
        </div>

        {/* Minimum games notice */}
        <div style={{
          fontSize: 11, color: textDim, fontFamily: mono, marginBottom: 16,
          padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 4,
          border: `1px solid ${border}`,
        }}>
          Minimum 5 games played to qualify. Ranked by average score.
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: 40, color: textDim, fontFamily: mono }}>
            Loading leaderboard...
          </div>
        )}

        {/* Empty state */}
        {!loading && (!data?.entries || data.entries.length === 0) && (
          <div style={{
            textAlign: "center", padding: 40, color: textDim,
            background: card, borderRadius: 8, border: `1px solid ${border}`,
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🏆</div>
            <div style={{ fontFamily: mono, fontSize: 13 }}>No entries yet for this period.</div>
            <div style={{ fontFamily: mono, fontSize: 11, marginTop: 8, color: "#3a4a5a" }}>
              Play at least 5 games to appear on the leaderboard.
            </div>
          </div>
        )}

        {/* Leaderboard entries */}
        {!loading && data?.entries?.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.entries.map((entry, i) => {
              const rank = i + 1;
              const medalColor = rank === 1 ? gold : rank === 2 ? silver : rank === 3 ? bronze : null;
              const isCurrentUser = user && (
                entry.player === user.identity ||
                entry.fullName === (user.fullname || user.identity + "@")
              );

              return (
                <div key={entry.player} style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 100px 80px",
                  alignItems: "center", padding: "12px 14px",
                  background: isCurrentUser ? "rgba(0,204,204,0.06)" : card,
                  border: `1px solid ${isCurrentUser ? cyan : border}`,
                  borderRadius: 6, gap: 12,
                }}>
                  {/* Rank */}
                  <div style={{
                    fontSize: rank <= 3 ? 20 : 14, fontWeight: 900, fontFamily: mono,
                    color: medalColor || textDim, textAlign: "center",
                  }}>
                    {rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `#${rank}`}
                  </div>

                  {/* Player name */}
                  <div>
                    <div style={{
                      fontSize: 13, fontWeight: 700, fontFamily: mono,
                      color: isCurrentUser ? cyan : "#fff",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {entry.fullName || entry.player}
                    </div>
                    <div style={{ fontSize: 10, color: textDim, fontFamily: mono }}>
                      {entry.gamesPlayed} games played
                    </div>
                  </div>

                  {/* Average score */}
                  <div style={{ textAlign: "right" }}>
                    <div style={{
                      fontSize: 16, fontWeight: 900, fontFamily: mono,
                      color: medalColor || gold,
                    }}>
                      {entry.avgScore}
                    </div>
                    <div style={{ fontSize: 9, color: textDim, fontFamily: mono, textTransform: "uppercase" }}>
                      avg score
                    </div>
                  </div>

                  {/* Highscore */}
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFamily: mono, color: text }}>
                      {entry.highscore}
                    </div>
                    <div style={{ fontSize: 9, color: textDim, fontFamily: mono, textTransform: "uppercase" }}>
                      best
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
