import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

/**
 * Wraps routes that require authentication.
 * Redirects to /login if no token is present; otherwise renders child routes
 * via <Outlet />.
 *
 * Usage in the router:
 *   <Route element={<ProtectedRoute />}>
 *     <Route path="/" element={<Home />} />
 *     ...
 *   </Route>
 */
export default function ProtectedRoute() {
  const { token } = useAuth()

  if (!token) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
