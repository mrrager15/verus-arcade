import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../verus/AuthContext.jsx';
import { custodialLogin } from '../verus/api.js';
import QRCode from 'qrcode';

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : 'https://api.verusarcade.com/api';

export default function Login() {
  const navigate = useNavigate();
  const { user, login, loginDirect } = useAuth();
  const defaultMode = new URLSearchParams(window.location.search).get('mode') === 'qr' ? 'qr' : 'pin';
  const [mode, setMode] = useState(defaultMode);

  // ── Tier 3 (pin) state ──
  const [gamertag, setGamertag] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // ── Tier 2 (QR) state ──
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [qrStatus, setQrStatus] = useState('idle'); // idle | loading | ready | verified | no_account | error
  const [qrResult, setQrResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => { if (user) navigate('/'); }, [user]);

  // ── Tier 2: Poll for QR login status ──
  useEffect(() => {
    if (!challengeId || qrStatus === 'verified' || qrStatus === 'error' || qrStatus === 'no_account') return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/login/tier2/status/${challengeId}`);
        const data = await res.json();

        if (data.status === 'verified') {
          setQrStatus('verified');
          setQrResult(data);
          clearInterval(pollRef.current);

          // Auto-login
          setTimeout(() => {
            loginDirect({
              identity: data.gamertag,
              fullname: data.fullname,
              identityaddress: data.identity,
              custodial: false,
              tier: 2,
              freeSavesLeft: data.freeSavesLeft,
            });
            navigate('/');
          }, 1500);
        } else if (data.status === 'no_account') {
          setQrStatus('no_account');
          clearInterval(pollRef.current);
        } else if (data.status === 'expired') {
          setQrStatus('error');
          setError('QR code expired. Generate a new one.');
          clearInterval(pollRef.current);
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [challengeId, qrStatus]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Tier 2: Generate QR login deeplink ──
  const handleGenerateQR = async () => {
    setQrStatus('loading');
    setError('');
    setQrDataUrl(null);
    setChallengeId(null);

    try {
      const res = await fetch(`${API}/login/tier2/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || 'Failed to generate QR');
        setQrStatus('error');
        return;
      }

      const qrUrl = await QRCode.toDataURL(data.deeplink, {
        width: 280, margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });

      setQrDataUrl(qrUrl);
      setChallengeId(data.challenge_id);
      setQrStatus('ready');
    } catch (e) {
      setError(e.message || 'Failed to generate QR');
      setQrStatus('error');
    }
  };

  // ── Tier 3: Pin login ──
  const canSubmit = gamertag.trim().length > 0 && pin.length >= 4;

  const handleCustodialLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await custodialLogin(gamertag.trim(), pin);
      if (result.verified) {
        login({
          identity: result.identity,
          address: result.identityaddress,
          fullname: result.fullyqualifiedname,
          custodial: !result.claimed,
          claimed: result.claimed,
        });
        navigate('/');
      } else {
        setError(result.error || 'Login failed.');
      }
    } catch (e) {
      try {
        const errData = await e.json?.();
        setError(errData?.error || 'Could not connect to server.');
      } catch {
        setError('Could not connect to server. Try again later.');
      }
    }
    setLoading(false);
  };

  // ── Styles ──
  const S = {
    bg: '#060a10', card: 'rgba(12,20,33,0.85)', border: '#1a2a3e',
    acc: '#f59e0b', grn: '#22c55e', red: '#ef4444',
    text: '#c8d6e5', dim: '#5a6a7e', bright: '#e8f0fc',
    font: "'Courier New', monospace",
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontFamily: S.font, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
    color: active ? S.acc : S.dim,
    borderBottom: active ? `2px solid ${S.acc}` : `1px solid ${S.border}`,
    transition: 'all 0.2s',
  });

  const inp = {
    width: '100%', padding: '12px 14px', border: `1px solid ${S.border}`, borderRadius: 6,
    fontFamily: S.font, fontSize: 14, color: S.acc, background: 'rgba(0,0,0,0.4)',
    outline: 'none', boxSizing: 'border-box',
  };

  const LB = {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 2, color: S.dim,
    fontFamily: S.font, fontWeight: 700, marginBottom: 6, display: 'block',
  };

  return (
    <div style={{
      minHeight: '100vh', background: S.bg, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🎮</div>
          <h1 style={{
            fontSize: 24, fontWeight: 900, color: S.bright,
            fontFamily: S.font, letterSpacing: 3, margin: '0 0 6px',
          }}>
            WELCOME BACK
          </h1>
          <p style={{ fontSize: 12, color: S.dim, fontFamily: S.font }}>
            Log in to continue playing
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', marginBottom: 16 }}>
          <div style={tabStyle(mode === 'qr')} onClick={() => { setMode('qr'); setError(''); setQrStatus('idle'); }}>
            Sign with Wallet
          </div>
          <div style={tabStyle(mode === 'pin')} onClick={() => { setMode('pin'); setError(''); }}>
            Gamertag + Pin
          </div>
        </div>

        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: '24px 24px' }}>

          {/* ═══════════ PIN LOGIN (Tier 3) ═══════════ */}
          {mode === 'pin' && (
            <>
              <label style={LB}>Your Gamertag</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
                <input
                  type="text" value={gamertag}
                  onChange={(e) => { setGamertag(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleCustodialLogin()}
                  placeholder="yourname" style={{ ...inp, flex: 1 }}
                  autoFocus
                />
                <span style={{ fontSize: 11, color: S.dim, fontFamily: S.font, whiteSpace: 'nowrap' }}>.Verus Arcade@</span>
              </div>

              <label style={LB}>Pin Code</label>
              <input
                type="password" inputMode="numeric" value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleCustodialLogin()}
                placeholder="••••" maxLength={6}
                style={{ ...inp, fontSize: 20, letterSpacing: 8, textAlign: 'center', marginBottom: 16 }}
              />

              <button
                onClick={handleCustodialLogin}
                disabled={!canSubmit || loading}
                style={{
                  width: '100%', padding: '14px', border: 'none', borderRadius: 6,
                  background: canSubmit && !loading ? `linear-gradient(135deg, ${S.acc}, #d97706)` : 'rgba(255,255,255,0.05)',
                  color: canSubmit && !loading ? '#000' : S.dim,
                  fontFamily: S.font, fontSize: 14, fontWeight: 700,
                  cursor: canSubmit && !loading ? 'pointer' : 'not-allowed',
                  letterSpacing: 1, textTransform: 'uppercase',
                }}
              >
                {loading ? 'Logging in...' : 'Log In'}
              </button>
            </>
          )}

          {/* ═══════════ QR LOGIN (Tier 2) ═══════════ */}
          {mode === 'qr' && qrStatus === 'idle' && (
            <>
              <div style={{
                fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6,
                marginBottom: 16, padding: '8px 12px',
                background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: `1px solid ${S.border}`,
              }}>
                Scan a QR code with <span style={{ color: S.acc, fontWeight: 700 }}>Verus Mobile</span> to prove you own your identity. No password needed.
              </div>

              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 64, marginBottom: 12 }}>📱</div>
                <div style={{ fontSize: 12, color: S.text, fontFamily: S.font }}>
                  Have Verus Mobile ready on your phone
                </div>
              </div>

              <button onClick={handleGenerateQR} style={{
                width: '100%', padding: '14px', border: 'none', borderRadius: 6,
                background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
                color: '#000', fontFamily: S.font, fontSize: 14, fontWeight: 700,
                cursor: 'pointer', letterSpacing: 1, textTransform: 'uppercase',
              }}>
                📷 Generate QR Code
              </button>
            </>
          )}

          {/* QR loading */}
          {mode === 'qr' && qrStatus === 'loading' && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div style={{ fontSize: 32, animation: 'pulse 1.5s infinite' }}>⏳</div>
              <div style={{ fontSize: 12, color: S.acc, fontFamily: S.font, marginTop: 12 }}>
                Generating QR code...
              </div>
            </div>
          )}

          {/* QR ready */}
          {mode === 'qr' && qrStatus === 'ready' && qrDataUrl && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: S.bright, fontFamily: S.font, fontWeight: 700, marginBottom: 12 }}>
                Scan with Verus Mobile
              </div>

              <div style={{ display: 'inline-block', padding: 12, background: '#fff', borderRadius: 8, marginBottom: 16 }}>
                <img src={qrDataUrl} alt="QR Code" style={{ width: 260, height: 260, display: 'block' }} />
              </div>

              <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6, marginBottom: 12 }}>
                Open Verus Mobile → Scan QR → Approve login
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', padding: '8px 0' }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', background: S.acc,
                  animation: 'pulse 2s infinite',
                }} />
                <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font }}>
                  Waiting for scan...
                </div>
              </div>

              <button onClick={() => { setQrStatus('idle'); setChallengeId(null); setQrDataUrl(null); }} style={{
                marginTop: 8, padding: '8px 16px', border: `1px solid ${S.border}`, borderRadius: 6,
                background: 'transparent', color: S.dim, fontFamily: S.font, fontSize: 11, cursor: 'pointer',
              }}>
                Cancel
              </button>
            </div>
          )}

          {/* QR verified — success */}
          {mode === 'qr' && qrStatus === 'verified' && qrResult && (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: S.grn, fontFamily: S.font, letterSpacing: 1, marginBottom: 4 }}>
                {qrResult.fullname}
              </div>
              <div style={{ fontSize: 11, color: S.acc, fontFamily: S.font }}>
                Entering the arcade...
              </div>
            </div>
          )}

          {/* QR no account found */}
          {mode === 'qr' && qrStatus === 'no_account' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>❓</div>
              <div style={{ fontSize: 13, color: S.red, fontFamily: S.font, marginBottom: 12 }}>
                No Verus Arcade account found for this identity.
              </div>
              <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, marginBottom: 16 }}>
                Register first using "Own Your ID" on the registration page.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={() => navigate('/register')} style={{
                  padding: '10px 20px', border: 'none', borderRadius: 6,
                  background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
                  color: '#000', fontFamily: S.font, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}>
                  Register
                </button>
                <button onClick={() => { setQrStatus('idle'); }} style={{
                  padding: '10px 20px', border: `1px solid ${S.border}`, borderRadius: 6,
                  background: 'transparent', color: S.dim, fontFamily: S.font, fontSize: 12, cursor: 'pointer',
                }}>
                  Try Again
                </button>
              </div>
            </div>
          )}

          {/* QR error */}
          {mode === 'qr' && qrStatus === 'error' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 12, color: S.red, fontFamily: S.font, marginBottom: 16 }}>
                ⚠ {error || 'Something went wrong'}
              </div>
              <button onClick={() => { setQrStatus('idle'); setError(''); }} style={{
                padding: '10px 20px', border: 'none', borderRadius: 6,
                background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
                color: '#000', fontFamily: S.font, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}>
                Try Again
              </button>
            </div>
          )}
        </div>

        {/* Error (for pin login) */}
        {error && mode === 'pin' && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: `1px solid ${S.red}`,
            borderRadius: 6, padding: '10px 14px', marginTop: 8,
            fontSize: 12, color: S.red, fontFamily: S.font,
          }}>
            {error}
          </div>
        )}

        {/* Footer links */}
        <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <span onClick={() => navigate('/register')}
            style={{ fontSize: 12, color: S.acc, cursor: 'pointer', fontFamily: S.font, fontWeight: 700 }}>
            New player? Create a free account →
          </span>
          <span onClick={() => navigate('/')}
            style={{ fontSize: 12, color: S.dim, cursor: 'pointer', fontFamily: S.font }}>
            ← Back to Arcade
          </span>
        </div>

        <style>{`@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.1); } }`}</style>
      </div>
    </div>
  );
}
