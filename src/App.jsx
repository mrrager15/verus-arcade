import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './verus/AuthContext.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import LemonadeStand from './games/lemonade/LemonadeStand.jsx'
import ColonyOne from './games/colony/ColonyOne.jsx'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/lemonade" element={<LemonadeStand />} />
        <Route path="/colony" element={<ColonyOne />} />
      </Routes>
    </AuthProvider>
  )
}
