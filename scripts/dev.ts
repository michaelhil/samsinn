// Dev orchestrator — spawns the Bun watcher and the Tailwind v4 watcher as
// children and forwards signals so Ctrl-C cleans up both.
//
// If either child crashes independently (non-zero exit without our sibling
// cleanup firing), we log loudly so the developer doesn't end up with a
// stale dist.css or a dead server and no clue why.

let shuttingDown = false

const spawnChild = (cmd: string[], label: string): Bun.Subprocess => {
  const child = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  child.exited.then((code) => {
    if (shuttingDown) return
    if (code === 0) {
      console.error(`[dev] ${label} exited cleanly (code 0)`)
    } else {
      const detail = label === 'tailwind'
        ? 'dist.css is now stale — the UI will keep serving the last good build until you restart dev.'
        : 'the server is down.'
      console.error(`\n[dev] \u26a0  ${label} crashed with exit code ${code}. ${detail}\n[dev]   Restart with: bun run dev\n`)
    }
  })
  return child
}

const server = spawnChild(
  ['bun', '--watch', 'src/main.ts'],
  'server',
)

const css = spawnChild(
  [
    'bunx', '@tailwindcss/cli',
    '-i', 'src/ui/input.css',
    '-o', 'src/ui/dist.css',
    '--watch',
  ],
  'tailwind',
)

const cleanup = (): void => {
  shuttingDown = true
  for (const child of [server, css]) {
    try { child.kill() } catch { /* already exited */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// Stay alive until both children exit.
await Promise.all([server.exited, css.exited])
