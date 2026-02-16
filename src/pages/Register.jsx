import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../verus/AuthContext.jsx";
import QRCode from "qrcode";

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : 'https://api.verusarcade.com/api';

const STEPS = {
  INPUT: 0,
  COMMITTING: 2,
  WAITING_BLOCK: 3,
  REGISTERING: 4,
  DONE: 5,
  ERROR: -1,
};

const STEP_LABELS = {
  [STEPS.COMMITTING]: "Reserving your name on-chain...",
  [STEPS.WAITING_BLOCK]: "Waiting for block confirmation...",
  [STEPS.REGISTERING]: "Creating your identity...",
  [STEPS.DONE]: "Welcome to Verus Arcade!",
};

export default function Register() {
  const navigate = useNavigate();
  const { user, loginDirect } = useAuth();
  const defaultMode = new URLSearchParams(window.location.search).get('mode') === 'ownid' ? 'ownid' : 'custodial';
  const [mode, setMode] = useState(defaultMode);

  // ── Tier 3 (custodial) state ──
  const [gamertag, setGamertag] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState(STEPS.INPUT);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [available, setAvailable] = useState(null);
  const [checkTimeout, setCheckTimeout] = useState(null);

  // ── Tier 2 (QR) state ──
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [qrDeeplink, setQrDeeplink] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [qrStatus, setQrStatus] = useState("idle"); // idle | loading | ready | provisioning | registered | completed | error
  const [qrResult, setQrResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => { if (user) navigate("/"); }, [user]);

  // ── Tier 3: gamertag availability check ──
  useEffect(() => {
    if (mode !== "custodial") return;
    if (checkTimeout) clearTimeout(checkTimeout);
    setAvailable(null);
    const name = gamertag.trim().toLowerCase();
    if (name.length < 3 || !/^[a-z0-9_-]+$/.test(name)) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/register/check/${encodeURIComponent(name)}`);
        const data = await res.json();
        setAvailable(data.available);
        if (!data.available) setError(data.error);
        else setError(null);
      } catch { setAvailable(null); }
    }, 500);
    setCheckTimeout(timeout);
    return () => clearTimeout(timeout);
  }, [gamertag]);

  // ── Tier 2: Poll for QR provisioning status ──
  useEffect(() => {
    if (!challengeId || qrStatus === "completed" || qrStatus === "error") return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/register/tier2/status/${challengeId}`);
        const data = await res.json();

        if (data.status === "registered" || data.status === "completed") {
          setQrStatus("completed");
          setQrResult(data);
          clearInterval(pollRef.current);

          // Auto-login
          setTimeout(() => {
            loginDirect({
              identity: data.gamertag,
              fullname: data.fullname,
              identityaddress: data.address,
              custodial: false,
              tier: 2,
              pending: true,
            });
            navigate("/");
          }, 2000);
        } else if (data.status === "provisioning") {
          setQrStatus("provisioning");
          setQrResult(data);
        } else if (data.status === "expired") {
          setQrStatus("error");
          setError("QR code expired. Generate a new one.");
          clearInterval(pollRef.current);
        }
      } catch (e) {
        console.error("Poll error:", e);
      }
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [challengeId, qrStatus]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Tier 3 validation ──
  const validate = () => {
    const name = gamertag.trim().toLowerCase();
    if (name.length < 3) return "At least 3 characters";
    if (name.length > 20) return "Max 20 characters";
    if (!/^[a-z0-9_-]+$/.test(name)) return "Only letters, numbers, hyphens, underscores";
    if (/^[_-]|[_-]$/.test(name)) return "Can't start/end with hyphen or underscore";
    return null;
  };

  const validatePin = () => {
    if (!pin) return "Pin is required";
    if (pin.length < 4) return "At least 4 digits";
    if (!/^\d+$/.test(pin)) return "Only numbers";
    return null;
  };

  // ── Tier 3: Register with pin ──
  const handleRegister = async () => {
    if (validate()) { setError(validate()); return; }
    if (validatePin()) { setError(validatePin()); return; }
    if (!available) return;

    setStep(STEPS.COMMITTING);
    setError(null);

    try {
      const res = await fetch(`${API}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamertag: gamertag.trim().toLowerCase(), pin }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Registration failed"); setStep(STEPS.ERROR); return; }

      setResult(data);
      setStep(STEPS.DONE);

      setTimeout(() => {
        loginDirect({
          identity: data.gamertag,
          fullname: data.fullname,
          identityaddress: data.address,
          custodial: true,
          tier: 3,
          pending: true,
        });
        navigate("/");
      }, 1500);
    } catch (e) { setError(e.message); setStep(STEPS.ERROR); }
  };

  // ── Tier 2: Generate QR deeplink ──
  const handleGenerateQR = async () => {
    setQrStatus("loading");
    setError(null);
    setQrDataUrl(null);
    setChallengeId(null);

    try {
      const res = await fetch(`${API}/register/tier2/qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || "Failed to generate QR");
        setQrStatus("error");
        return;
      }

      // Generate QR code image from deeplink
      const qrUrl = await QRCode.toDataURL(data.deeplink, {
        width: 280,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      setQrDataUrl(qrUrl);
      setQrDeeplink(data.deeplink);
      setChallengeId(data.challenge_id);
      setQrStatus("ready");
    } catch (e) {
      setError(e.message || "Failed to generate QR");
      setQrStatus("error");
    }
  };

  // ── Styles ──
  const S = {
    bg: "#060a10", card: "rgba(12,20,33,0.8)", border: "#1a2a3e",
    acc: "#f59e0b", grn: "#22c55e", red: "#ef4444",
    text: "#c8d6e5", dim: "#5a6a7e", bright: "#e8f0fc",
    font: "'Courier New', monospace",
  };

  const isProcessing = step > STEPS.INPUT && step < STEPS.DONE && step !== STEPS.ERROR;
  const inputError = gamertag.length > 0 ? validate() : null;
  const pinError = pin.length > 0 ? validatePin() : null;
  const canSubmit = available && !inputError && !pinError && pin.length >= 4;

  const tabStyle = (active) => ({
    flex: 1, padding: "10px 0", textAlign: "center", cursor: "pointer",
    fontFamily: S.font, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
    color: active ? S.acc : S.dim,
    borderBottom: active ? `2px solid ${S.acc}` : `1px solid ${S.border}`,
    transition: "all 0.2s",
  });

  const inp = (hasErr, valid) => ({
    width: "100%", padding: "14px 16px",
    background: "rgba(0,0,0,0.3)", border: `1px solid ${hasErr ? S.red : valid ? S.grn : S.border}`,
    borderRadius: 6, color: S.bright, fontFamily: S.font, fontSize: 14,
    fontWeight: 700, letterSpacing: 1, outline: "none",
    boxSizing: "border-box", transition: "border-color 0.2s",
  });

  const LB = { fontSize: 10, color: S.dim, fontFamily: S.font, letterSpacing: 2, textTransform: "uppercase", display: "block", marginBottom: 8 };

  return (
    <div style={{ minHeight: "100vh", background: S.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎮</div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: S.bright, fontFamily: S.font, letterSpacing: 3, margin: "0 0 8px" }}>
            JOIN THE ARCADE
          </h1>
          <p style={{ fontSize: 13, color: S.dim, lineHeight: 1.6, margin: 0 }}>
            Create your on-chain identity and start playing.
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", marginBottom: 16 }}>
          <div style={tabStyle(mode === "custodial")} onClick={() => { setMode("custodial"); setError(null); }}>
            Quick Play
          </div>
          <div style={tabStyle(mode === "ownid")} onClick={() => { setMode("ownid"); setError(null); setQrStatus("idle"); }}>
            Own Your ID
          </div>
        </div>

        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: "28px 24px" }}>

          {/* ═══════════ TIER 3: Quick Play (gamertag + pin) ═══════════ */}
          {mode === "custodial" && (step === STEPS.INPUT || step === STEPS.ERROR) && (
            <>
              <div style={{
                fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6,
                marginBottom: 16, padding: "8px 12px",
                background: "rgba(0,0,0,0.2)", borderRadius: 6, border: `1px solid ${S.border}`,
              }}>
                We create and manage your identity. No wallet needed. You get <span style={{ color: S.acc, fontWeight: 700 }}>10 free saves</span>. Claim your ID later.
              </div>

              <label style={LB}>GAMERTAG</label>
              <div style={{ position: "relative", marginBottom: 8 }}>
                <input
                  type="text" value={gamertag}
                  onChange={e => { setGamertag(e.target.value); setStep(STEPS.INPUT); setError(null); }}
                  placeholder="speedrunner" maxLength={20}
                  style={{ ...inp(inputError, available), paddingRight: 140 }}
                  onKeyDown={e => { if (e.key === "Enter" && canSubmit) handleRegister(); }}
                  disabled={isProcessing} autoFocus
                />
                <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: S.dim, fontFamily: S.font, pointerEvents: "none" }}>
                  .Verus Arcade@
                </div>
              </div>
              <div style={{ minHeight: 20, marginBottom: 12 }}>
                {inputError && gamertag.length > 0 && <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>{inputError}</div>}
                {!inputError && available === true && <div style={{ fontSize: 11, color: S.grn, fontFamily: S.font }}>✓ Available!</div>}
                {!inputError && available === false && <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>✗ {error || "Name taken"}</div>}
              </div>

              <label style={LB}>PIN CODE</label>
              <input
                type="password" inputMode="numeric" value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                placeholder="4-6 digits" maxLength={6}
                style={{ ...inp(pinError, pin.length >= 4 && !pinError), fontSize: 20, letterSpacing: 8, textAlign: "center" }}
                onKeyDown={e => { if (e.key === "Enter" && canSubmit) handleRegister(); }}
                disabled={isProcessing}
              />
              <div style={{ minHeight: 20, marginBottom: 12, marginTop: 4 }}>
                {pinError && pin.length > 0 && <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>{pinError}</div>}
                {!pinError && pin.length >= 4 && <div style={{ fontSize: 11, color: S.grn, fontFamily: S.font }}>✓ Pin set</div>}
              </div>

              {step === STEPS.ERROR && error && (
                <div style={{ fontSize: 11, color: S.red, fontFamily: S.font, marginBottom: 12 }}>⚠ {error}</div>
              )}

              <button onClick={handleRegister} disabled={!canSubmit} style={{
                width: "100%", padding: "14px", border: "none", borderRadius: 6,
                background: canSubmit ? `linear-gradient(135deg, ${S.acc}, #d97706)` : "rgba(255,255,255,0.05)",
                color: canSubmit ? "#000" : S.dim, fontFamily: S.font, fontSize: 14, fontWeight: 700,
                cursor: canSubmit ? "pointer" : "not-allowed", letterSpacing: 1, transition: "all 0.2s",
              }}>
                🆔 CREATE IDENTITY
              </button>

              <div style={{ marginTop: 16, textAlign: "center", fontSize: 10, color: S.dim, fontFamily: S.font }}>
                Remember your pin to log back in.
              </div>
            </>
          )}

          {/* Tier 3 processing */}
          {mode === "custodial" && isProcessing && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 16, animation: "pulse 1.5s infinite" }}>⛓</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: S.bright, fontFamily: S.font, letterSpacing: 1, marginBottom: 8 }}>
                {gamertag.toLowerCase()}.Verus Arcade@
              </div>
              <div style={{ fontSize: 12, color: S.acc, fontFamily: S.font, letterSpacing: 1 }}>
                {STEP_LABELS[step] || "Processing..."}
              </div>
            </div>
          )}

          {/* Tier 3 done */}
          {mode === "custodial" && step === STEPS.DONE && result && (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: S.grn, fontFamily: S.font, letterSpacing: 1, marginBottom: 4 }}>
                {result.fullname}
              </div>
              <div style={{ fontSize: 12, color: S.dim, fontFamily: S.font }}>Account created! Entering the arcade...</div>
            </div>
          )}

          {/* ═══════════ TIER 2: Own Your ID (QR scan) ═══════════ */}
          {mode === "ownid" && qrStatus === "idle" && (
            <>
              <div style={{
                fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6,
                marginBottom: 16, padding: "8px 12px",
                background: "rgba(0,0,0,0.2)", borderRadius: 6, border: `1px solid ${S.border}`,
              }}>
                Scan a QR code with <span style={{ color: S.acc, fontWeight: 700 }}>Verus Mobile</span> to create your SubID under Verus Arcade@.
                You choose your gamertag in the app. <span style={{ color: S.acc, fontWeight: 700 }}>10 free saves</span> included.
              </div>

              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 64, marginBottom: 12 }}>📱</div>
                <div style={{ fontSize: 12, color: S.text, fontFamily: S.font, marginBottom: 4 }}>
                  Have Verus Mobile ready on your phone
                </div>
                <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font }}>
                  Testnet mode must be enabled
                </div>
              </div>

              <button onClick={handleGenerateQR} style={{
                width: "100%", padding: "14px", border: "none", borderRadius: 6,
                background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
                color: "#000", fontFamily: S.font, fontSize: 14, fontWeight: 700,
                cursor: "pointer", letterSpacing: 1,
              }}>
                📷 GENERATE QR CODE
              </button>
            </>
          )}

          {/* QR loading */}
          {mode === "ownid" && qrStatus === "loading" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 32, animation: "pulse 1.5s infinite" }}>⏳</div>
              <div style={{ fontSize: 12, color: S.acc, fontFamily: S.font, marginTop: 12 }}>
                Generating QR code...
              </div>
            </div>
          )}

          {/* QR ready — show QR code */}
          {mode === "ownid" && (qrStatus === "ready" || qrStatus === "provisioning") && qrDataUrl && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13, color: S.bright, fontFamily: S.font, fontWeight: 700, marginBottom: 12 }}>
                Scan with Verus Mobile
              </div>

              <div style={{
                display: "inline-block", padding: 12, background: "#fff", borderRadius: 8,
                marginBottom: 16,
              }}>
                <img src={qrDataUrl} alt="QR Code" style={{ width: 260, height: 260, display: "block" }} />
              </div>

              <div style={{ fontSize: 11, color: S.dim, fontFamily: S.font, lineHeight: 1.6, marginBottom: 12 }}>
                {qrStatus === "provisioning" ? (
                  <span style={{ color: S.acc }}>⏳ Verus Mobile connected — creating your ID...</span>
                ) : (
                  <>
                    Open Verus Mobile → Scan QR<br />
                    Choose your gamertag → Approve
                  </>
                )}
              </div>

              <div style={{
                display: "flex", gap: 8, justifyContent: "center",
                padding: "8px 0",
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: qrStatus === "ready" ? S.acc : S.grn,
                  animation: qrStatus === "ready" ? "pulse 2s infinite" : "none",
                }} />
                <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font }}>
                  {qrStatus === "ready" ? "Waiting for scan..." : "Processing..."}
                </div>
              </div>

              <button onClick={() => { setQrStatus("idle"); setChallengeId(null); setQrDataUrl(null); }} style={{
                marginTop: 8, padding: "8px 16px", border: `1px solid ${S.border}`, borderRadius: 6,
                background: "transparent", color: S.dim, fontFamily: S.font, fontSize: 11, cursor: "pointer",
              }}>
                Cancel
              </button>
            </div>
          )}

          {/* QR completed */}
          {mode === "ownid" && qrStatus === "completed" && qrResult && (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: S.grn, fontFamily: S.font, letterSpacing: 1, marginBottom: 4 }}>
                {qrResult.fullname}
              </div>
              <div style={{ fontSize: 12, color: S.dim, fontFamily: S.font, marginBottom: 4 }}>
                Your ID is linked to your wallet!
              </div>
              <div style={{ fontSize: 11, color: S.acc, fontFamily: S.font }}>
                Entering the arcade...
              </div>
            </div>
          )}

          {/* QR error */}
          {mode === "ownid" && qrStatus === "error" && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 12, color: S.red, fontFamily: S.font, marginBottom: 16 }}>
                ⚠ {error || "Something went wrong"}
              </div>
              <button onClick={() => { setQrStatus("idle"); setError(null); }} style={{
                padding: "10px 20px", border: "none", borderRadius: 6,
                background: `linear-gradient(135deg, ${S.acc}, #d97706)`,
                color: "#000", fontFamily: S.font, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>
                Try Again
              </button>
            </div>
          )}
        </div>

        {/* Footer links */}
        <div style={{ textAlign: "center", marginTop: 20, display: "flex", justifyContent: "center", gap: 24 }}>
          <span onClick={() => navigate("/login")} style={{ fontSize: 11, color: S.dim, cursor: "pointer", fontFamily: S.font }}>
            Already have an account? Login →
          </span>
          <span onClick={() => navigate("/")} style={{ fontSize: 11, color: S.dim, cursor: "pointer", fontFamily: S.font }}>
            ← Back to Arcade
          </span>
        </div>

        <style>{`@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.1); } }`}</style>
      </div>
    </div>
  );
}
