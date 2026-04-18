// Discriminated-union error types for the LLM layer.
// Plain objects (with Error prototype) so stack traces survive, while staying
// in functional style (no ES6 classes).

export type OllamaErrorCode = 'ollama_error'
export type GatewayErrorCode = 'circuit_open' | 'queue_full' | 'queue_timeout' | 'not_supported'

export interface OllamaError extends Error {
  readonly kind: 'ollama_error'
  readonly status: number
}

export interface GatewayError extends Error {
  readonly kind: 'gateway_error'
  readonly code: GatewayErrorCode
}

export const createOllamaError = (status: number, message: string): OllamaError => {
  const err = new Error(message) as Error & { kind: 'ollama_error'; status: number }
  err.name = 'OllamaError'
  err.kind = 'ollama_error'
  err.status = status
  return err
}

export const createGatewayError = (code: GatewayErrorCode, message: string): GatewayError => {
  const err = new Error(message) as Error & { kind: 'gateway_error'; code: GatewayErrorCode }
  err.name = 'GatewayError'
  err.kind = 'gateway_error'
  err.code = code
  return err
}

export const isOllamaError = (err: unknown): err is OllamaError =>
  err instanceof Error && (err as { kind?: string }).kind === 'ollama_error'

export const isGatewayError = (err: unknown): err is GatewayError =>
  err instanceof Error && (err as { kind?: string }).kind === 'gateway_error'

// 4xx errors are permanent (model not found, bad request). Don't retry, don't trip circuit breaker.
export const isPermanent = (err: OllamaError): boolean =>
  err.status >= 400 && err.status < 500
