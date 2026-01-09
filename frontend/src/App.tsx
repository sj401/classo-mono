import { useEffect, useMemo, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

const CODE_VERIFIER_KEY = 'cognito_pkce_verifier'

type AuthConfig = {
  domain: string
  clientId: string
  redirectUri: string
  logoutUri: string
  scope: string
  authority?: string
}

function getAuthConfig(): AuthConfig {
  const origin = window.location.origin
  return {
    domain: import.meta.env.VITE_COGNITO_DOMAIN ?? '',
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? '',
    redirectUri: import.meta.env.VITE_COGNITO_REDIRECT_URI ?? origin,
    logoutUri: import.meta.env.VITE_COGNITO_LOGOUT_URI ?? origin,
    scope: import.meta.env.VITE_COGNITO_SCOPE ?? 'openid email profile',
    authority: import.meta.env.VITE_COGNITO_AUTHORITY,
  }
}

function isAuthenticated() {
  return Boolean(
    localStorage.getItem('cognito_id_token') ||
      localStorage.getItem('cognito_access_token'),
  )
}

function buildHostedUrl(config: AuthConfig, path: string) {
  const base = config.domain.startsWith('http')
    ? config.domain
    : `https://${config.domain}`
  return `${base}${path}`
}

function buildLogoutUrl(config: AuthConfig) {
  const base = buildHostedUrl(config, '/logout')
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.logoutUri,
  })
  return `${base}?${params.toString()}`
}

function base64UrlEncode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64UrlDecode(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/')
  return atob(normalized)
}

function getUserLabel() {
  const idToken = localStorage.getItem('cognito_id_token')
  if (!idToken) {
    return ''
  }
  const [, payload] = idToken.split('.')
  if (!payload) {
    return ''
  }
  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as Record<string, string>
    return (
      decoded.name ||
      decoded.given_name ||
      decoded.email ||
      decoded['cognito:username'] ||
      decoded.preferred_username ||
      decoded.username ||
      ''
    )
  } catch {
    return ''
  }
}

function randomVerifier(length = 64) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function createCodeChallenge(verifier: string) {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(digest)
}

async function buildLoginUrl(config: AuthConfig) {
  const codeVerifier = randomVerifier()
  const codeChallenge = await createCodeChallenge(codeVerifier)
  sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier)

  const base = buildHostedUrl(config, '/oauth2/authorize')
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scope,
    redirect_uri: config.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${base}?${params.toString()}`
}

async function exchangeCodeForTokens(config: AuthConfig, code: string) {
  const verifier = sessionStorage.getItem(CODE_VERIFIER_KEY)
  if (!verifier) {
    throw new Error('Missing PKCE code verifier')
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  })

  const response = await fetch(buildHostedUrl(config, '/oauth2/token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  if (!response.ok) {
    throw new Error('Token exchange failed')
  }

  const payload = await response.json()
  if (payload.id_token) {
    localStorage.setItem('cognito_id_token', payload.id_token)
  }
  if (payload.access_token) {
    localStorage.setItem('cognito_access_token', payload.access_token)
  }
  sessionStorage.removeItem(CODE_VERIFIER_KEY)
  return Boolean(payload.id_token || payload.access_token)
}

function DefaultApp({ userLabel }: { userLabel: string }) {
  const [count, setCount] = useState(0)

  return (
    <>
      {userLabel ? <h2 className="auth-greeting">Hello {userLabel}</h2> : null}
      <div>
        <a href="https://vite.dev" target="_blank" rel="noreferrer">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setCount((current) => current + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  )
}

function App() {
  const config = useMemo(getAuthConfig, [])
  const [authed, setAuthed] = useState(isAuthenticated())
  const [authError, setAuthError] = useState('')
  const [userLabel, setUserLabel] = useState(() => getUserLabel())

  useEffect(() => {
    if (authed) {
      setUserLabel(getUserLabel())
    } else {
      setUserLabel('')
    }
  }, [authed])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const error = params.get('error')
    if (error) {
      setAuthError(error)
      return
    }
    if (!code) {
      return
    }

    exchangeCodeForTokens(config, code)
      .then((didStore) => {
        if (didStore) {
          setAuthed(true)
          setAuthError('')
          setUserLabel(getUserLabel())
        }
      })
      .catch(() => {
        setAuthError('Token exchange failed')
      })
      .finally(() => {
        window.history.replaceState(null, '', window.location.pathname)
      })
  }, [])

  const hasConfig = Boolean(config.domain && config.clientId)

  return (
    <>
      <div className="auth-bar">
        {authed ? (
          <button
            type="button"
            className="auth-button"
            onClick={() => {
              localStorage.removeItem('cognito_id_token')
              localStorage.removeItem('cognito_access_token')
              setAuthed(false)
              setUserLabel('')
              if (hasConfig) {
                window.location.assign(buildLogoutUrl(config))
              }
            }}
          >
            Log out
          </button>
        ) : (
          <button
            type="button"
            className="auth-button"
            onClick={() => {
              if (!hasConfig) {
                return
              }
              buildLoginUrl(config)
                .then((url) => {
                  window.location.assign(url)
                })
                .catch(() => {
                  setAuthError('Unable to start login')
                })
            }}
            disabled={!hasConfig}
          >
            Log in with Cognito
          </button>
        )}
      </div>
      {authed ? (
        <DefaultApp userLabel={userLabel} />
      ) : (
        <div className="auth-gate">
          <h1>Welcome</h1>
          <p>Authenticate with AWS Cognito to continue.</p>
          {authError && <p className="auth-hint">Auth error: {authError}</p>}
          {!hasConfig && (
            <p className="auth-hint">
              Missing config. Set `VITE_COGNITO_DOMAIN` and
              `VITE_COGNITO_CLIENT_ID`. Optional: `VITE_COGNITO_REDIRECT_URI`
              and `VITE_COGNITO_LOGOUT_URI`.
            </p>
          )}
        </div>
      )}
    </>
  )
}

export default App
