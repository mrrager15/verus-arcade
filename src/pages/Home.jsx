import { useNavigate } from 'react-router-dom'
import { useAuth } from '../verus/AuthContext.jsx'

const GAMES = [
  {
    id: 'lemonade',
    title: 'Lemonade Stand',
    icon: '🍋',
    path: '/lemonade',
    color: '#d4a017',
    colorDim: '#92600a',
    bg: 'linear-gradient(135deg, #fdf6e3 0%, #f5e6b8 100%)',
    description: 'Run a lemonade stand for 14 days. Buy supplies, set prices, manage the weather. Classic economic sim.',
    tags: ['Economy', '14 Days', 'Easy'],
    status: 'BETA',
  },
  {
    id: 'colony',
    title: 'Colony One',
    icon: '🪐',
    path: '/colony',
    color: '#f59e0b',
    colorDim: '#b45309',
    bg: 'linear-gradient(135deg, #0c1420 0%, #1a2a3e 100%)',
    description: 'Land on a procedurally generated planet. Build structures, manage resources, survive 30 sols.',
    tags: ['Survival', '30 Sols', 'Medium'],
    status: 'BETA',
  },
];

function StarField() {
  const stars = Array.from({ length: 80 }, (_, i) => {
    const h = (i * 2654435761) >>> 0;
    return {
      x: (h % 1000) / 10,
      y: ((h >> 10) % 1000) / 10,
      s: 0.5 + ((h >> 20) % 100) / 100 * 1.5,
      d: 2 + ((h >> 8) % 100) / 100 * 5,
    };
  });
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
      {stars.map((s, i) => (
        <div key={i} style={{
          position: 'absolute', left: `${s.x}%`, top: `${s.y}%`,
          width: s.s, height: s.s, borderRadius: '50%', background: '#fff',
          animation: `twinkle ${s.d}s ease-in-out infinite`,
          animationDelay: `${s.d * 0.2}s`,
        }} />
      ))}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div style={{
      minHeight: '100vh',
      background: '#060a10',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <StarField />

      <div style={{
        maxWidth: 700,
        margin: '0 auto',
        padding: '40px 20px',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* User Bar */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          marginBottom: 12, gap: 12,
          animation: 'fadeIn 0.4s ease',
        }}>
          {user ? (
            <>
              <div
                onClick={() => navigate('/profile')}
                style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
                borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
              }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
                <span
                style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: '#22c55e', fontWeight: 700 }}
              >
                {user.fullname || user.identity + '@'}
              </span>
              </div>
              <span
                onClick={logout}
                style={{ fontSize: 11, color: '#5a6a7e', cursor: 'pointer', fontFamily: "'Courier New', monospace" }}
              >
                Logout
              </span>
            </>
          ) : (
            <span
              onClick={() => navigate('/login')}
              style={{
                fontFamily: "'Courier New', monospace", fontSize: 12, color: '#f59e0b',
                cursor: 'pointer', fontWeight: 700, letterSpacing: 1,
                padding: '6px 16px', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 6, background: 'rgba(245,158,11,0.06)',
              }}
            >
              🆔 LOGIN WITH VERUSID
            </span>
          )}
        </div>

        {/* Header */}
        <div style={{
          textAlign: 'center',
          marginBottom: 48,
          animation: 'fadeIn 0.6s ease',
        }}>
          <div style={{
            fontSize: 14,
            letterSpacing: 6,
            color: '#f59e0b',
            fontFamily: "'Courier New', monospace",
            fontWeight: 700,
            marginBottom: 12,
            textTransform: 'uppercase',
          }}>
            ⛓ Powered by Verus Blockchain
          </div>

          <h1 style={{
            fontSize: 52,
            fontWeight: 900,
            color: '#e8f0fc',
            fontFamily: "'Courier New', 'Lucida Console', monospace",
            letterSpacing: 6,
            margin: '0 0 8px',
            textShadow: '0 0 40px rgba(245,158,11,0.15)',
          }}>
            VERUS ARCADE
          </h1>

          <p style={{
            fontSize: 15,
            color: '#5a6a7e',
            maxWidth: 480,
            margin: '0 auto',
            lineHeight: 1.7,
          }}>
            Serverless blockchain games with proof-of-gameplay.
            Your VerusID is your account, your save file, and your proof.
          </p>
        </div>

        {/* Game Cards */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          marginBottom: 40,
        }}>
          {GAMES.map((game, idx) => (
            <div
              key={game.id}
              onClick={() => navigate(game.path)}
              style={{
                background: 'rgba(12, 20, 33, 0.8)',
                border: '1px solid #1a2a3e',
                borderRadius: 12,
                padding: '24px 28px',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                animation: 'fadeIn 0.5s ease',
                animationDelay: `${0.2 + idx * 0.15}s`,
                animationFillMode: 'both',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = game.color;
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = `0 8px 30px ${game.color}15`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#1a2a3e';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                <div style={{
                  fontSize: 44,
                  lineHeight: 1,
                  filter: `drop-shadow(0 0 8px ${game.color}40)`,
                }}>
                  {game.icon}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <h2 style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: '#e8f0fc',
                      fontFamily: "'Courier New', monospace",
                      letterSpacing: 1,
                    }}>
                      {game.title}
                    </h2>
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: "'Courier New', monospace",
                      letterSpacing: 2,
                      color: game.color,
                      background: `${game.color}15`,
                      border: `1px solid ${game.color}30`,
                      borderRadius: 3,
                      padding: '2px 8px',
                    }}>
                      {game.status}
                    </span>
                  </div>

                  <p style={{
                    fontSize: 13,
                    color: '#7a8a9e',
                    lineHeight: 1.6,
                    marginBottom: 10,
                  }}>
                    {game.description}
                  </p>

                  <div style={{ display: 'flex', gap: 6 }}>
                    {game.tags.map(tag => (
                      <span key={tag} style={{
                        fontSize: 10,
                        fontFamily: "'Courier New', monospace",
                        color: '#5a6a7e',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid #1a2a3e',
                        borderRadius: 3,
                        padding: '3px 8px',
                        fontWeight: 600,
                      }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{
                  fontSize: 20,
                  color: '#2a3a4e',
                  alignSelf: 'center',
                }}>
                  →
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Info Section */}
        <div style={{
          background: 'rgba(12, 20, 33, 0.6)',
          border: '1px solid #1a2a3e',
          borderRadius: 8,
          padding: '20px 24px',
          marginBottom: 24,
          animation: 'fadeIn 0.5s ease',
          animationDelay: '0.5s',
          animationFillMode: 'both',
        }}>
          <h3 style={{
            fontSize: 11,
            fontFamily: "'Courier New', monospace",
            letterSpacing: 3,
            color: '#f59e0b',
            fontWeight: 700,
            marginBottom: 12,
            textTransform: 'uppercase',
          }}>
            How it works
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 16,
          }}>
            {[
              { icon: '🆔', title: 'VerusID = You', desc: 'Your identity is your account. No passwords, no email. Self-sovereign.' },
              { icon: '🎲', title: 'Deterministic', desc: 'Same ID = same world. Every game is seeded by your identity.' },
              { icon: '⛓', title: 'Proof-of-Play', desc: 'Actions are hash-chained. Scores are mathematically verifiable.' },
            ].map(item => (
              <div key={item.title} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>{item.icon}</div>
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#c8d6e5',
                  marginBottom: 4,
                  fontFamily: "'Courier New', monospace",
                }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 11, color: '#5a6a7e', lineHeight: 1.5 }}>
                  {item.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          textAlign: 'center',
          padding: '16px 0',
          animation: 'fadeIn 0.5s ease',
          animationDelay: '0.6s',
          animationFillMode: 'both',
        }}>
          <div style={{
            fontFamily: "'Courier New', monospace",
            fontSize: 10,
            color: '#2a3a4e',
            letterSpacing: 2,
          }}>
            TESTNET BETA · VERUS ARCADE@
          </div>
        </div>
      </div>
    </div>
  );
}
