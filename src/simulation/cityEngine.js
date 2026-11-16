import {
  BUILDING_DATA,
  getAdjustedStabilityRate,
  SIZE,
  STABILITY_CONFIG,
} from '../constants/constants.js'
import { FREE_BUILDING_TYPES } from '../js/tools/interactor/constants.js'
import { getEffectiveBuildingValue } from '../js/utils/building-interaction-utils.js'

export const BUILDING_SYMBOLS = {
  road: 'R',
  house: 'H',
  house2: 'h',
  factory: 'F',
  chemistry_factory: 'C',
  nuke_factory: 'N',
  shop: 'S',
  office: 'O',
  park: 'P',
  hero_park: 'M',
  garbage_station: 'G',
  sun_power: 'U',
  wind_power: 'W',
  water_tower: 'T',
  hospital: '+',
  police: 'L',
  fire_station: 'E',
}

export const RELOCATE_COST = 100
export const DEMOLISH_REFUND_RATE = 0.7

/**
 * Create a clean 17x17 metadata grid.
 * @param {number} [size]
 * @returns {Array<Array<object>>}
 */
export function createEmptyMetadata(size = SIZE) {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({
      type: 'grass',
      building: null,
      direction: 0,
      level: 0,
    })))
}

/**
 * Ensure a plain state object provides getTile(x, y) expected by interaction utils.
 * @param {object} state
 * @returns {object}
 */
export function ensureStateHelpers(state) {
  if (typeof state.getTile !== 'function') {
    state.getTile = (x, y) => state.metadata?.[x]?.[y] || null
  }
  return state
}

/**
 * Create a standalone headless game state matching useGameState initial state.
 * @returns {object}
 */
export function createInitialState() {
  const state = {
    metadata: createEmptyMetadata(SIZE),
    gameDay: 1,
    credits: 3000,
    territory: 16,
    cityLevel: 1,
    cityName: 'HeXian City',
    citySize: 16,
    stability: STABILITY_CONFIG.BASE_STABILITY,
    stabilityChangeRate: 0,
  }
  return ensureStateHelpers(state)
}

/**
 * Deep clone a headless game state for speculative simulation.
 * @param {object} state
 * @returns {object}
 */
export function cloneGameState(state) {
  const cloned = {
    metadata: state.metadata.map(row =>
      row.map(tile => ({
        ...tile,
        detail: tile.detail ? { ...tile.detail } : undefined,
      }))),
    gameDay: state.gameDay,
    credits: state.credits,
    territory: state.territory,
    cityLevel: state.cityLevel,
    cityName: state.cityName,
    citySize: state.citySize,
    stability: state.stability,
    stabilityChangeRate: state.stabilityChangeRate,
  }
  return ensureStateHelpers(cloned)
}

/**
 * Check whether (x, y) is within grid bounds.
 * @param {number} x
 * @param {number} y
 * @param {Array<Array<object>>} metadata
 * @returns {boolean}
 */
export function isValidCoord(x, y, metadata) {
  return Number.isInteger(x)
    && Number.isInteger(y)
    && Boolean(metadata?.[x]?.[y])
}

/**
 * Rule-faithful placement check (bounds + road adjacency unless FREE_BUILDING_TYPES).
 * @param {number} x
 * @param {number} y
 * @param {string} buildingType
 * @param {Array<Array<object>>} metadata
 * @returns {boolean}
 */
export function canPlaceBuildingOnGrid(x, y, buildingType, metadata) {
  if (!isValidCoord(x, y, metadata))
    return false
  if (!BUILDING_DATA[buildingType])
    return false
  if (metadata[x][y].building)
    return false
  if (FREE_BUILDING_TYPES.includes(buildingType))
    return true

  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]]
  for (const [dx, dy] of dirs) {
    const neighbor = metadata[x + dx]?.[y + dy]
    if (neighbor?.type === 'ground' && neighbor?.building === 'road')
      return true
  }
  return false
}

/**
 * Compute dynamic city level (1..8) from city prosperity metrics.
 * @param {object} metrics - Computed city metrics
 * @returns {number} City level
 */
export function computeCityLevel(metrics) {
  const {
    buildingCount = 0,
    population = 0,
    dailyIncome = 0,
    pollution = 0,
    stability = 100,
  } = metrics

  if (buildingCount >= 150 && population >= 2800 && dailyIncome >= 10000 && pollution <= 25 && stability >= 98)
    return 8
  if (buildingCount >= 130 && population >= 2200 && dailyIncome >= 7500 && stability >= 90)
    return 7
  if (buildingCount >= 105 && population >= 1500 && dailyIncome >= 4500)
    return 6
  if (buildingCount >= 75 && population >= 900 && dailyIncome >= 2200)
    return 5
  if (buildingCount >= 45 && population >= 400 && dailyIncome >= 800)
    return 4
  if (buildingCount >= 22 && population >= 150 && dailyIncome >= 250)
    return 3
  if (buildingCount >= 8 && population >= 40)
    return 2
  return 1
}

/**
 * Compute real achievement unlocks and progress percentages.
 * @param {object} state - Game state
 * @param {object} metrics - Computed city metrics
 * @returns {Array<object>} Achievement list
 */
export function computeAchievements(state, metrics) {
  let factoryCount = 0
  let lv3Count = 0
  state.metadata.forEach((row) => {
    row.forEach((tile) => {
      if (tile.building === 'factory' || tile.building === 'chemistry_factory')
        factoryCount++
      if (tile.building && tile.building !== 'road' && (tile.level || 1) >= 3)
        lv3Count++
    })
  })

  const firstFactoryProgress = factoryCount >= 1 ? 100 : 0
  const industrialTycoonProgress = Math.min(100, Math.round((metrics.dailyIncome / 5000) * 100))
  const metropolisProgress = Math.min(100, Math.round((metrics.population / 2500) * 100))
  const ecoProgress = metrics.buildingCount >= 80 && metrics.pollution <= 0 && metrics.stability >= 95
    ? 100
    : Math.min(
        99,
        Math.round(
          (Math.min(1, metrics.buildingCount / 80) * 50)
          + (metrics.pollution <= 0 ? 50 : Math.max(0, 50 - metrics.pollution)),
        ),
      )
  const skylineProgress = Math.min(100, Math.round((lv3Count / 40) * 100))

  return [
    {
      key: 'firstFactory',
      unlocked: firstFactoryProgress >= 100,
      progress: firstFactoryProgress,
    },
    {
      key: 'industrialTycoon',
      unlocked: industrialTycoonProgress >= 100,
      progress: industrialTycoonProgress,
    },
    {
      key: 'metropolisPop',
      unlocked: metropolisProgress >= 100,
      progress: metropolisProgress,
    },
    {
      key: 'ecoUtopia',
      unlocked: ecoProgress >= 100,
      progress: ecoProgress,
    },
    {
      key: 'skylineMaster',
      unlocked: skylineProgress >= 100,
      progress: skylineProgress,
    },
  ]
}

/**
 * Compute all city KPIs using the exact formulas from useGameState.js.
 * @param {object} state
 * @returns {object}
 */
export function computeMetrics(state) {
  ensureStateHelpers(state)

  let dailyIncome = 0
  let maxPopulation = 0
  let totalJobs = 0
  let maxPower = 0
  let power = 0
  let buildingCount = 0
  let pollution = 0
  let hospitalCount = 0
  let policeStationCount = 0
  let fireStationCount = 0

  state.metadata.forEach((row, x) => {
    row.forEach((tile, y) => {
      if (tile.building && tile.building !== 'road')
        buildingCount++
      if (tile.building === 'hospital')
        hospitalCount++
      if (tile.building === 'police')
        policeStationCount++
      if (tile.building === 'fire_station')
        fireStationCount++

      if (tile.building && tile.detail) {
        dailyIncome += getEffectiveBuildingValue(state, x, y, 'coinOutput')
        if (tile.detail.category === 'residential')
          maxPopulation += getEffectiveBuildingValue(state, x, y, 'maxPopulation')
        totalJobs += tile.detail.population || 0
        maxPower += getEffectiveBuildingValue(state, x, y, 'powerOutput')
        power += tile.detail.powerUsage || 0
        pollution += getEffectiveBuildingValue(state, x, y, 'pollution')
      }
    })
  })

  const population = Math.min(maxPopulation * 1.5, totalJobs)

  let stabilityChangeRate = STABILITY_CONFIG.DEFAULT_STABILITY_CHANGE_RATE
  const servicesCount = hospitalCount + policeStationCount + fireStationCount
  stabilityChangeRate += servicesCount * getAdjustedStabilityRate(STABILITY_CONFIG.SERVICE_STABILITY_PER_SECOND)

  const jobDeficit = totalJobs - maxPopulation
  if (jobDeficit > 0 && maxPopulation > 0) {
    const unemploymentRatio = Number((jobDeficit / maxPopulation).toFixed(2))
    stabilityChangeRate -= unemploymentRatio * getAdjustedStabilityRate(STABILITY_CONFIG.UNEMPLOYMENT_STABILITY_PENALTY)
  }

  if (pollution > STABILITY_CONFIG.POLLUTION_THRESHOLD) {
    const pollutionFactor = (pollution / STABILITY_CONFIG.POLLUTION_THRESHOLD) ** 2
    stabilityChangeRate -= Number((pollutionFactor * getAdjustedStabilityRate(STABILITY_CONFIG.POLLUTION_STABILITY_PENALTY)).toFixed(2))
  }

  const powerDeficit = power - maxPower
  if (powerDeficit > 0 && maxPower > 0) {
    const powerDeficitRatio = Number((powerDeficit / maxPower).toFixed(2))
    stabilityChangeRate -= powerDeficitRatio * getAdjustedStabilityRate(STABILITY_CONFIG.POWER_DEFICIT_STABILITY_PENALTY)
  }

  if (!Number.isFinite(stabilityChangeRate))
    stabilityChangeRate = 0

  const baseMetrics = {
    gameDay: state.gameDay,
    credits: state.credits,
    dailyIncome: Number(dailyIncome.toFixed(2)),
    population: Number(population.toFixed(2)),
    maxPopulation: Number(maxPopulation.toFixed(2)),
    totalJobs,
    power,
    maxPower: Number(maxPower.toFixed(2)),
    powerBalance: Number((maxPower - power).toFixed(2)),
    pollution: Number(pollution.toFixed(2)),
    buildingCount,
    hospitalCount,
    policeStationCount,
    fireStationCount,
    stability: Number(state.stability.toFixed(2)),
    stabilityChangeRate: Number(stabilityChangeRate.toFixed(2)),
  }

  return {
    ...baseMetrics,
    cityLevel: computeCityLevel(baseMetrics),
  }
}

/**
 * Advance simulation by N game days using exact nextDay() semantics.
 * @param {object} state
 * @param {number} [days]
 * @returns {object}
 */
export function advanceDays(state, days = 1) {
  if (!Number.isInteger(days) || days < 0)
    throw new Error(`Invalid days: ${days}`)

  let lastMetrics = computeMetrics(state)
  for (let i = 0; i < days; i++) {
    lastMetrics = computeMetrics(state)
    state.credits += lastMetrics.dailyIncome
    state.gameDay += 1
    state.stabilityChangeRate = lastMetrics.stabilityChangeRate
    state.stability = Math.max(0, Math.min(100, state.stability + lastMetrics.stabilityChangeRate))
  }
  return computeMetrics(state)
}

/**
 * Validate and apply a single rule-compliant action to state.
 * Works on both headless state objects and Pinia gameState stores.
 * @param {object} state
 * @param {object} action
 * @returns {{ ok: boolean, error?: string, action: object }}
 */
export function applyStateAction(state, action) {
  ensureStateHelpers(state)
  if (!action || typeof action !== 'object')
    return { ok: false, error: 'Action must be an object', action }

  switch (action.type) {
    case 'build': {
      const { x, y, buildingType, direction = 0 } = action
      const level = 1
      const levelData = BUILDING_DATA[buildingType]?.levels?.[level]
      if (!levelData)
        return { ok: false, error: `Unknown buildingType: ${buildingType}`, action }
      if (!canPlaceBuildingOnGrid(x, y, buildingType, state.metadata))
        return { ok: false, error: `Cannot place ${buildingType} at (${x}, ${y})`, action }
      if (state.credits < levelData.cost)
        return { ok: false, error: `Insufficient credits for ${buildingType} (${state.credits} < ${levelData.cost})`, action }

      state.credits -= levelData.cost
      const tilePatch = {
        type: 'ground',
        building: buildingType,
        direction: ((direction % 4) + 4) % 4,
        level,
        detail: levelData,
        outputFactor: 1,
      }
      if (typeof state.setTile === 'function')
        state.setTile(x, y, tilePatch)
      else
        Object.assign(state.metadata[x][y], tilePatch)

      return { ok: true, action }
    }

    case 'upgrade': {
      const { x, y } = action
      if (!isValidCoord(x, y, state.metadata))
        return { ok: false, error: `Out of bounds (${x}, ${y})`, action }

      const tile = state.metadata[x][y]
      if (!tile.building)
        return { ok: false, error: `No building at (${x}, ${y})`, action }

      const currentLevel = tile.level || 1
      const currentData = BUILDING_DATA[tile.building]?.levels?.[currentLevel]
      const nextLevel = currentData?.nextLevel
      const nextData = nextLevel ? BUILDING_DATA[tile.building]?.levels?.[nextLevel] : null
      if (!nextLevel || !nextData)
        return { ok: false, error: `${tile.building} Lv.${currentLevel} cannot be upgraded`, action }

      const cost = currentData.upgradeCost ?? nextData.cost
      if (state.credits < cost)
        return { ok: false, error: `Insufficient credits to upgrade (${state.credits} < ${cost})`, action }

      state.credits -= cost
      const patch = {
        level: nextLevel,
        detail: nextData,
        outputFactor: nextData.outputFactor || 1,
      }
      if (typeof state.setTile === 'function')
        state.setTile(x, y, patch)
      else
        Object.assign(tile, patch)

      return { ok: true, action }
    }

    case 'demolish': {
      const { x, y } = action
      if (!isValidCoord(x, y, state.metadata))
        return { ok: false, error: `Out of bounds (${x}, ${y})`, action }

      const tile = state.metadata[x][y]
      if (!tile.building)
        return { ok: false, error: `No building to demolish at (${x}, ${y})`, action }

      const level = tile.level || 1
      const cost = BUILDING_DATA[tile.building]?.levels?.[level]?.cost || 0
      const refund = cost * DEMOLISH_REFUND_RATE
      state.credits += refund

      const patch = {
        type: 'ground',
        building: null,
        direction: 0,
        level: 0,
        detail: undefined,
      }
      if (typeof state.setTile === 'function')
        state.setTile(x, y, patch)
      else
        Object.assign(tile, patch)

      return { ok: true, refund, action }
    }

    case 'relocate': {
      const { fromX, fromY, toX, toY } = action
      if (!isValidCoord(fromX, fromY, state.metadata) || !isValidCoord(toX, toY, state.metadata))
        return { ok: false, error: 'Relocate coordinates out of bounds', action }
      if (fromX === toX && fromY === toY)
        return { ok: false, error: 'Relocate source and destination are identical', action }

      const srcTile = state.metadata[fromX][fromY]
      if (!srcTile.building)
        return { ok: false, error: `No building at (${fromX}, ${fromY})`, action }
      if (state.credits < RELOCATE_COST)
        return { ok: false, error: `Insufficient credits to relocate (${state.credits} < ${RELOCATE_COST})`, action }

      // Check destination validity excluding source tile occupancy check
      const dstTile = state.metadata[toX][toY]
      if (dstTile.building)
        return { ok: false, error: `Destination (${toX}, ${toY}) is occupied`, action }
      if (!canPlaceBuildingOnGrid(toX, toY, srcTile.building, state.metadata))
        return { ok: false, error: `Cannot relocate ${srcTile.building} to (${toX}, ${toY})`, action }

      state.credits -= RELOCATE_COST
      const movedPatch = {
        type: 'ground',
        building: srcTile.building,
        direction: srcTile.direction || 0,
        level: srcTile.level || 1,
        detail: srcTile.detail,
        outputFactor: srcTile.outputFactor || 1,
      }
      const clearedPatch = {
        type: 'ground',
        building: null,
        direction: 0,
        level: 0,
        detail: undefined,
      }
      if (typeof state.setTile === 'function') {
        state.setTile(toX, toY, movedPatch)
        state.setTile(fromX, fromY, clearedPatch)
      }
      else {
        Object.assign(dstTile, movedPatch)
        Object.assign(srcTile, clearedPatch)
      }

      return { ok: true, action }
    }

    case 'rotate': {
      const { x, y, direction } = action
      if (!isValidCoord(x, y, state.metadata))
        return { ok: false, error: `Out of bounds (${x}, ${y})`, action }

      const tile = state.metadata[x][y]
      if (!tile.building || tile.building === 'road')
        return { ok: false, error: `Cannot rotate tile at (${x}, ${y})`, action }

      const nextDir = direction !== undefined
        ? ((direction % 4) + 4) % 4
        : ((tile.direction || 0) + 1) % 4
      if (typeof state.setTile === 'function')
        state.setTile(x, y, { direction: nextDir })
      else
        tile.direction = nextDir

      return { ok: true, action }
    }

    case 'waitDays': {
      const days = action.days ?? 1
      advanceDays(state, days)
      return { ok: true, action }
    }

    default:
      return { ok: false, error: `Unknown action type: ${action.type}`, action }
  }
}

/**
 * Render the 17x17 map as a compact ASCII grid (columns=x, rows=y).
 * @param {object} state
 * @returns {string}
 */
export function renderAsciiMap(state) {
  const size = state.metadata.length
  const header = `    ${Array.from({ length: size }, (_, x) => String(x).padStart(2, ' ')).join(' ')}`
  const rows = [header]
  for (let y = 0; y < size; y++) {
    const cells = []
    for (let x = 0; x < size; x++) {
      const tile = state.metadata[x][y]
      if (!tile.building) {
        cells.push(' .')
      }
      else {
        const sym = BUILDING_SYMBOLS[tile.building] || '?'
        const lvl = tile.building === 'road' ? ' ' : String(tile.level || 1)
        cells.push(`${sym}${lvl}`)
      }
    }
    rows.push(`${String(y).padStart(2, ' ')}  ${cells.join(' ')}`)
  }
  return rows.join('\n')
}

/**
 * Return a compact structured snapshot for LLM Agents.
 * @param {object} state
 * @returns {object}
 */
export function summarizeCityState(state) {
  const metrics = computeMetrics(state)
  const buildings = []
  const upgradeable = []

  state.metadata.forEach((row, x) => {
    row.forEach((tile, y) => {
      if (!tile.building)
        return
      const level = tile.level || 1
      const effectiveCoin = tile.detail ? getEffectiveBuildingValue(state, x, y, 'coinOutput') : 0
      const effectivePop = tile.detail?.category === 'residential'
        ? getEffectiveBuildingValue(state, x, y, 'maxPopulation')
        : 0
      const effectivePower = tile.detail ? getEffectiveBuildingValue(state, x, y, 'powerOutput') : 0
      const effectivePollution = tile.detail ? getEffectiveBuildingValue(state, x, y, 'pollution') : 0

      buildings.push({
        x,
        y,
        type: tile.building,
        level,
        direction: tile.direction || 0,
        effectiveCoin: Number(effectiveCoin.toFixed(2)),
        effectivePop: Number(effectivePop.toFixed(2)),
        effectivePower: Number(effectivePower.toFixed(2)),
        effectivePollution: Number(effectivePollution.toFixed(2)),
      })

      const nextLevel = BUILDING_DATA[tile.building]?.levels?.[level]?.nextLevel
      if (nextLevel) {
        const upgradeCost = BUILDING_DATA[tile.building].levels[level].upgradeCost
          ?? BUILDING_DATA[tile.building].levels[nextLevel].cost
        upgradeable.push({ x, y, type: tile.building, level, nextLevel, upgradeCost })
      }
    })
  })

  return {
    metrics,
    achievements: computeAchievements(state, metrics),
    asciiMap: renderAsciiMap(state),
    legend: BUILDING_SYMBOLS,
    buildings,
    upgradeable,
  }
}
