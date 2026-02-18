import { useNavigate } from 'react-router-dom'
import { useAuth } from '../verus/AuthContext.jsx'

const GAMES = [
  {
    id: 'lemonade',
    title: 'Lemonade Stand',
    icon: '🍋',
    path: '/lemonade',
    color: '#d4a017',
    description: 'Run a lemonade stand for 14 days. Buy supplies, set prices, manage the weather. Classic economic sim.',
    tags: ['Economy', '14 Days', 'Easy'],
    status: 'BETA',
  },
];

const S = {
  bg: '#060a10', card: 'rgba(12,20,33,0.8)', border: '#1a2a3e',
  acc: '#f59e0b', grn: '#22c55e', red: '#ef4444', indigo: '#6366f1',
  text: '#c8d6e5', dim: '#5a6a7e', bright: '#e8f0fc',
  font: "'Courier New', monospace",
};

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

function EntryCard({ icon, iconBg, iconBorder, accentColor, title, badge, description, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: S.card, border: `1px solid ${S.border}`, borderRadius: 10,
        padding: '20px 24px', cursor: 'pointer', transition: 'all 0.2s',
        display: 'flex', alignItems: 'center', gap: 20,
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = accentColor; e.currentTarget.style.transform = 'translateY(-2px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = S.border; e.currentTarget.style.transform = 'none'; }}
    >
      <div style={{
        width: 52, height: 52, borderRadius: 10,
        background: iconBg, border: `1px solid ${iconBorder}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 24, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 15, fontWeight: 800, color: S.bright,
            fontFamily: S.font, letterSpacing: 1,
          }}>
            {title}
          </span>
          {badge && (
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: S.font, letterSpacing: 1,
              color: accentColor, background: `${accentColor}15`,
              border: `1px solid ${accentColor}30`, borderRadius: 3,
              padding: '2px 6px',
            }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.5, marginTop: 4 }}>
          {description}
        </div>
      </div>
      <div style={{ color: accentColor, fontSize: 18 }}>→</div>
    </div>
  );
}

function GameCard({ game, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: S.card, border: `1px solid ${S.border}`, borderRadius: 12,
        padding: '24px 28px', cursor: 'pointer', transition: 'all 0.2s',
        position: 'relative', overflow: 'hidden',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = game.color;
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = `0 8px 30px ${game.color}15`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = S.border;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 44, lineHeight: 1, filter: `drop-shadow(0 0 8px ${game.color}40)` }}>
          {game.icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h2 style={{
              fontSize: 22, fontWeight: 800, color: S.bright,
              fontFamily: S.font, letterSpacing: 1, margin: 0,
            }}>
              {game.title}
            </h2>
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: S.font, letterSpacing: 2,
              color: game.color, background: `${game.color}15`,
              border: `1px solid ${game.color}30`, borderRadius: 3, padding: '2px 8px',
            }}>
              {game.status}
            </span>
          </div>
          <p style={{ fontSize: 13, color: '#7a8a9e', lineHeight: 1.6, marginBottom: 10, marginTop: 0 }}>
            {game.description}
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            {game.tags.map(tag => (
              <span key={tag} style={{
                fontSize: 10, fontFamily: S.font, color: S.dim,
                background: 'rgba(255,255,255,0.04)', border: `1px solid ${S.border}`,
                borderRadius: 3, padding: '3px 8px', fontWeight: 600,
              }}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 20, color: '#2a3a4e', alignSelf: 'center' }}>→</div>
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div style={{ minHeight: '100vh', background: S.bg, position: 'relative', overflow: 'hidden' }}>
      <StarField />

      <div style={{ maxWidth: 700, margin: '0 auto', padding: '40px 20px', position: 'relative', zIndex: 1 }}>

        {/* User Bar (top-right) */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          marginBottom: 12, gap: 12, animation: 'fadeIn 0.4s ease',
        }}>
          {user ? (
            <>
              <div
                onClick={() => navigate('/profile')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
                  borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: S.grn }} />
                <span style={{ fontFamily: S.font, fontSize: 12, color: S.grn, fontWeight: 700 }}>
                  {user.fullname || user.identity + '@'}
                </span>
              </div>
              <span
                onClick={logout}
                style={{ fontSize: 11, color: S.dim, cursor: 'pointer', fontFamily: S.font }}
              >
                Logout
              </span>
            </>
          ) : (
            <span
              onClick={() => navigate('/login')}
              style={{
                fontFamily: S.font, fontSize: 12, color: S.acc,
                cursor: 'pointer', fontWeight: 700, letterSpacing: 1,
                padding: '6px 16px', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 6, background: 'rgba(245,158,11,0.06)',
              }}
            >
              Log In
            </span>
          )}
        </div>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 40, animation: 'fadeIn 0.6s ease' }}>
          <div style={{
            fontSize: 12, letterSpacing: 6, color: S.acc,
            fontFamily: S.font, fontWeight: 700, marginBottom: 12, textTransform: 'uppercase',
          }}>
            ⛓ Powered by Verus Blockchain
          </div>
          <h1 style={{
            fontSize: 52, fontWeight: 900, color: S.bright,
            fontFamily: "'Courier New', 'Lucida Console', monospace",
            letterSpacing: 6, margin: '0 0 8px',
            textShadow: '0 0 40px rgba(245,158,11,0.15)',
          }}>
            VERUS ARCADE
          </h1>
          <p style={{ fontSize: 14, color: S.dim, maxWidth: 460, margin: '0 auto', lineHeight: 1.7 }}>
            Blockchain games with proof-of-gameplay.
            Your identity is your account, your save file, and your proof.
          </p>
        </div>

        {/* ═══════════ NOT LOGGED IN: Three Entry Paths ═══════════ */}
        {!user && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32,
            animation: 'fadeIn 0.5s ease', animationDelay: '0.15s', animationFillMode: 'both',
          }}>
            <div style={{
              fontSize: 9, fontFamily: S.font, letterSpacing: 3, color: S.dim,
              fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, paddingLeft: 4,
            }}>
              Get Started
            </div>

            <EntryCard
              icon="🆔" accentColor={S.grn}
              iconBg="rgba(34,197,94,0.1)" iconBorder="rgba(34,197,94,0.2)"
              title="I have a VerusID"
              description="Sign in with Verus Mobile — scan a QR code to prove your identity. Works with any VerusID."
              onClick={() => navigate('/login?mode=qr')}
            />

            <EntryCard
              icon="📱" accentColor={S.acc}
              iconBg="rgba(245,158,11,0.1)" iconBorder="rgba(245,158,11,0.2)"
              title="Get a VerusID"
              description="Create your own on-chain identity with Verus Mobile. Own your data, own your progress — forever."
              onClick={() => navigate('/register?mode=ownid')}
            />

            <EntryCard
              icon="⚡" accentColor={S.indigo}
              iconBg="rgba(99,102,241,0.1)" iconBorder="rgba(99,102,241,0.2)"
              title="Just try it" badge="NO APP NEEDED"
              description="Pick a gamertag and start playing instantly. 10 free saves — upgrade to a VerusID anytime."
              onClick={() => navigate('/register')}
            />
          </div>
        )}

        {/* ═══════════ GAME CARDS (always visible) ═══════════ */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32,
          animation: 'fadeIn 0.5s ease', animationDelay: user ? '0.15s' : '0.35s', animationFillMode: 'both',
        }}>
          <div style={{
            fontSize: 9, fontFamily: S.font, letterSpacing: 3, color: S.dim,
            fontWeight: 700, textTransform: 'uppercase', paddingLeft: 4,
          }}>
            {user ? 'Your Games' : 'Available Games'}
          </div>

          {GAMES.map(game => (
            <GameCard key={game.id} game={game} onClick={() => navigate(game.path)} />
          ))}

          {/* Quick links */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <div onClick={() => navigate('/leaderboard')} style={{
              background: 'rgba(12,20,33,0.6)', border: `1px solid ${S.border}`,
              borderRadius: 8, padding: '14px 16px', cursor: 'pointer',
              transition: 'border-color 0.2s',
            }} onMouseEnter={e => e.currentTarget.style.borderColor = '#f5a623'}
               onMouseLeave={e => e.currentTarget.style.borderColor = S.border}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>🏆</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f5a623', fontFamily: S.font }}>Leaderboard</div>
              <div style={{ fontSize: 10, color: S.dim }}>Top players ranked by average score</div>
            </div>
            <div onClick={() => navigate('/achievements')} style={{
              background: 'rgba(12,20,33,0.6)', border: `1px solid ${S.border}`,
              borderRadius: 8, padding: '14px 16px', cursor: 'pointer',
              transition: 'border-color 0.2s',
            }} onMouseEnter={e => e.currentTarget.style.borderColor = '#00cccc'}
               onMouseLeave={e => e.currentTarget.style.borderColor = S.border}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>⭐</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#00cccc', fontFamily: S.font }}>Achievements</div>
              <div style={{ fontSize: 10, color: S.dim }}>40 challenges, 1000 points per game</div>
            </div>
          </div>
        </div>

        {/* How it Works */}
        <div style={{
          background: 'rgba(12,20,33,0.6)', border: `1px solid ${S.border}`,
          borderRadius: 8, padding: '20px 24px', marginBottom: 24,
          animation: 'fadeIn 0.5s ease', animationDelay: user ? '0.3s' : '0.5s', animationFillMode: 'both',
        }}>
          <h3 style={{
            fontSize: 11, fontFamily: S.font, letterSpacing: 3, color: S.acc,
            fontWeight: 700, marginBottom: 12, marginTop: 0, textTransform: 'uppercase',
          }}>
            How it works
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            {[
              { icon: '🆔', t: 'VerusID = You', d: 'Your identity is your account. No passwords, no email. Self-sovereign.' },
              { icon: '🎲', t: 'Deterministic', d: 'Same ID = same world. Every game is seeded by your identity.' },
              { icon: '⛓', t: 'Proof-of-Play', d: 'Actions are hash-chained. Scores are mathematically verifiable.' },
            ].map(x => (
              <div key={x.t} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>{x.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: S.text, marginBottom: 4, fontFamily: S.font }}>{x.t}</div>
                <div style={{ fontSize: 11, color: S.dim, lineHeight: 1.5 }}>{x.d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontFamily: S.font, fontSize: 10, color: '#1a2a3e', letterSpacing: 2 }}>
            TESTNET BETA · VERUS ARCADE@
          </div>
        </div>
      </div>

      <style>{`
        @keyframes twinkle {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
