import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../verus/AuthContext.jsx";

const API = "http://localhost:3001/api";

const STEPS = {
  INPUT: 0,
  CHECKING: 1,
  COMMITTING: 2,
  WAITING_BLOCK: 3,
  REGISTERING: 4,
  DONE: 5,
  ERROR: -1,
};

const STEP_LABELS = {
  [STEPS.CHECKING]: "Checking availability...",
  [STEPS.COMMITTING]: "Reserving your name on-chain...",
  [STEPS.WAITING_BLOCK]: "Waiting for block confirmation...",
  [STEPS.REGISTERING]: "Creating your identity...",
  [STEPS.DONE]: "Welcome to Verus Arcade!",
};

export default function Register() {
  const navigate = useNavigate();
  const { user, loginDirect } = useAuth();
  const [gamertag, setGamertag] = useState("");
  const [step, setStep] = useState(STEPS.INPUT);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [available, setAvailable] = useState(null);
  const [checkTimeout, setCheckTimeout] = useState(null);

  // Redirect if already logged in
  useEffect(() => {
    if (user) navigate("/");
  }, [user]);

  // Debounced name availability check
  useEffect(() => {
    if (checkTimeout) clearTimeout(checkTimeout);
    setAvailable(null);

    const name = gamertag.trim().toLowerCase();
    if (name.length < 3) return;
    if (!/^[a-z0-9_-]+$/.test(name)) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/register/check/${encodeURIComponent(name)}`);
        const data = await res.json();
        setAvailable(data.available);
        if (!data.available) setError(data.error);
        else setError(null);
      } catch {
        setAvailable(null);
      }
    }, 500);

    setCheckTimeout(timeout);
    return () => clearTimeout(timeout);
  }, [gamertag]);

  const validate = () => {
    const name = gamertag.trim().toLowerCase();
    if (name.length < 3) return "At least 3 characters";
    if (name.length > 20) return "Max 20 characters";
    if (!/^[a-z0-9_-]+$/.test(name)) return "Only letters, numbers, hyphens, underscores";
    if (/^[_-]|[_-]$/.test(name)) return "Can't start/end with hyphen or underscore";
    return null;
  };

  const handleRegister = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    if (!available) return;

    setStep(STEPS.COMMITTING);
    setError(null);

    try {
      const res = await fetch(`${API}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamertag: gamertag.trim().toLowerCase() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Registration failed");
        setStep(STEPS.ERROR);
        return;
      }

      // Server returns immediately after commitment — login right away
      setResult(data);
      setStep(STEPS.DONE);

      // Auto-login after 1.5s so player can see success screen briefly
      setTimeout(() => {
        loginDirect({
          identity: data.gamertag,
          fullname: data.fullname,
          identityaddress: data.address,
          custodial: true,
          pending: true, // identity still being created in background
        });
        navigate("/");
      }, 1500);

    } catch (e) {
      setError(e.message);
      setStep(STEPS.ERROR);
    }
  };

  const handleLogin = () => {
    if (result) {
      loginDirect({
        identity: result.gamertag,
        fullname: result.fullname,
        identityaddress: result.address,
        custodial: true,
      });
      navigate("/");
    }
  };

  const S = {
    bg: "#060a10", card: "rgba(12,20,33,0.8)", border: "#1a2a3e",
    acc: "#f59e0b", grn: "#22c55e", red: "#ef4444",
    text: "#c8d6e5", dim: "#5a6a7e", bright: "#e8f0fc",
    font: "'Courier New', monospace",
  };

  const isProcessing = step > STEPS.INPUT && step < STEPS.DONE && step !== STEPS.ERROR;
  const inputError = gamertag.length > 0 ? validate() : null;

  return (
    <div style={{ minHeight: "100vh", background: S.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440 }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎮</div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: S.bright, fontFamily: S.font, letterSpacing: 3, margin: "0 0 8px" }}>
            JOIN THE ARCADE
          </h1>
          <p style={{ fontSize: 13, color: S.dim, lineHeight: 1.6, margin: 0 }}>
            Choose a gamertag. We'll create your on-chain identity.
          </p>
        </div>

        {/* Registration Card */}
        <div style={{
          background: S.card, border: `1px solid ${S.border}`,
          borderRadius: 10, padding: "28px 24px",
        }}>

          {/* Step: Input */}
          {(step === STEPS.INPUT || step === STEPS.ERROR) && (
            <>
              <label style={{ fontSize: 10, color: S.dim, fontFamily: S.font, letterSpacing: 2, textTransform: "uppercase", display: "block", marginBottom: 8 }}>
                GAMERTAG
              </label>

              <div style={{ position: "relative", marginBottom: 8 }}>
                <input
                  type="text"
                  value={gamertag}
                  onChange={e => { setGamertag(e.target.value); setStep(STEPS.INPUT); setError(null); }}
                  placeholder="speedrunner"
                  maxLength={20}
                  style={{
                    width: "100%", padding: "14px 16px", paddingRight: 140,
                    background: "rgba(0,0,0,0.3)", border: `1px solid ${inputError ? S.red : available ? S.grn : S.border}`,
                    borderRadius: 6, color: S.bright, fontFamily: S.font, fontSize: 16,
                    fontWeight: 700, letterSpacing: 1, outline: "none",
                    boxSizing: "border-box",
                    transition: "border-color 0.2s",
                  }}
                  onKeyDown={e => { if (e.key === "Enter" && available) handleRegister(); }}
                  disabled={isProcessing}
                  autoFocus
                />
                <div style={{
                  position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  fontSize: 11, color: S.dim, fontFamily: S.font, pointerEvents: "none",
                }}>
                  .Verus Arcade@
                </div>
              </div>

              {/* Validation feedback */}
              <div style={{ minHeight: 20, marginBottom: 16 }}>
                {inputError && gamertag.length > 0 && (
                  <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>{inputError}</div>
                )}
                {!inputError && available === true && (
                  <div style={{ fontSize: 11, color: S.grn, fontFamily: S.font }}>✓ Available!</div>
                )}
                {!inputError && available === false && (
                  <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>✗ {error || "Name taken"}</div>
                )}
                {step === STEPS.ERROR && error && (
                  <div style={{ fontSize: 11, color: S.red, fontFamily: S.font }}>⚠ {error}</div>
                )}
              </div>

              <button
                onClick={handleRegister}
                disabled={!available || !!inputError}
                style={{
                  width: "100%", padding: "14px", border: "none", borderRadius: 6,
                  background: available && !inputError
                    ? `linear-gradient(135deg, ${S.acc}, #d97706)`
                    : "rgba(255,255,255,0.05)",
                  color: available && !inputError ? "#000" : S.dim,
                  fontFamily: S.font, fontSize: 14, fontWeight: 700,
                  cursor: available && !inputError ? "pointer" : "not-allowed",
                  letterSpacing: 1,
                  transition: "all 0.2s",
                }}
              >
                🆔 CREATE IDENTITY
              </button>

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font, lineHeight: 1.6 }}>
                  This creates a SubID on the Verus testnet blockchain.
                  <br />One account per device. Free on testnet.
                </div>
              </div>
            </>
          )}

          {/* Step: Processing */}
          {isProcessing && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 16, animation: "pulse 1.5s infinite" }}>⛓</div>
              <div style={{
                fontSize: 16, fontWeight: 800, color: S.bright,
                fontFamily: S.font, letterSpacing: 1, marginBottom: 8,
              }}>
                {gamertag.toLowerCase()}.Verus Arcade@
              </div>
              <div style={{
                fontSize: 12, color: S.acc, fontFamily: S.font,
                letterSpacing: 1,
              }}>
                {STEP_LABELS[step] || "Processing..."}
              </div>

              {/* Progress dots */}
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>
                {[STEPS.COMMITTING, STEPS.WAITING_BLOCK, STEPS.REGISTERING].map((s, i) => (
                  <div key={i} style={{
                    width: 10, height: 10, borderRadius: "50%",
                    background: step >= s ? S.acc : "rgba(255,255,255,0.1)",
                    transition: "background 0.3s",
                  }} />
                ))}
              </div>

              <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font, marginTop: 16 }}>
                Reserving your name... This should only take a few seconds.
              </div>
            </div>
          )}

          {/* Step: Done */}
          {step === STEPS.DONE && result && (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
              <div style={{
                fontSize: 20, fontWeight: 900, color: S.grn,
                fontFamily: S.font, letterSpacing: 1, marginBottom: 4,
              }}>
                {result.fullname}
              </div>
              <div style={{ fontSize: 12, color: S.dim, fontFamily: S.font, marginBottom: 12 }}>
                Account created! Entering the arcade...
              </div>
              <div style={{ fontSize: 10, color: S.dim, fontFamily: S.font, fontStyle: "italic" }}>
                Your identity is being finalized on-chain in the background.
              </div>
            </div>
          )}
        </div>

        {/* Footer links */}
        <div style={{ textAlign: "center", marginTop: 20, display: "flex", justifyContent: "center", gap: 24 }}>
          <span
            onClick={() => navigate("/login")}
            style={{ fontSize: 11, color: S.dim, cursor: "pointer", fontFamily: S.font }}
          >
            Already have a VerusID? Login →
          </span>
          <span
            onClick={() => navigate("/")}
            style={{ fontSize: 11, color: S.dim, cursor: "pointer", fontFamily: S.font }}
          >
            ← Back to Arcade
          </span>
        </div>

        {/* Pulse animation */}
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.6; transform: scale(1.1); }
          }
        `}</style>
      </div>
    </div>
  );
}
