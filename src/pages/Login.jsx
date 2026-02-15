import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../verus/AuthContext.jsx';
import { getLoginChallenge, verifyLogin, getIdentity } from '../verus/api.js';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [step, setStep] = useState('enter'); // enter → sign → verify
  const [identity, setIdentity] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState('');
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

  // Step 1: Check identity exists, get challenge
  const handleIdentitySubmit = async () => {
    setError('');
    setLoading(true);
    const name = identity.trim().replace(/@$/, '') + '@';
    try {
      const idInfo = await getIdentity(name);
      if (!idInfo || idInfo.error) {
        setError('Identity not found on testnet. Make sure you have a registered VerusID.');
        setLoading(false);
        return;
      }
      const ch = await getLoginChallenge();
      setChallenge(ch);
      setStep('sign');
    } catch (e) {
      setError('Could not connect to backend. Is the server running on port 3001?');
    }
    setLoading(false);
  };

  // Step 2: Verify signature
  const handleVerify = async () => {
    setError('');
    setLoading(true);
    const name = identity.trim().replace(/@$/, '') + '@';
    try {
      const result = await verifyLogin(name, challenge.message, signature.trim());
      if (result.verified) {
        login({
          identity: result.identity,
          address: result.identityaddress,
          fullname: result.fullyqualifiedname,
        });
        navigate('/');
      } else {
        setError('Signature verification failed. Make sure you signed the exact message with the correct identity.');
      }
    } catch (e) {
      setError('Verification error. Check backend connection.');
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
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🆔</div>
          <h1 style={{
            fontSize: 24, fontWeight: 900, color: S.bright,
            fontFamily: S.font, letterSpacing: 3, margin: '0 0 6px',
          }}>
            VERUSID LOGIN
          </h1>
          <p style={{ fontSize: 12, color: S.dim, fontFamily: S.font }}>
            Prove identity ownership via cryptographic signature
          </p>
        </div>

        {/* Step 1: Enter Identity */}
        {step === 'enter' && (
          <div style={cd}>
            <div style={lb}>Your VerusID (testnet)</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <input
                type="text"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleIdentitySubmit()}
                placeholder="yourname"
                style={{ ...input, flex: 1 }}
              />
              <span style={{ fontSize: 12, color: S.dim, fontFamily: S.font, whiteSpace: 'nowrap' }}>@</span>
            </div>
            <button
              onClick={handleIdentitySubmit}
              disabled={!identity.trim() || loading}
              style={bn(!loading && identity.trim(), !identity.trim() || loading)}
            >
              {loading ? 'Checking...' : '→ Generate Challenge'}
            </button>
          </div>
        )}

        {/* Step 2: Sign Challenge */}
        {step === 'sign' && challenge && (
          <div style={cd}>
            <div style={lb}>Step 1 — Copy this command</div>
            <p style={{ fontSize: 11, color: S.dim, marginBottom: 10, lineHeight: 1.6 }}>
              Open a terminal and run this command to sign the challenge with your VerusID:
            </p>
            <div
              onClick={() => {
                const cmd = `verus -chain=vrsctest signmessage "${identity.trim().replace(/@$/, '')}@" "${challenge.message}"`;
                navigator.clipboard.writeText(cmd);
              }}
              style={{
                background: 'rgba(0,0,0,0.5)', border: `1px solid ${S.border}`, borderRadius: 4,
                padding: '12px 14px', fontFamily: S.font, fontSize: 11, color: S.green,
                cursor: 'pointer', wordBreak: 'break-all', lineHeight: 1.6, marginBottom: 16,
                position: 'relative',
              }}
            >
              <div style={{ position: 'absolute', top: 4, right: 8, fontSize: 9, color: S.dim }}>
                click to copy
              </div>
              verus -chain=vrsctest signmessage "{identity.trim().replace(/@$/, '')}@" "{challenge.message}"
            </div>

            <div style={lb}>Step 2 — Paste the signature</div>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Paste the signature output here..."
              rows={3}
              style={{ ...input, resize: 'vertical', marginBottom: 16 }}
            />
            <button
              onClick={handleVerify}
              disabled={!signature.trim() || loading}
              style={bn(!loading && signature.trim(), !signature.trim() || loading)}
            >
              {loading ? 'Verifying...' : '⛓ Verify Signature'}
            </button>

            <button
              onClick={() => { setStep('enter'); setChallenge(null); setSignature(''); setError(''); }}
              style={{ ...bn(), marginTop: 8, background: 'transparent', borderColor: S.dim, color: S.dim }}
            >
              ← Back
            </button>
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

        {/* Back to Arcade */}
        <div style={{ textAlign: 'center', marginTop: 20 }}>
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
