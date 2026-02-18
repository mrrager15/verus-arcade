import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../verus/AuthContext.jsx";
import { getPlayerAchievements, getAchievementDefs } from "../verus/api.js";

const GAMES = [
  { key: "lemonade", label: "Lemonade Stand", icon: "🍋" },
];

export default function Achievements() {
  const [game, setGame] = useState("lemonade");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    setLoading(true);
    if (user) {
      const identity = user.fullname || user.identity + "@";
      getPlayerAchievements(game, identity)
        .then(d => { setData(d); setLoading(false); })
        .catch(() => setLoading(false));
    } else {
      getAchievementDefs(game)
        .then(d => { setData({ ...d, unlocked: 0, points: 0, achievements: d.achievements.map(a => ({ ...a, unlocked: false })) }); setLoading(false); })
        .catch(() => setLoading(false));
    }
  }, [game, user]);

  const bg = "#0a0e14";
  const card = "#111820";
  const border = "#1a2a3a";
  const cyan = "#00cccc";
  const gold = "#f5a623";
  const green = "#22c55e";
  const text = "#c8d6e5";
  const textDim = "#5a6a7e";
  const mono = "'Courier New', monospace";

  const pct = data ? Math.round((data.points / data.maxPoints) * 100) : 0;

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
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#fff", margin: 0 }}>Achievements</h1>
          </div>
          <button onClick={() => navigate("/")} style={{
            padding: "8px 16px", border: `1px solid ${border}`, borderRadius: 6,
            background: "transparent", color: textDim, fontFamily: mono, fontSize: 11,
            cursor: "pointer",
          }}>← Back</button>
        </div>

        {/* Game selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {GAMES.map(g => (
            <button key={g.key} onClick={() => setGame(g.key)} style={{
              padding: "8px 16px", border: `1px solid ${game === g.key ? cyan : border}`,
              borderRadius: 6, background: game === g.key ? "rgba(0,204,204,0.08)" : card,
              color: game === g.key ? cyan : textDim, fontFamily: mono, fontSize: 12,
              cursor: "pointer", fontWeight: 700,
            }}>{g.icon} {g.label}</button>
          ))}
        </div>

        {/* Progress bar */}
        {data && (
          <div style={{
            background: card, border: `1px solid ${border}`, borderRadius: 8,
            padding: "16px 18px", marginBottom: 20,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontFamily: mono, fontSize: 22, fontWeight: 900, color: gold }}>
                {data.points} <span style={{ fontSize: 12, color: textDim }}>/ {data.maxPoints}</span>
              </span>
              <span style={{ fontFamily: mono, fontSize: 12, color: textDim }}>
                {data.unlocked || 0} / {data.total} unlocked
              </span>
            </div>
            <div style={{
              height: 8, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden",
            }}>
              <div style={{
                height: "100%", width: `${pct}%`, borderRadius: 4,
                background: `linear-gradient(90deg, ${cyan}, ${gold})`,
                transition: "width 0.5s ease",
              }} />
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: 40, color: textDim, fontFamily: mono }}>
            Loading achievements...
          </div>
        )}

        {/* Achievement grid */}
        {!loading && data?.achievements && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.achievements.map(a => {
              const isUnlocked = a.unlocked;
              return (
                <div key={a.id} style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 60px",
                  alignItems: "center", padding: "12px 14px",
                  background: isUnlocked ? "rgba(0,204,204,0.04)" : card,
                  border: `1px solid ${isUnlocked ? "rgba(0,204,204,0.3)" : border}`,
                  borderRadius: 6, gap: 12,
                  opacity: isUnlocked ? 1 : 0.55,
                }}>
                  {/* Icon */}
                  <div style={{
                    fontSize: 22, textAlign: "center",
                    filter: isUnlocked ? "none" : "grayscale(100%)",
                  }}>
                    {a.icon}
                  </div>

                  {/* Name + description */}
                  <div>
                    <div style={{
                      fontSize: 13, fontWeight: 700, fontFamily: mono,
                      color: isUnlocked ? "#fff" : textDim,
                    }}>
                      {a.name || "???"}
                    </div>
                    <div style={{
                      fontSize: 11, color: isUnlocked ? text : "#3a4a5a",
                      fontFamily: mono, marginTop: 2,
                    }}>
                      {a.desc || "This is a secret achievement"}
                    </div>
                  </div>

                  {/* Points */}
                  <div style={{ textAlign: "right" }}>
                    <div style={{
                      fontSize: 16, fontWeight: 900, fontFamily: mono,
                      color: isUnlocked ? gold : "#2a3a4a",
                    }}>
                      {a.points}
                    </div>
                    <div style={{
                      fontSize: 8, textTransform: "uppercase", letterSpacing: 1,
                      color: isUnlocked ? textDim : "#2a3a4a", fontFamily: mono,
                    }}>
                      pts
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!user && !loading && (
          <div style={{
            textAlign: "center", padding: "16px", marginTop: 16,
            background: card, border: `1px solid ${border}`, borderRadius: 8,
            fontFamily: mono, fontSize: 12, color: textDim,
          }}>
            <span onClick={() => navigate("/login")} style={{ color: cyan, cursor: "pointer", textDecoration: "underline" }}>
              Log in
            </span> to track your achievement progress.
          </div>
        )}
      </div>
    </div>
  );
}
