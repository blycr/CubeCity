import { BUILDING_DATA, SIZE } from '../constants/constants.js'
import {
  applyStateAction,
  canPlaceBuildingOnGrid,
  cloneGameState,
  computeMetrics,
  ensureStateHelpers,
} from './cityEngine.js'

/**
 * Compute natural street-facing direction (0/1/2/3) toward an adjacent road tile.
 * @param {number} x
 * @param {number} y
 * @param {Array<Array<object>>} metadata
 * @returns {number} Facing direction 0..3
 */
function pickStreetFacingDirection(x, y, metadata) {
  const dirs = [
    [1, 0, 0],
    [0, 1, 1],
    [-1, 0, 2],
    [0, -1, 3],
  ]
  const options = []
  for (const [dx, dy, dir] of dirs) {
    if (metadata[x + dx]?.[y + dy]?.building === 'road')
      options.push(dir)
  }
  if (options.length === 0)
    return (x + y) % 4
  return options[(x + y) % options.length]
}

function countAdjacent(metadata, x, y, predicate, range = 1) {
  let count = 0
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (dx === 0 && dy === 0)
        continue
      const tile = metadata[x + dx]?.[y + dy]
      if (tile && predicate(tile, x + dx, y + dy))
        count++
    }
  }
  return count
}

function countOrthogonalRoads(metadata, x, y) {
  let count = 0
  for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    if (metadata[x + dx]?.[y + dy]?.building === 'road')
      count++
  }
  return count
}

/**
 * Spatial district affinity score so the city organically forms:
 * - Central Monument Plaza & CBD skyline around (8, 8)
 * - NW Eco-Industrial & Power cluster (x <= 6, y <= 6)
 * - NE / SE / SW Garden Residential & Mixed neighborhoods
 * - Breezy outer green/wind rim
 */
function getDistrictAffinity(x, y, buildingType, metadata) {
  const distToCenter = Math.abs(x - 8) + Math.abs(y - 8)
  const isRim = x === 0 || x === SIZE - 1 || y === 0 || y === SIZE - 1
  const isNW = x <= 6 && y <= 6
  const isSouthOrEast = x >= 9 || y >= 10
  let bonus = 0

  if (buildingType === 'hero_park') {
    if (x === 8 && y === 8)
      return 320
    return distToCenter <= 3 ? 80 : -60
  }

  if (['hospital', 'police', 'fire_station'].includes(buildingType))
    return distToCenter <= 5 ? 95 : 10

  if (buildingType === 'office' || buildingType === 'shop') {
    if (distToCenter <= 4)
      bonus += 55
    else if (distToCenter <= 7 && !isNW)
      bonus += 25
    else if (isNW)
      bonus -= 35
    if (isRim)
      bonus -= 20
    return bonus
  }

  if (['chemistry_factory', 'factory', 'water_tower', 'garbage_station', 'nuke_factory'].includes(buildingType)) {
    if (isNW)
      bonus += 65
    else if (x <= 7 && y <= 11 && buildingType !== 'factory')
      bonus += 15
    else
      bonus -= 55
    // Keep factories slightly away from the central plaza
    if (distToCenter <= 4)
      bonus -= 70
    return bonus
  }

  if (buildingType === 'house' || buildingType === 'house2') {
    if (isSouthOrEast || (x >= 10 && y <= 8))
      bonus += 45
    if (isNW)
      bonus -= 65
    if (distToCenter <= 2)
      bonus -= 30
    // Reward pocket parks nearby
    const nearbyParks = countAdjacent(metadata, x, y, t => t.building === 'park' || t.building === 'hero_park', 1)
    bonus += nearbyParks * 18
    return bonus
  }

  if (buildingType === 'wind_power') {
    if (isRim)
      bonus += 55
    if (countOrthogonalRoads(metadata, x, y) === 0)
      bonus += 35 // Prefer non-road tiles so road frontage is saved for buildings
    return bonus
  }

  if (buildingType === 'sun_power') {
    const nearbyPowerOrHouse = countAdjacent(metadata, x, y, t => ['house', 'house2', 'wind_power', 'sun_power'].includes(t.building), 1)
    return nearbyPowerOrHouse * 12 + (isNW ? 18 : 0)
  }

  if (buildingType === 'park') {
    if (countOrthogonalRoads(metadata, x, y) === 0)
      bonus += 25
    const nearbyBeneficiaries = countAdjacent(metadata, x, y, t => ['office', 'shop', 'house', 'house2', 'factory', 'chemistry_factory'].includes(t.building), 1)
    bonus += nearbyBeneficiaries * 14
    // Avoid clumping too many adjacent parks together
    const nearbyParks = countAdjacent(metadata, x, y, t => t.building === 'park', 1)
    bonus -= nearbyParks * 18
    return bonus
  }

  return bonus
}

/**
 * Pick the next organic road tile to extend when road-adjacent buildable tiles run low.
 * Avoids rigid checkerboard grids by preferring staggered spacing and avoiding 2x2 road squares.
 */
function pickNextOrganicRoadTile(state) {
  const metadata = state.metadata
  let roadCount = 0
  let buildableRoadFrontage = 0

  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (metadata[x][y].building === 'road')
        roadCount++
      else if (!metadata[x][y].building && countOrthogonalRoads(metadata, x, y) > 0)
        buildableRoadFrontage++
    }
  }

  // Seed central plaza loop first when city is empty
  if (roadCount === 0)
    return { x: 8, y: 7, reason: '铺设中央广场起始大道' }

  // Only grow more roads when current road frontage is getting filled (< 10 open slots)
  if (buildableRoadFrontage >= 10)
    return null

  const candidates = []
  for (let x = 1; x < SIZE - 1; x++) {
    for (let y = 1; y < SIZE - 1; y++) {
      if (metadata[x][y].building)
        continue
      const orthoRoads = countOrthogonalRoads(metadata, x, y)
      if (orthoRoads === 0)
        continue

      // Prevent ugly 2x2 solid asphalt blocks
      const diagBlocks = [
        [[1, 0], [0, 1], [1, 1]],
        [[-1, 0], [0, 1], [-1, 1]],
        [[1, 0], [0, -1], [1, -1]],
        [[-1, 0], [0, -1], [-1, -1]],
      ]
      const formsSquare = diagBlocks.some(tri =>
        tri.every(([dx, dy]) => metadata[x + dx]?.[y + dy]?.building === 'road'),
      )
      if (formsSquare)
        continue

      // Count how many new empty non-road tiles this road segment unlocks
      let newFrontage = 0
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const nx = x + dx
        const ny = y + dy
        const t = metadata[nx]?.[ny]
        if (t && !t.building && countOrthogonalRoads(metadata, nx, ny) === 0)
          newFrontage++
      }
      if (newFrontage === 0 && orthoRoads === 1)
        continue

      let score = newFrontage * 30
      // Prefer straight extensions (2 opposite or 1 ortho neighbor) over cramped 3-way junctions
      if (orthoRoads === 1)
        score += 22
      else if (orthoRoads === 2)
        score += 8
      else
        score -= 15

      // Keep monument center (8,8) reserved for Hero Monument
      if (x === 8 && y === 8)
        score -= 200

      // Slight organic preference closer to active city center first
      const dist = Math.abs(x - 8) + Math.abs(y - 8)
      score -= dist * 1.5

      // Encourage staggered block rhythms (avoid monotonous exact 4-stride lines)
      if ((x === 6 || x === 10) && y >= 5 && y <= 11)
        score += 18
      if ((y === 6 || y === 10) && x >= 5 && x <= 11)
        score += 18

      candidates.push({ x, y, score })
    }
  }

  if (candidates.length === 0)
    return null
  candidates.sort((a, b) => b.score - a.score)
  return { x: candidates[0].x, y: candidates[0].y, reason: '有机延伸街区路网' }
}

/**
 * Evaluate urban renewal (industrial restructuring / upgrading low-tier tiles)
 * when the city is already dense or fully built.
 */
function tryUrbanRenewalDecision(state, metrics) {
  if (state.credits < 2500)
    return null

  // 1. If upgrades are blocked by tight power (< 100), convert an obsolete factory or inland wind turbine into nuke_factory (+300 power),
  //    otherwise replace obsolete factories or excess inner houses into high-yield O3 / C3 / S3 / P3
  const hasPendingUpgrades = state.metadata.some(row =>
    row.some((tile) => {
      if (!tile.building || tile.building === 'road')
        return false
      return Boolean(BUILDING_DATA[tile.building]?.levels?.[tile.level || 1]?.nextLevel)
    }),
  )

  const needPowerUnlock = metrics.powerBalance < 100 && hasPendingUpgrades
  const replacementPool = needPowerUnlock
    ? (metrics.pollution > 15 ? ['nuke_factory', 'park'] : ['nuke_factory'])
    : metrics.pollution > 10
      ? ['park', 'office', 'shop']
      : ['office', 'chemistry_factory', 'shop']

  let bestRenewal = null
  let bestGain = 0

  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const tile = state.metadata[x][y]
      if (!tile.building)
        continue

      // Eligible low-tier targets for urban renewal
      const isObsoleteFactory = tile.building === 'factory'
      const isExcessHouse = (tile.building === 'house' || tile.building === 'house2')
        && metrics.maxPopulation - metrics.totalJobs > 1600
        && (Math.abs(x - 8) + Math.abs(y - 8) <= 7)
      const isSwappableForPower = needPowerUnlock
        && ['factory', 'wind_power', 'sun_power'].includes(tile.building)
        && countOrthogonalRoads(state.metadata, x, y) > 0
      const isConvertibleWind = !needPowerUnlock
        && tile.building === 'wind_power'
        && metrics.powerBalance > 140
        && (metrics.pollution > 0 || (x > 0 && x < SIZE - 1 && y > 0 && y < SIZE - 1))

      if (!isObsoleteFactory && !isExcessHouse && !isSwappableForPower && !isConvertibleWind)
        continue

      for (const nextType of replacementPool) {
        if (nextType === tile.building)
          continue
        const nextCost = BUILDING_DATA[nextType].levels[1].cost
        if (state.credits + (tile.detail?.cost || 0) * 0.7 < nextCost)
          continue

        const draft = cloneGameState(state)
        const demoRes = applyStateAction(draft, { type: 'demolish', x, y })
        if (!demoRes.ok)
          continue
        const buildRes = applyStateAction(draft, {
          type: 'build',
          x,
          y,
          buildingType: nextType,
          direction: pickStreetFacingDirection(x, y, draft.metadata),
        })
        if (!buildRes.ok)
          continue

        // Project maxed-out potential of the new building
        let upgradeGuard = 0
        while (upgradeGuard++ < 5 && applyStateAction(draft, { type: 'upgrade', x, y }).ok)
          continue

        const after = computeMetrics(draft)
        if (after.powerBalance < 0 || after.pollution > 58 || after.totalJobs > after.maxPopulation)
          continue

        const dIncome = after.dailyIncome - metrics.dailyIncome
        const dPop = after.population - metrics.population
        const dPollution = after.pollution - metrics.pollution
        const affinity = getDistrictAffinity(x, y, nextType, state.metadata)
        const ecoWeight = metrics.pollution > 0 ? 18 : 0
        const gain = dIncome * 2 + dPop * 0.5 - dPollution * ecoWeight + affinity

        if (gain > bestGain && (nextType === 'nuke_factory' || (nextType === 'park' && metrics.pollution > 0 && dPollution < -10) || dIncome > 30)) {
          bestGain = gain
          bestRenewal = {
            x,
            y,
            oldType: tile.building,
            nextType,
            direction: pickStreetFacingDirection(x, y, state.metadata),
          }
        }
      }
    }
  }

  if (!bestRenewal)
    return null

  const oldName = BUILDING_DATA[bestRenewal.oldType]?.name?.zh || bestRenewal.oldType
  const newName = BUILDING_DATA[bestRenewal.nextType]?.name?.zh || bestRenewal.nextType
  return {
    actions: [
      { type: 'demolish', x: bestRenewal.x, y: bestRenewal.y },
      {
        type: 'build',
        x: bestRenewal.x,
        y: bestRenewal.y,
        buildingType: bestRenewal.nextType,
        direction: bestRenewal.direction,
      },
    ],
    phase: 'URBAN_RENEWAL',
    reason: `城市更新：淘汰(${bestRenewal.x},${bestRenewal.y})${oldName} → 转型建设${newName}`,
  }
}

/**
 * Single real-time Sense -> Reason -> Act step for the AI Mayor.
 * Inspects the LIVE gameState (handling user edits, crises, expansion, upgrades, and ongoing renewal).
 * @param {object} state - Live or cloned game state
 * @returns {{ acted: boolean, actions?: Array<object>, phase: string, reason: string }}
 */
export function decideNextAIMove(state) {
  ensureStateHelpers(state)
  const metrics = computeMetrics(state)
  const metadata = state.metadata

  // 1. Organic road growth when road frontage is running low
  const roadSuggestion = pickNextOrganicRoadTile(state)
  if (roadSuggestion) {
    return {
      acted: true,
      actions: [{ type: 'build', x: roadSuggestion.x, y: roadSuggestion.y, buildingType: 'road', direction: 0 }],
      phase: 'ROAD_GROWTH',
      reason: `${roadSuggestion.reason} (${roadSuggestion.x},${roadSuggestion.y})`,
    }
  }

  // 2. Gather current city health pressures
  const needPower = metrics.powerBalance < (metrics.dailyIncome >= 400 ? 120 : 45)
  const needHousing = metrics.maxPopulation - metrics.totalJobs < 45
  const needCleanup = metrics.pollution > 28
  const needCivic = metrics.dailyIncome >= 300
    && (metrics.hospitalCount < 1 || metrics.policeStationCount < 1 || metrics.fireStationCount < 1)

  const candidates = []
  const allTypes = Object.keys(BUILDING_DATA).filter(t => t !== 'road')

  // Sample empty tiles (all legal empty slots)
  const emptyBuildSlots = []
  const upgradeSlots = []

  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      const tile = metadata[x][y]
      if (!tile.building) {
        emptyBuildSlots.push({ x, y, orthoRoads: countOrthogonalRoads(metadata, x, y) })
      }
      else if (tile.building !== 'road') {
        const lvl = tile.level || 1
        const nextLevel = BUILDING_DATA[tile.building]?.levels?.[lvl]?.nextLevel
        if (nextLevel) {
          const cost = BUILDING_DATA[tile.building].levels[lvl].upgradeCost
            ?? BUILDING_DATA[tile.building].levels[nextLevel].cost
          upgradeSlots.push({ x, y, buildingType: tile.building, level: lvl, cost })
        }
      }
    }
  }

  const saveHorizon = state.credits + Math.max(metrics.dailyIncome * 5, 1100)

  // Evaluate top representative empty slots per building type (keeps cycle < 15ms!)
  for (const buildingType of allTypes) {
    const cost = BUILDING_DATA[buildingType].levels[1].cost
    if (cost > saveHorizon)
      continue
    if (buildingType === 'park' && metrics.pollution <= 0 && metrics.dailyIncome < 800 && emptyBuildSlots.length > 40)
      continue
    if (buildingType === 'hero_park' && (metrics.dailyIncome < 250 || metadata.flat().some(t => t.building === 'hero_park')))
      continue
    if (buildingType === 'hospital' && metrics.hospitalCount >= 2)
      continue
    if (buildingType === 'police' && metrics.policeStationCount >= 2)
      continue
    if (buildingType === 'fire_station' && metrics.fireStationCount >= 2)
      continue

    const isPowerType = ['wind_power', 'sun_power', 'nuke_factory'].includes(buildingType)
    const isHousingType = ['house2', 'house'].includes(buildingType)
    const isCleanupType = ['park', 'garbage_station', 'wind_power', 'sun_power'].includes(buildingType)

    if (needCleanup && needPower && !(isCleanupType || isPowerType))
      continue
    if (needCleanup && !needPower && !isCleanupType)
      continue
    if (!needCleanup && needPower && !isPowerType)
      continue
    if (!needCleanup && !needPower && needHousing && !isHousingType)
      continue

    // Pick top 4 spatial positions for this buildingType by district affinity
    const rankedSlots = []
    for (const slot of emptyBuildSlots) {
      if (!canPlaceBuildingOnGrid(slot.x, slot.y, buildingType, metadata))
        continue
      const affinity = getDistrictAffinity(slot.x, slot.y, buildingType, metadata)
      rankedSlots.push({ ...slot, affinity })
    }
    rankedSlots.sort((a, b) => b.affinity - a.affinity)

    for (const slot of rankedSlots.slice(0, 3)) {
      candidates.push({
        type: 'build',
        x: slot.x,
        y: slot.y,
        buildingType,
        direction: pickStreetFacingDirection(slot.x, slot.y, metadata),
        cost,
        affinity: slot.affinity,
      })
    }
  }

  // Evaluate upgrades within saveHorizon
  const seenUpgrades = new Set()
  for (const up of upgradeSlots) {
    if (up.cost > saveHorizon)
      continue
    if (needCleanup && !['park', 'house', 'house2'].includes(up.buildingType))
      continue
    const key = `${up.buildingType}:${up.level}`
    if (seenUpgrades.has(key))
      continue
    seenUpgrades.add(key)
    candidates.push({
      type: 'upgrade',
      x: up.x,
      y: up.y,
      buildingType: up.buildingType,
      level: up.level,
      cost: up.cost,
      affinity: 15,
    })
  }

  let best = null
  let bestScore = -Infinity

  for (const cand of candidates) {
    const draft = cloneGameState(state)
    if (draft.credits < cand.cost)
      draft.credits = cand.cost
    const res = applyStateAction(draft, cand)
    if (!res.ok)
      continue

    const after = computeMetrics(draft)
    if (after.powerBalance < 0 || after.pollution > 58)
      continue

    const isPowerPlant = cand.type === 'build' && ['wind_power', 'sun_power', 'nuke_factory'].includes(cand.buildingType)
    const beforeDeficit = Math.max(0, metrics.totalJobs - metrics.maxPopulation)
    const afterDeficit = Math.max(0, after.totalJobs - after.maxPopulation)
    if (!isPowerPlant && afterDeficit > beforeDeficit)
      continue
    if (!isPowerPlant && after.stabilityChangeRate < 0)
      continue

    const dIncome = after.dailyIncome - metrics.dailyIncome
    const dPop = after.population - metrics.population
    const dMaxPop = after.maxPopulation - metrics.maxPopulation
    const dPower = after.powerBalance - metrics.powerBalance
    const dPollution = after.pollution - metrics.pollution
    const dStability = after.stabilityChangeRate - metrics.stabilityChangeRate
    const cost = Math.max(1, cand.cost)

    let score = (dIncome / cost) * 1000
    score += (dPop / cost) * 180
    if (metrics.maxPopulation - metrics.totalJobs < 100)
      score += (dMaxPop / cost) * 70
    if (metrics.powerBalance < 60 && dPower > 0)
      score += (dPower / cost) * 420
    else if (metrics.powerBalance < 200 && dPower > 0)
      score += (dPower / cost) * 110
    if (metrics.pollution > 12 && dPollution < 0)
      score += ((-dPollution) / cost) * 180
    else if (dPollution > 0)
      score -= (dPollution / cost) * 20
    if (dStability > 0)
      score += dStability * 55

    score += (cand.affinity || 0) * 0.5

    if (cand.type === 'build') {
      if (needCivic && ['hospital', 'police', 'fire_station'].includes(cand.buildingType))
        score += 180
      if (cand.buildingType === 'hero_park')
        score += 220
    }
    else if (cand.type === 'upgrade') {
      score += 24
    }

    const waitDays = cand.cost > state.credits && metrics.dailyIncome > 0
      ? Math.ceil((cand.cost - state.credits) / metrics.dailyIncome)
      : 0
    score -= waitDays * 5

    if (score <= 0 && (cand.type === 'upgrade' || emptyBuildSlots.length < 30))
      score = 1 / cost

    if (score > bestScore) {
      bestScore = score
      best = cand
    }
  }

  if (best && bestScore > -Infinity) {
    const zhName = BUILDING_DATA[best.buildingType]?.name?.zh || best.buildingType
    if (best.cost > state.credits) {
      return {
        acted: false,
        phase: 'SAVING',
        reason: `储蓄金币准备${best.type === 'build' ? '建造' : '升级'} ${zhName}（${Math.round(state.credits)}/${best.cost}）`,
      }
    }
    const action = best.type === 'build'
      ? { type: 'build', x: best.x, y: best.y, buildingType: best.buildingType, direction: best.direction }
      : { type: 'upgrade', x: best.x, y: best.y }

    let reasonTag = '扩张建设'
    if (needCleanup)
      reasonTag = '治理污染'
    else if (needPower)
      reasonTag = '扩充电力'
    else if (needHousing)
      reasonTag = '增建住房'
    else if (best.type === 'upgrade')
      reasonTag = '升级天际线'

    const reason = best.type === 'build'
      ? `${reasonTag}：在 (${best.x},${best.y}) 建造${zhName}`
      : `${reasonTag}：将 (${best.x},${best.y}) ${zhName} 升至 Lv.${best.level + 1}`

    return {
      acted: true,
      actions: [action],
      phase: best.type === 'upgrade' ? 'UPGRADE' : 'BUILD',
      reason,
    }
  }

  // 3. When empty land & direct upgrades are saturated (or saving for renewal), attempt live urban renewal!
  const renewal = tryUrbanRenewalDecision(state, metrics)
  if (renewal) {
    return {
      acted: true,
      actions: renewal.actions,
      phase: renewal.phase,
      reason: renewal.reason,
    }
  }

  return {
    acted: false,
    phase: emptyBuildSlots.length === 0 && upgradeSlots.length === 0 ? 'MAINTAIN' : 'SAVING',
    reason: emptyBuildSlots.length === 0 && upgradeSlots.length === 0
      ? `城市持续繁荣运营中（日收入 +${metrics.dailyIncome}）`
      : `积蓄资金以推进下一阶段建设（当前 ${Math.round(state.credits)} 金币）`,
  }
}
