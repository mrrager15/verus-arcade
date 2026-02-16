import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './verus/AuthContext.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import PlayerProfile from './pages/PlayerProfile.jsx'
import LemonadeStand from './games/lemonade/LemonadeStand.jsx'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/profile" element={<PlayerProfile />} />
        <Route path="/lemonade" element={<LemonadeStand />} />
      </Routes>
    </AuthProvider>
  )
}
