import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../verus/AuthContext.jsx";
import { getProfile } from "../verus/api.js";

const GAME_INFO = {
  lemonade: { title: "Lemonade Stand", icon: "🍋", color: "#d4a017" },
  colony: { title: "Colony One", icon: "🪐", color: "#f59e0b" },
};

const GRADE_COLOR = { S: "#d4a017", A: "#3a7d44", B: "#5a9bd5", C: "#5a4630", D: "#c97932", F: "#c0392b" };

function XPBar({ xp }) {
  // Simple level calc: level = floor(sqrt(xp / 50))
  const level = Math.floor(Math.sqrt(xp / 50));
  const xpForLevel = level * level * 50;
  const xpForNext = (level + 1) * (level + 1) * 50;
  const progress = xpForNext > xpForLevel ? (xp - xpForLevel) / (xpForNext - xpForLevel) : 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 28, fontWeight: 900, color: "#f59e0b", fontFamily: "'Courier New', monospace" }}>
          LVL {level}
        </div>
        <div style={{ fontSize: 11, color: "#5a6a7e", fontFamily: "'Courier New', monospace" }}>
          {xp} / {xpForNext} XP
        </div>
      </div>
      <div style={{ height: 8, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 4,
          background: "linear-gradient(90deg, #f59e0b, #d97706)",
          width: `${Math.min(100, progress * 100)}%`,
          transition: "width 0.5s ease",
        }} />
      </div>
    </div>
  );
}

export default function PlayerProfile() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    const name = user.fullname || user.identity + "@";
    getProfile(name)
      .then(data => {
        if (data.error) setError(data.error);
        else setProfile(data);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [user]);

  // Styles
  const S = {
    bg: "#060a10", card: "rgba(12,20,33,0.8)", border: "#1a2a3e",
    acc: "#f59e0b", grn: "#22c55e", red: "#ef4444",
    text: "#c8d6e5", dim: "#5a6a7e", bright: "#e8f0fc",
    font: "'Courier New', monospace",
  };
  const CD = {
    background: S.card, border: `1px solid ${S.border}`, borderRadius: 8,
    padding: "18px 22px", marginBottom: 14,
  };

  if (!user) {
    return (
      <div style={{ minHeight: "100vh", background: S.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🆔</div>
          <h2 style={{ fontSize: 20, color: S.bright, fontFamily: S.font, letterSpacing: 2, marginBottom: 12 }}>LOGIN REQUIRED</h2>
          <p style={{ fontSize: 13, color: S.dim, marginBottom: 20 }}>Log in with your VerusID to view your profile.</p>
          <button onClick={() => navigate("/login")} style={{
            padding: "12px 28px", border: "none", borderRadius: 6,
            background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
            color: "#000", fontFamily: S.font, fontSize: 13, fontWeight: 700,
            cursor: "pointer", letterSpacing: 1,
          }}>
            🆔 LOGIN
          </button>
          <div style={{ marginTop: 16 }}>
            <span onClick={() => navigate("/")} style={{ fontSize: 12, color: S.dim, cursor: "pointer", fontFamily: S.font }}>← Back to Arcade</span>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: S.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 14, color: S.acc, fontFamily: S.font, letterSpacing: 2 }}>Loading profile from chain...</div>
      </div>
    );
  }

  const games = profile?.games || {};
  const totals = profile?.totals || { totalXP: 0, totalGames: 0 };
  const gameList = Object.entries(GAME_INFO);

  return (
    <div style={{ minHeight: "100vh", background: S.bg }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span onClick={() => navigate("/")} style={{ fontSize: 12, color: S.dim, cursor: "pointer", fontFamily: S.font }}>← Arcade</span>
          <span style={{ fontSize: 10, color: S.dim, fontFamily: S.font, letterSpacing: 2, textTransform: "uppercase" }}>Player Profile</span>
        </div>

        {/* Identity Card */}
        <div style={{ ...CD, textAlign: "center", padding: "28px 22px" }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🎮</div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: S.bright, fontFamily: S.font, letterSpacing: 2, margin: "0 0 4px" }}>
            {profile?.identity?.name || user.identity}
          </h1>
          <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, marginBottom: 16 }}>
            {profile?.identity?.fullyqualifiedname || user.fullname || user.identity + "@"}
          </div>

          <XPBar xp={totals.totalXP} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 18 }}>
            {[
              { label: "Total XP", value: totals.totalXP, color: S.acc },
              { label: "Games Played", value: totals.totalGames, color: S.bright },
              { label: "Games Owned", value: Object.keys(games).length, color: S.grn },
            ].map(item => (
              <div key={item.label}>
                <div style={{ fontSize: 9, color: S.dim, fontFamily: S.font, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 900, color: item.color, fontFamily: S.font }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Game Stats */}
        <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font, letterSpacing: 3, textTransform: "uppercase", marginBottom: 8, paddingLeft: 4 }}>
          Game Stats
        </div>

        {gameList.map(([gameId, info]) => {
          const data = games[gameId];
          const stats = data?.stats;

          return (
            <div key={gameId} style={CD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <div style={{ fontSize: 32 }}>{info.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: S.bright, fontFamily: S.font, letterSpacing: 1 }}>
                    {info.title}
                  </div>
                  {stats ? (
                    <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, marginTop: 2 }}>
                      Last played: {new Date(stats.lastPlayed * 1000).toLocaleDateString()}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, fontStyle: "italic", marginTop: 2 }}>
                      Not yet played
                    </div>
                  )}
                </div>
                {stats && (
                  <div style={{
                    fontSize: 32, fontWeight: 900, fontFamily: S.font,
                    color: GRADE_COLOR[stats.bestGrade] || S.dim,
                    lineHeight: 1,
                  }}>
                    {stats.bestGrade}
                  </div>
                )}
              </div>

              {stats ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
                    {[
                      { label: "Highscore", value: stats.highscore, color: info.color },
                      { label: "Total XP", value: stats.totalPoints },
                      { label: "Played", value: stats.gamesPlayed },
                      { label: "Best", value: stats.bestGrade, color: GRADE_COLOR[stats.bestGrade] },
                    ].map(item => (
                      <div key={item.label}>
                        <div style={{ fontSize: 8, color: S.dim, fontFamily: S.font, letterSpacing: 2, textTransform: "uppercase", marginBottom: 3 }}>
                          {item.label}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: item.color || S.bright, fontFamily: S.font }}>
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  {data.hasProof && (
                    <div style={{
                      marginTop: 12, padding: "8px 12px", borderRadius: 4,
                      background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.15)",
                      display: "flex", alignItems: "center", gap: 8,
                    }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: S.grn }} />
                      <div style={{ fontSize: 10, color: S.grn, fontFamily: S.font }}>
                        Proof-of-gameplay verified · {data.proofActions} actions · head: {data.proofChainHead}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <button onClick={() => navigate(`/${gameId === "lemonade" ? "lemonade" : "colony"}`)} style={{
                  width: "100%", padding: "10px", border: `1px solid ${S.border}`, borderRadius: 6,
                  background: "rgba(20,30,48,0.6)", color: info.color, fontFamily: S.font,
                  fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: 1,
                }}>
                  ▶ PLAY NOW
                </button>
              )}
            </div>
          );
        })}

        {/* On-chain info */}
        <div style={{
          padding: "12px 16px", borderRadius: 6, marginTop: 8,
          background: "rgba(0,0,0,0.3)", border: "1px solid #0f1a2a",
          fontFamily: S.font, fontSize: 10, color: "#2a5a3a",
        }}>
          <div style={{ color: "#1a6a3a", marginBottom: 4 }}>// On-chain identity data</div>
          <div>address: <span style={{ color: "#5feba7" }}>{profile?.identity?.address}</span></div>
          <div>games: <span style={{ color: "#5feba7" }}>{Object.keys(games).join(", ") || "none"}</span></div>
          <div>total_xp: <span style={{ color: "#5feba7" }}>{totals.totalXP}</span></div>
          <div>total_games: <span style={{ color: "#5feba7" }}>{totals.totalGames}</span></div>
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <div style={{ fontSize: 10, color: "#1a2a3e", fontFamily: S.font, letterSpacing: 2 }}>
            TESTNET BETA · VERUS ARCADE@
          </div>
        </div>
      </div>
    </div>
  );
}
