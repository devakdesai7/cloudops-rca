import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { login as apiLogin } from '../api/client'

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'rca_token'
const ROLE_KEY = 'rca_role'
const NAME_KEY = 'rca_name'

function readStorage() {
  return {
    token: localStorage.getItem(TOKEN_KEY),
    role: localStorage.getItem(ROLE_KEY),
    name: localStorage.getItem(NAME_KEY),
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const AuthContext = createContext(null)

/**
 * Provides { token, role, name, login, logout } to the component tree.
 * Persists token/role/name to localStorage so a page refresh keeps the user
 * logged in.
 */
export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => readStorage())

  /**
   * Call the login API, persist the result, and update state.
   * Throws on bad credentials so the caller (Login page) can show an error.
   *
   * @param {string} email
   * @param {string} password
   */
  const login = useCallback(async (email, password) => {
    const data = await apiLogin(email, password)
    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(ROLE_KEY, data.role)
    localStorage.setItem(NAME_KEY, data.name)
    setAuth({ token: data.token, role: data.role, name: data.name })
    return data
  }, [])

  /**
   * Clear auth state and storage.
   */
  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(ROLE_KEY)
    localStorage.removeItem(NAME_KEY)
    setAuth({ token: null, role: null, name: null })
  }, [])

  const value = useMemo(
    () => ({ ...auth, login, logout }),
    [auth, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * Hook — use inside any component wrapped by AuthProvider.
 * @returns {{ token: string|null, role: string|null, name: string|null, login: Function, logout: Function }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
