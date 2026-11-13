// Stops whatever is listening on the app's port, so a server left running in the background can be restarted.
import { execSync } from 'node:child_process'

const port = Number(process.env.PORT || 8787)

function listeners() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      return [
        ...new Set(
          out
            .split('\n')
            .filter((line) => /LISTENING/.test(line) && new RegExp(`:${port}\\s`).test(line))
            .map((line) => line.trim().split(/\s+/).pop()),
        ),
      ]
    }
    return execSync(`lsof -ti tcp:${port} -s tcp:listen`, { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const pids = listeners()
if (!pids.length) console.log(`Nothing is running on port ${port}.`)
for (const pid of pids) {
  try {
    process.kill(Number(pid))
    console.log(`Stopped the server on port ${port}.`)
  } catch (e) {
    console.error(`Could not stop process ${pid}: ${e.message}`)
    process.exitCode = 1
  }
}
