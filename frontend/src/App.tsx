import { useEffect, useMemo, useRef, useState } from 'react'
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

type TranscriptSegment = {
  start: number
  end: number
  text: string
}

type TranscriptResponse = {
  text: string
  language: string | null
  segments: TranscriptSegment[]
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

function formatTimestamp(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return '0:00.00'
  }
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}:${remaining.toFixed(2).padStart(5, '0')}`
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
  const [file, setFile] = useState<File | null>(null)
  const [language, setLanguage] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TranscriptResponse | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!file || isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setError('')
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)

    const params = new URLSearchParams()
    if (language.trim()) {
      params.set('language', language.trim())
    }

    try {
      const query = params.toString()
      const url = query
        ? `/api/transcribe/segment?${query}`
        : '/api/transcribe/segment'
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        let message = 'Transcription failed'
        try {
          const payload = (await response.json()) as { detail?: string }
          if (payload.detail) {
            message = payload.detail
          }
        } catch {
          // ignore JSON parsing errors
        }
        setError(message)
        return
      }

      const payload = (await response.json()) as TranscriptResponse
      setResult(payload)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to reach the API'
      setError(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setLanguage('')
    setError('')
    setResult(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const fileMeta = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
    : 'WAV, MP3, M4A, FLAC, or OGG'

  const statusMessage = isSubmitting
    ? 'Transcribing...'
    : error
      ? error
      : result
        ? 'Transcription complete'
        : ''

  return (
    <section className="transcribe-shell">
      <header className="transcribe-header">
        <div>
          {userLabel ? (
            <p className="auth-greeting">Hello {userLabel}</p>
          ) : null}
          <h1 className="transcribe-title">Audio segment transcription</h1>
          <p className="transcribe-subtitle">
            Upload a 30–60 second clip to get a fast transcript.
          </p>
        </div>
        <div className="transcribe-meta">
          {result?.language ? (
            <span>Language: {result.language}</span>
          ) : (
            <span>Language: auto-detect</span>
          )}
          {result ? <span>Segments: {result.segments.length}</span> : null}
        </div>
      </header>

      <form className="transcribe-form" onSubmit={handleSubmit}>
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Audio file</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="file-input"
              onChange={(event) => {
                const [next] = event.target.files ?? []
                setFile(next ?? null)
                setResult(null)
                setError('')
              }}
            />
            <span className="field-hint">{fileMeta}</span>
          </label>
          <label className="field">
            <span className="field-label">Language (optional)</span>
            <input
              type="text"
              className="text-input"
              placeholder="en"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            />
            <span className="field-hint">Leave empty to auto-detect.</span>
          </label>
        </div>

        <div className="transcribe-actions">
          <button type="submit" disabled={!file || isSubmitting}>
            {isSubmitting ? 'Transcribing…' : 'Transcribe'}
          </button>
          <button type="button" className="secondary-button" onClick={handleReset}>
            Reset
          </button>
          {statusMessage ? (
            <span className={error ? 'status error' : 'status'}>
              {statusMessage}
            </span>
          ) : null}
        </div>
      </form>

      {previewUrl ? (
        <div className="audio-preview">
          <audio controls src={previewUrl} />
        </div>
      ) : null}

      {result ? (
        <div className="transcribe-results">
          <div className="transcript-output">
            {result.text || 'No speech detected in this clip.'}
          </div>
          {result.segments.length ? (
            <div className="segment-list">
              {result.segments.map((segment, index) => (
                <div
                  key={`${segment.start}-${segment.end}-${index}`}
                  className="segment-item"
                >
                  <span className="segment-time">
                    {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                  </span>
                  <span className="segment-text">{segment.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
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
