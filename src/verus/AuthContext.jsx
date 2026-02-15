import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = window.sessionStorage?.getItem?.('verus_user');
    try { return saved ? JSON.parse(saved) : null; } catch { return null; }
  });

  useEffect(() => {
    if (user) {
      try { window.sessionStorage?.setItem?.('verus_user', JSON.stringify(user)); } catch {}
    } else {
      try { window.sessionStorage?.removeItem?.('verus_user'); } catch {}
    }
  }, [user]);

  const login = (userData) => setUser(userData);
  const loginDirect = (userData) => setUser({ ...userData, custodial: true });
  const logout = () => setUser(null);

  return (
    <AuthContext.Provider value={{ user, login, loginDirect, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
