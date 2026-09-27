import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import IncidentDetail from './pages/IncidentDetail'
import IncidentFeed from './pages/IncidentFeed'
import IncidentReport from './pages/IncidentReport'
import Login from './pages/Login'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<Login />} />

          {/* Protected — redirects to /login when no token */}
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<IncidentFeed />} />
            <Route path="/incidents/:incidentId" element={<IncidentDetail />} />
            <Route path="/incidents/:incidentId/report" element={<IncidentReport />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
