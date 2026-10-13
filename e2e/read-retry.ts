/** Retry a safe read once when its transport reports a connection reset. */
export async function retryConnectionResetRead<T>(read: () => Promise<T>, onRetry: (error: unknown) => void): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!isConnectionReset(error)) throw error
    onRetry(error)
    return read()
  }
}

export function isConnectionReset(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause
  const message = error instanceof Error ? error.message : String(error)
  return cause?.code === 'ECONNRESET' || /ECONNRESET|connection reset/i.test(message)
}
