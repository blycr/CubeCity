import { BUILDING_INTERACTIONS } from '@/constants/building-interactions.js'
import { BUILDING_DATA, SIZE, STABILITY_CONFIG } from '@/constants/constants.js'
import { FREE_BUILDING_TYPES } from '@/js/tools/interactor/constants.js'
import { updateAdjacentRoads } from '@/js/tools/interactor/utils.js'
import { eventBus } from '@/js/utils/event-bus.js'
import { decideNextAIMove } from '@/simulation/autonomousMayor.js'
import {
  applyStateAction,
  cloneGameState,
  computeAchievements,
  computeMetrics,
  summarizeCityState,
} from '@/simulation/cityEngine.js'

/**
 * Structured, zero-vision interface allowing LLM Agents to inspect state,
 * validate/simulate plans, and execute rule-compliant city actions with full 3D sync.
 */
export default class AgentBridge {
  constructor(experience) {
    this.experience = experience
    this.autoTickEnabled = true
    this.tickIntervalMs = 5000
    this.isPerforming = false
    this.aiRunning = false
    this.aiSpeed = 3
    this.aiTimer = null
    this.lastAiReason = ''
    this.lastCityLevel = 1
    this.unlockedAchievements = new Set()
  }

  get gameState() {
    return this.experience.gameState
  }

  get city() {
    return this.experience.world?.city || null
  }

  isReady() {
    return Boolean(this.gameState && this.city)
  }

  /**
   * Compact structured snapshot + 17x17 ASCII map for LLM reasoning.
   */
  getState() {
    return {
      ready: this.isReady(),
      autoTickEnabled: this.autoTickEnabled,
      tickIntervalMs: this.tickIntervalMs,
      ...summarizeCityState(this.gameState),
    }
  }

  /**
   * Expose game rules and constants for self-describing Agent inspection.
   */
  getRules() {
    return {
      gridSize: SIZE,
      freePlacementTypes: FREE_BUILDING_TYPES,
      stabilityConfig: STABILITY_CONFIG,
      buildings: BUILDING_DATA,
      interactions: BUILDING_INTERACTIONS,
    }
  }

  /**
   * Dry-run an action plan against a cloned state without mutating the live game.
   */
  simulatePlan(actions) {
    const draft = cloneGameState(this.gameState)
    const results = []
    for (let i = 0; i < actions.length; i++) {
      const res = applyStateAction(draft, actions[i])
      results.push({ index: i, ...res })
      if (!res.ok)
        break
    }
    return {
      ok: results.every(r => r.ok),
      results,
      projectedState: summarizeCityState(draft),
    }
  }

  /**
   * Execute a single rule-compliant action against Pinia + Three.js scene.
   */
  executeAction(action) {
    if (!action || typeof action !== 'object')
      return { ok: false, error: 'Action must be an object' }

    if (action.type === 'waitDays')
      return this.stepDays(action.days ?? 1)

    const res = applyStateAction(this.gameState, action)
    if (!res.ok)
      return res

    this._syncThreeScene(action)
    this.gameState.syncCityLevel?.()
    return {
      ...res,
      metrics: computeMetrics(this.gameState),
    }
  }

  /**
   * Batch-execute an ordered plan of actions (may interleave waitDays steps).
   */
  executePlan(actions, { stopOnError = true } = {}) {
    if (!Array.isArray(actions))
      return { ok: false, error: 'Plan must be an array of actions' }

    const results = []
    for (let i = 0; i < actions.length; i++) {
      const res = this.executeAction(actions[i])
      results.push({ index: i, ...res })
      if (!res.ok && stopOnError) {
        return {
          ok: false,
          completed: i,
          total: actions.length,
          failedAt: i,
          error: res.error,
          results,
          state: this.getState(),
        }
      }
    }

    return {
      ok: results.every(r => r.ok),
      completed: results.length,
      total: actions.length,
      results,
      state: this.getState(),
    }
  }

  /**
   * Advance real game days using Pinia gameState.nextDay().
   */
  stepDays(days = 1) {
    if (!Number.isInteger(days) || days < 0)
      return { ok: false, error: `Invalid days: ${days}` }

    for (let i = 0; i < days; i++)
      this.gameState.nextDay()

    return {
      ok: true,
      daysAdvanced: days,
      metrics: computeMetrics(this.gameState),
    }
  }

  /**
   * Pause, resume, or speed up the 5s auto-day timer in App.vue.
   */
  setAutoTick(enabled, intervalMs = this.tickIntervalMs) {
    this.autoTickEnabled = Boolean(enabled)
    this.tickIntervalMs = Math.max(50, Number(intervalMs) || 5000)
    eventBus.emit('agent:set-auto-tick', {
      enabled: this.autoTickEnabled,
      intervalMs: this.tickIntervalMs,
    })
    return {
      ok: true,
      autoTickEnabled: this.autoTickEnabled,
      tickIntervalMs: this.tickIntervalMs,
    }
  }

  /**
   * Reset the city to Day 1 (3000 credits, empty 17x17 map) and rebuild 3D tiles.
   */
  reset() {
    localStorage.removeItem('gameState')
    this.gameState.resetAll()
    this.city?.initTiles()
    return {
      ok: true,
      state: this.getState(),
    }
  }

  /**
   * Smoothly rotate the isometric camera to the next/previous viewpoint.
   */
  rotateCamera(step = 1) {
    this.experience.camera?.snapToNextPoint?.(step)
    return { ok: true }
  }

  /**
   * Emit a non-blocking toast notification (auto-dismissed by ToastContainer).
   */
  notify(message, type = 'info') {
    eventBus.emit('toast:add', { message, type })
    return { ok: true }
  }

  /**
   * Stream-execute a verified plan with visual pacing for live human spectators.
   */
  async performPlan(actions, options = {}) {
    if (!Array.isArray(actions))
      return { ok: false, error: 'Plan must be an array of actions' }

    const {
      roadDelayMs = 8,
      buildDelayMs = 45,
      upgradeDelayMs = 28,
      dayDelayMs = 22,
      cameraRotateDays = [30, 65, 100, 130],
      stopOnError = true,
    } = options

    const sleep = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())
    const results = []
    const rotatedDays = new Set()
    let notifiedStarter = false
    let notifiedMid = false
    let notifiedLate = false

    this.notify('🤖 AI 规划启动：开始铺设城市路网', 'info')

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]
      const res = this.executeAction(action)
      results.push({ index: i, ...res })

      if (!res.ok && stopOnError) {
        return {
          ok: false,
          completed: i,
          total: actions.length,
          failedAt: i,
          error: res.error,
          results,
          state: this.getState(),
        }
      }

      if (action.type === 'build' && action.buildingType === 'road') {
        await sleep(roadDelayMs)
      }
      else if (action.type === 'build') {
        if (!notifiedStarter) {
          notifiedStarter = true
          this.notify('🏗️ 启动第一阶段：风电与居民区冷启动', 'success')
        }
        await sleep(buildDelayMs)
      }
      else if (action.type === 'upgrade') {
        await sleep(upgradeDelayMs)
      }
      else if (action.type === 'waitDays') {
        const day = this.gameState.gameDay
        if (cameraRotateDays.includes(day) && !rotatedDays.has(day)) {
          rotatedDays.add(day)
          this.rotateCamera(1)
        }
        if (!notifiedMid && day >= 60) {
          notifiedMid = true
          this.notify('⚡ 第60天：中央CBD商务圈与洁净工业协同成型', 'info')
        }
        if (!notifiedLate && day >= 110) {
          notifiedLate = true
          this.notify('🏙️ 第110天：全城166座建筑加速冲刺满级天际线', 'success')
        }
        await sleep(dayDelayMs * (action.days || 1))
      }
    }

    const finalState = this.getState()
    this.notify(
      `🎉 建设表演完成！第${finalState.metrics.gameDay}天 日收入 +${finalState.metrics.dailyIncome} / 稳定度 ${finalState.metrics.stability}%`,
      'success',
    )

    return {
      ok: true,
      completed: results.length,
      total: actions.length,
      results,
      state: finalState,
    }
  }

  /**
   * Start the continuous real-time Autonomous AI Mayor loop.
   * Perceives live state each cycle, builds/upgrades organically, handles crises,
   * and keeps performing urban renewal even after the map is full.
   */
  startAutonomousAI({ speed = 3, freshStart = false } = {}) {
    if (!this.isReady())
      return { ok: false, error: 'Scene not ready yet' }

    if (this.aiRunning)
      return { ok: true, alreadyRunning: true }

    this.aiSpeed = [1, 3, 10].includes(speed) ? speed : 3
    this.aiRunning = true
    this.setAutoTick(false)

    if (freshStart) {
      this.reset()
      this.gameState.setLanguage('zh')
      this.gameState.setShowMapOverview(false)
    }

    const initMetrics = computeMetrics(this.gameState)
    this.lastCityLevel = initMetrics.cityLevel
    this.unlockedAchievements = new Set(
      computeAchievements(this.gameState, initMetrics).filter(a => a.unlocked).map(a => a.key),
    )

    eventBus.emit('agent:showcase-state', { running: true, speed: this.aiSpeed })
    eventBus.emit('agent:ai-status', {
      running: true,
      speed: this.aiSpeed,
      phase: 'INIT',
      reason: '🧠 AI 市长接管城市，实时感知并规划发展中...',
    })
    this.notify('🤖 AI 市长已开启持续实时托管（支持随时手动干预）', 'info')

    this._scheduleNextAICycle(80)
    return { ok: true, running: true, speed: this.aiSpeed }
  }

  stopAutonomousAI() {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer)
      this.aiTimer = null
    }
    if (!this.aiRunning)
      return { ok: true, running: false }

    this.aiRunning = false
    this.setAutoTick(true, 5000)
    eventBus.emit('agent:showcase-state', { running: false, speed: this.aiSpeed })
    eventBus.emit('agent:ai-status', {
      running: false,
      speed: this.aiSpeed,
      phase: 'PAUSED',
      reason: '⏸️ AI 托管已暂停',
    })
    this.notify('⏸️ 已暂停 AI 托管，可随时继续或手动接管', 'info')
    return { ok: true, running: false }
  }

  setAISpeed(speed) {
    this.aiSpeed = [1, 3, 10].includes(speed) ? speed : 3
    eventBus.emit('agent:showcase-state', { running: this.aiRunning, speed: this.aiSpeed })
    return { ok: true, speed: this.aiSpeed }
  }

  _scheduleNextAICycle(delayMs) {
    if (!this.aiRunning)
      return
    if (this.aiTimer)
      clearTimeout(this.aiTimer)
    this.aiTimer = setTimeout(() => this._runAICycle(), delayMs)
  }

  _runAICycle() {
    if (!this.aiRunning)
      return

    const maxActionsPerCycle = this.aiSpeed >= 10 ? 4 : this.aiSpeed >= 3 ? 2 : 1
    let latestDecision = null
    let didAct = false

    for (let i = 0; i < maxActionsPerCycle; i++) {
      const decision = decideNextAIMove(this.gameState)
      latestDecision = decision
      if (!decision.acted || !decision.actions?.length)
        break

      let cycleOk = true
      for (const act of decision.actions) {
        const res = this.executeAction(act)
        if (!res.ok) {
          cycleOk = false
          break
        }
      }
      if (!cycleOk)
        break
      didAct = true
    }

    // Advance 1 game day smoothly when saving or every cycle at higher speeds
    if (!didAct || this.aiSpeed >= 3 || this.gameState.gameDay % 2 === 0)
      this.gameState.nextDay()

    // Check real-time city level & achievement progression milestones
    const metrics = computeMetrics(this.gameState)
    if (metrics.cityLevel > this.lastCityLevel) {
      this.lastCityLevel = metrics.cityLevel
      this.notify(`⬆️ 城市晋升至 Lv.${metrics.cityLevel}！（人口 ${Math.round(metrics.population)} · 日入 +${Math.round(metrics.dailyIncome)}）`, 'success')
      this.rotateCamera(1)
    }

    const achievementNames = {
      firstFactory: '第一座工厂',
      industrialTycoon: '工业大亨',
      metropolisPop: '繁荣都会',
      ecoUtopia: '绿色生态城',
      skylineMaster: '天际线大师',
    }
    for (const ach of computeAchievements(this.gameState, metrics)) {
      if (ach.unlocked && !this.unlockedAchievements.has(ach.key)) {
        this.unlockedAchievements.add(ach.key)
        this.notify(`🏆 解锁成就：${achievementNames[ach.key] || ach.key}！`, 'success')
      }
    }

    if (latestDecision?.reason) {
      this.lastAiReason = latestDecision.reason
      eventBus.emit('agent:ai-status', {
        running: true,
        speed: this.aiSpeed,
        phase: latestDecision.phase,
        reason: latestDecision.reason,
        cityLevel: metrics.cityLevel,
      })
    }

    const baseDelay = this.aiSpeed >= 10 ? 35 : this.aiSpeed >= 3 ? 110 : 320
    this._scheduleNextAICycle(baseDelay)
  }

  /**
   * Entrypoint used by ?showcase=1 and TopBar button: starts continuous live AI Mayor.
   */
  async runAutoShowcase(options = {}) {
    return this.startAutonomousAI({
      speed: options.speed ?? 3,
      freshStart: options.freshStart ?? true,
    })
  }

  _syncThreeScene(action) {
    const city = this.city
    if (!city)
      return

    switch (action.type) {
      case 'build': {
        const tile = city.getTile(action.x, action.y)
        const data = this.gameState.getTile(action.x, action.y)
        if (tile && data?.building) {
          tile.setBuilding(data.building, data.level || 1, data.direction || 0)
          tile.setType('ground')
          updateAdjacentRoads(tile, city)
        }
        break
      }

      case 'upgrade': {
        const tile = city.getTile(action.x, action.y)
        const data = this.gameState.getTile(action.x, action.y)
        if (tile && data?.building) {
          tile.setBuilding(data.building, data.level || 1, data.direction || 0)
          updateAdjacentRoads(tile, city)
        }
        break
      }

      case 'demolish': {
        const tile = city.getTile(action.x, action.y)
        if (tile) {
          tile.removeBuilding()
          tile.setType('ground')
          updateAdjacentRoads(tile, city)
        }
        break
      }

      case 'relocate': {
        const srcTile = city.getTile(action.fromX, action.fromY)
        const dstTile = city.getTile(action.toX, action.toY)
        const dstData = this.gameState.getTile(action.toX, action.toY)
        if (srcTile) {
          srcTile.removeBuilding()
          srcTile.setType('ground')
          updateAdjacentRoads(srcTile, city)
        }
        if (dstTile && dstData?.building) {
          dstTile.setType('ground')
          dstTile.setBuilding(dstData.building, dstData.level || 1, dstData.direction || 0)
          updateAdjacentRoads(dstTile, city)
        }
        break
      }

      case 'rotate': {
        const tile = city.getTile(action.x, action.y)
        const data = this.gameState.getTile(action.x, action.y)
        if (tile && data?.building) {
          tile.setBuilding(data.building, data.level || 1, data.direction || 0)
          updateAdjacentRoads(tile, city)
        }
        break
      }
    }
  }
}
