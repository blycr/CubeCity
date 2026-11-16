import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { decideNextAIMove } from '../src/simulation/autonomousMayor.js'
import {
  advanceDays,
  applyStateAction,
  computeAchievements,
  computeMetrics,
  createInitialState,
  summarizeCityState,
} from '../src/simulation/cityEngine.js'

const TARGET_DAYS = Number(process.env.TARGET_DAYS || 160)

function runAutonomousSimulation(targetDays = TARGET_DAYS) {
  const state = createInitialState()
  const history = []
  let decisions = 0
  let roads = 0
  let renewals = 0

  for (let day = 1; day <= targetDays; day++) {
    for (let k = 0; k < 15; k++) {
      const dec = decideNextAIMove(state)
      if (!dec.acted)
        break
      for (const act of dec.actions) {
        const res = applyStateAction(state, act)
        if (!res.ok)
          throw new Error(`AI action failed on day ${day}: ${res.error}`)
      }
      decisions++
      if (dec.phase === 'ROAD_GROWTH')
        roads++
      if (dec.phase === 'URBAN_RENEWAL')
        renewals++
    }

    if (day === 1 || day % 20 === 0 || day === targetDays)
      history.push({ ...computeMetrics(state) })

    if (day < targetDays)
      advanceDays(state, 1)
  }

  const finalMetrics = computeMetrics(state)
  return {
    decisions,
    roads,
    renewals,
    history,
    achievements: computeAchievements(state, finalMetrics),
    finalSummary: summarizeCityState(state),
  }
}

function resolveChromiumExecutable() {
  if (process.env.PW_EXECUTABLE_PATH && fs.existsSync(process.env.PW_EXECUTABLE_PATH))
    return process.env.PW_EXECUTABLE_PATH

  const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright')
  if (!fs.existsSync(cacheRoot))
    return undefined

  const dirs = fs.readdirSync(cacheRoot).filter(d => d.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join(cacheRoot, dir, sub)
      if (fs.existsSync(candidate))
        return candidate
    }
  }
  return undefined
}

async function runLivePlaywright(url, targetDays) {
  const { chromium } = await import('@playwright/test')
  const executablePath = resolveChromiumExecutable()
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => Boolean(window.__CUBECITY_AGENT__?.isReady?.()), null, {
      timeout: 30000,
    })

    // Start live autonomous AI inside the real page and inspect state directly (no screenshots)
    const report = await page.evaluate(async (days) => {
      const agent = window.__CUBECITY_AGENT__
      agent.startAutonomousAI({ speed: 10, freshStart: true })
      while (agent.gameState.gameDay < days)
        await new Promise(resolve => setTimeout(resolve, 60))
      agent.stopAutonomousAI()
      return agent.getState()
    }, targetDays)

    return report
  }
  finally {
    await browser.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const liveIdx = args.indexOf('--live')
  const liveUrl = liveIdx !== -1
    ? (args[liveIdx + 1] && !args[liveIdx + 1].startsWith('--') ? args[liveIdx + 1] : 'http://localhost:5173')
    : null

  const t0 = Date.now()
  const result = runAutonomousSimulation(TARGET_DAYS)
  const elapsedMs = Date.now() - t0

  process.stdout.write(`=== CubeCity Real-Time Autonomous AI Mayor (${elapsedMs} ms) ===\n`)
  process.stdout.write(`Decisions: ${result.decisions} (${result.roads} roads, ${result.renewals} urban renewals)\n\n`)
  process.stdout.write('Day progression:\n')
  for (const h of result.history) {
    process.stdout.write(
      `  Day ${String(h.gameDay).padStart(3, ' ')} | Lv.${h.cityLevel} | Credits: ${String(Math.round(h.credits)).padStart(6, ' ')} | +${String(h.dailyIncome).padStart(7, ' ')}/d | Pop: ${String(h.population).padStart(4, ' ')}/${String(Math.round(h.maxPopulation)).padStart(4, ' ')} | Bldgs: ${h.buildingCount} | Poll: ${h.pollution} | Stab: ${h.stability}%\n`,
    )
  }
  process.stdout.write('\nAchievements:\n')
  for (const a of result.achievements)
    process.stdout.write(`  - ${a.key}: ${a.progress}% (${a.unlocked ? 'UNLOCKED' : 'in progress'})\n`)

  process.stdout.write('\nFinal 17x17 City Map (ASCII):\n')
  process.stdout.write(`${result.finalSummary.asciiMap}\n\n`)

  if (liveUrl) {
    process.stdout.write(`=== Live State-Machine Verification at ${liveUrl} ===\n`)
    const liveState = await runLivePlaywright(liveUrl, TARGET_DAYS)
    process.stdout.write(`${JSON.stringify({ metrics: liveState.metrics, achievements: liveState.achievements }, null, 2)}\n`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main()
