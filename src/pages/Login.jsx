import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../verus/AuthContext.jsx';
import { custodialLogin, tier2LoginChallenge, tier2LoginVerify } from '../verus/api.js';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [mode, setMode] = useState('pin'); // 'pin' or 'wallet'
  const [gamertag, setGamertag] = useState('');
  const [pin, setPin] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const S = {
    bg: '#060a10', card: 'rgba(12,20,33,0.85)', border: '#1a2a3e',
    acc: '#f59e0b', grn: '#22c55e', red: '#ef4444',
    text: '#c8d6e5', dim: '#5a6a7e', bright: '#e8f0fc',
    font: "'Courier New', monospace",
  };

  const cd = { background: S.card, border: `1px solid ${S.border}`, borderRadius: 8, padding: '20px 24px', marginBottom: 12 };
  const inp = {
    width: '100%', padding: '12px 14px', border: `1px solid ${S.border}`, borderRadius: 6,
    fontFamily: S.font, fontSize: 14, color: S.acc, background: 'rgba(0,0,0,0.4)',
    outline: 'none', boxSizing: 'border-box',
  };
  const lb = { fontSize: 10, textTransform: 'uppercase', letterSpacing: 2, color: S.dim, fontFamily: S.font, fontWeight: 700, marginBottom: 6 };
  const bn = (active, dis) => ({
    padding: '12px 20px', border: active ? 'none' : `1px solid ${S.border}`, borderRadius: 6,
    background: dis ? '#1a2030' : active ? `linear-gradient(135deg, ${S.acc}, #d97706)` : 'rgba(20,30,48,0.8)',
    color: dis ? '#3a4a5a' : active ? '#000' : S.text,
    fontFamily: S.font, fontSize: 13, fontWeight: 700, cursor: dis ? 'default' : 'pointer',
    letterSpacing: 1, width: '100%', textTransform: 'uppercase',
  });
  const tabStyle = (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontFamily: S.font, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
    color: active ? S.acc : S.dim,
    borderBottom: active ? `2px solid ${S.acc}` : `1px solid ${S.border}`,
    transition: 'all 0.2s',
  });

  const doLogin = (result) => {
    login({
      identity: result.identity,
      address: result.identityaddress,
      fullname: result.fullyqualifiedname,
      custodial: result.custodial,
      tier: result.tier,
      freeSavesLeft: result.freeSavesLeft,
    });
    navigate('/');
  };

  // ── Tier 3: Pin login ──
  const handlePinLogin = async () => {
    setError(''); setLoading(true);
    try {
      const result = await custodialLogin(gamertag.trim(), pin);
      if (result.verified) doLogin(result);
      else setError(result.error || 'Login failed.');
    } catch { setError('Could not connect to server.'); }
    setLoading(false);
  };

  // ── Tier 2: Request challenge ──
  const handleRequestChallenge = async () => {
    setError(''); setLoading(true);
    try {
      const result = await tier2LoginChallenge(gamertag.trim());
      if (result.error) { setError(result.error); }
      else { setChallenge(result); }
    } catch { setError('Could not connect to server.'); }
    setLoading(false);
  };

  // ── Tier 2: Verify signature ──
  const handleVerifySignature = async () => {
    setError(''); setLoading(true);
    try {
      const result = await tier2LoginVerify(gamertag.trim(), signature);
      if (result.verified) doLogin(result);
      else setError(result.error || 'Verification failed.');
    } catch { setError('Could not connect to server.'); }
    setLoading(false);
  };

  const canPinLogin = gamertag.trim().length > 0 && pin.length >= 4;
  const canRequestChallenge = gamertag.trim().length > 0;
  const canVerify = signature.trim().length > 10;

  return (
    <div style={{ minHeight: '100vh', background: S.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ maxWidth: 480, width: '100%' }}>

        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🎮</div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: S.bright, fontFamily: S.font, letterSpacing: 3, margin: '0 0 6px' }}>
            WELCOME BACK
          </h1>
          <p style={{ fontSize: 12, color: S.dim, fontFamily: S.font }}>Log in to continue playing</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', marginBottom: 16 }}>
          <div style={tabStyle(mode === 'pin')} onClick={() => { setMode('pin'); setError(''); setChallenge(null); }}>
            Gamertag + Pin
          </div>
          <div style={tabStyle(mode === 'wallet')} onClick={() => { setMode('wallet'); setError(''); setChallenge(null); }}>
            Sign with Wallet
          </div>
        </div>

        {/* ── Pin Login (Tier 3) ── */}
        {mode === 'pin' && (
          <div style={cd}>
            <div style={lb}>Your Gamertag</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <input
                type="text" value={gamertag}
                onChange={e => { setGamertag(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && canPinLogin && handlePinLogin()}
                placeholder="yourname" style={{ ...inp, flex: 1 }}
              />
              <span style={{ fontSize: 11, color: S.dim, fontFamily: S.font, whiteSpace: 'nowrap' }}>.Verus Arcade@</span>
            </div>

            <div style={lb}>Pin Code</div>
            <input
              type="password" inputMode="numeric" value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && canPinLogin && handlePinLogin()}
              placeholder="••••" maxLength={6}
              style={{ ...inp, fontSize: 20, letterSpacing: 8, textAlign: 'center', marginBottom: 16 }}
            />

            <button onClick={handlePinLogin} disabled={!canPinLogin || loading} style={bn(canPinLogin && !loading, !canPinLogin || loading)}>
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </div>
        )}

        {/* ── Wallet Login (Tier 2) ── */}
        {mode === 'wallet' && !challenge && (
          <div style={cd}>
            <div style={{
              fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6,
              marginBottom: 16, padding: '8px 12px',
              background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: `1px solid ${S.border}`,
            }}>
              For accounts registered with an R-address. We'll give you a message to sign with your wallet to prove ownership.
            </div>

            <div style={lb}>Your Gamertag</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <input
                type="text" value={gamertag}
                onChange={e => { setGamertag(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && canRequestChallenge && handleRequestChallenge()}
                placeholder="yourname" style={{ ...inp, flex: 1 }}
              />
              <span style={{ fontSize: 11, color: S.dim, fontFamily: S.font, whiteSpace: 'nowrap' }}>.Verus Arcade@</span>
            </div>

            <button onClick={handleRequestChallenge} disabled={!canRequestChallenge || loading} style={bn(canRequestChallenge && !loading, !canRequestChallenge || loading)}>
              {loading ? 'Loading...' : 'Get Challenge'}
            </button>
          </div>
        )}

        {/* ── Wallet Login Step 2: Sign & Verify ── */}
        {mode === 'wallet' && challenge && (
          <div style={cd}>
            <div style={{ fontSize: 11, color: S.grn, fontFamily: S.font, fontWeight: 700, marginBottom: 12 }}>
              ✓ Challenge received
            </div>

            <div style={lb}>Sign this message with your wallet</div>
            <div style={{
              background: 'rgba(0,0,0,0.4)', borderRadius: 6, padding: '10px 14px',
              fontFamily: S.font, fontSize: 11, color: S.acc,
              wordBreak: 'break-all', lineHeight: 1.5, marginBottom: 12,
              border: `1px solid ${S.border}`,
              userSelect: 'all', cursor: 'text',
            }}>
              {challenge.message}
            </div>

            <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font, lineHeight: 1.6, marginBottom: 12 }}>
              In Verus Mobile or CLI, sign the message above with your R-address:
              <br />
              <span style={{ color: S.text }}>verus -chain=vrsctest signmessage "{challenge.raddress}" "{challenge.message}"</span>
            </div>

            <div style={lb}>Paste your signature</div>
            <textarea
              value={signature}
              onChange={e => { setSignature(e.target.value); setError(''); }}
              placeholder="Paste the signature here..."
              rows={3}
              style={{
                ...inp, fontSize: 12, resize: 'vertical', marginBottom: 16,
                minHeight: 60,
              }}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setChallenge(null); setSignature(''); setError(''); }}
                style={{ ...bn(false, false), flex: '0 0 auto', width: 'auto', padding: '12px 16px', fontSize: 11, color: S.dim, borderColor: S.border }}
              >
                ← Back
              </button>
              <button onClick={handleVerifySignature} disabled={!canVerify || loading} style={{ ...bn(canVerify && !loading, !canVerify || loading), flex: 1 }}>
                {loading ? 'Verifying...' : 'Verify & Log In'}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: `1px solid ${S.red}`,
            borderRadius: 6, padding: '10px 14px', marginTop: 8,
            fontSize: 12, color: S.red, fontFamily: S.font,
          }}>
            {error}
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <span onClick={() => navigate('/register')} style={{ fontSize: 12, color: S.acc, cursor: 'pointer', fontFamily: S.font, fontWeight: 700 }}>
            New player? Create a free account →
          </span>
          <span onClick={() => navigate('/')} style={{ fontSize: 12, color: S.dim, cursor: 'pointer', fontFamily: S.font }}>
            ← Back to Arcade
          </span>
        </div>
      </div>
    </div>
  );
}
