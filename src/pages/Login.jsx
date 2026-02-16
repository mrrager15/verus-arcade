import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../verus/AuthContext.jsx';
import { custodialLogin } from '../verus/api.js';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [gamertag, setGamertag] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const S = {
    bg: '#060a10', card: 'rgba(12,20,33,0.85)', border: '#1a2a3e',
    acc: '#f59e0b', green: '#22c55e', red: '#ef4444',
    text: '#c8d6e5', dim: '#5a6a7e', bright: '#e8f0fc',
    font: "'Courier New', monospace",
  };

  const cd = {
    background: S.card, border: `1px solid ${S.border}`, borderRadius: 8,
    padding: '20px 24px', marginBottom: 12,
  };
  const bn = (pri = false, dis = false) => ({
    padding: '12px 20px', border: pri ? 'none' : `1px solid ${S.border}`, borderRadius: 6,
    background: dis ? '#1a2030' : pri ? `linear-gradient(135deg, ${S.acc}, #d97706)` : 'rgba(20,30,48,0.8)',
    color: dis ? '#3a4a5a' : pri ? '#000' : S.text,
    fontFamily: S.font, fontSize: 13, fontWeight: 700, cursor: dis ? 'default' : 'pointer',
    letterSpacing: 1, width: '100%', textTransform: 'uppercase',
  });
  const input = {
    width: '100%', padding: '12px 14px', border: `1px solid ${S.border}`, borderRadius: 6,
    fontFamily: S.font, fontSize: 14, color: S.acc, background: 'rgba(0,0,0,0.4)',
    outline: 'none', boxSizing: 'border-box',
  };
  const lb = {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 2, color: S.dim,
    fontFamily: S.font, fontWeight: 700, marginBottom: 6,
  };

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
      // Try to parse error response
      try {
        const errData = await e.json?.();
        setError(errData?.error || 'Could not connect to server.');
      } catch {
        setError('Could not connect to server. Try again later.');
      }
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh', background: S.bg, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{ maxWidth: 480, width: '100%' }}>
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

        {/* Login Card */}
        <div style={cd}>
          <div style={lb}>Your Gamertag</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <input
              type="text"
              value={gamertag}
              onChange={(e) => { setGamertag(e.target.value); setError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleCustodialLogin()}
              placeholder="yourname"
              style={{ ...input, flex: 1 }}
            />
            <span style={{ fontSize: 11, color: S.dim, fontFamily: S.font, whiteSpace: 'nowrap' }}>.Verus Arcade@</span>
          </div>

          <div style={lb}>Pin Code</div>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleCustodialLogin()}
            placeholder="••••"
            maxLength={6}
            style={{
              ...input, fontSize: 20, letterSpacing: 8, textAlign: 'center',
              marginBottom: 16,
            }}
          />

          <button
            onClick={handleCustodialLogin}
            disabled={!canSubmit || loading}
            style={bn(canSubmit && !loading, !canSubmit || loading)}
          >
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </div>

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

        {/* Footer links */}
        <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <span
            onClick={() => navigate('/register')}
            style={{ fontSize: 12, color: S.acc, cursor: 'pointer', fontFamily: S.font, fontWeight: 700 }}
          >
            New player? Create a free account →
          </span>
          <span
            onClick={() => navigate('/')}
            style={{ fontSize: 12, color: S.dim, cursor: 'pointer', fontFamily: S.font }}
          >
            ← Back to Arcade
          </span>
        </div>
      </div>
    </div>
  );
}
