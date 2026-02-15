import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import LemonadeStand from './games/lemonade/LemonadeStand.jsx'
import ColonyOne from './games/colony/ColonyOne.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/lemonade" element={<LemonadeStand />} />
      <Route path="/colony" element={<ColonyOne />} />
    </Routes>
  )
}
