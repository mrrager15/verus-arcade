import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './verus/AuthContext.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import PlayerProfile from './pages/PlayerProfile.jsx'
import Leaderboard from './pages/Leaderboard.jsx'
import Achievements from './pages/Achievements.jsx'
import LemonadeStand from './games/lemonade/LemonadeStand.jsx'
import CatanGame from './games/catan/CatanGame';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/profile" element={<PlayerProfile />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/achievements" element={<Achievements />} />
        <Route path="/lemonade" element={<LemonadeStand />} />
        <Route path="/catan" element={<CatanGame />} />
      </Routes>
    </AuthProvider>
  )
}
