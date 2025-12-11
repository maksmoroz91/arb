import { Address } from 'viem'
import Decimal from 'decimal.js'
import { POOL_ABI } from './config/abi'
import { viemClient, redisClient } from './utils/client'
import { TOKENS, TokenSymbol } from './config/tokens'
import { RouteLeg, TriadRoute } from './scanner'
Decimal.set({ precision: 60, toExpNeg: -100, toExpPos: 100 })

const REDIS_TRIADS_KEY = 'arb_triads_v3'

function getRawPriceFromSqrt(sqrtPriceX96: bigint): Decimal {
    const Q96 = new Decimal(2).pow(96)
    const sqrt = new Decimal(sqrtPriceX96.toString())
    return sqrt.div(Q96).pow(2)
}

async function runMonitor() {
    console.log('--- 💰 STARTING TRIAD ARBITRAGE MONITOR ---')

    const triadStrings = await redisClient.smembers(REDIS_TRIADS_KEY)

    if (triadStrings.length === 0) {
        console.error('❌ No triads in Redis. Run scanner first!')
        process.exit(1)
    }

    const triads: TriadRoute[] = triadStrings.map(s => JSON.parse(s))

    // 1. Создаем Set всех уникальных пулов для Multicall
    const poolAddresses = new Set<Address>()
    triads.forEach(triad => {
        triad.route.forEach(leg => poolAddresses.add(leg.pool))
    })

    console.log(`📡 Fetching prices and liquidity for ${poolAddresses.size} unique pools...`)
    const start = Date.now()

    const contracts = []
    for (const address of poolAddresses) {
        contracts.push(
            { address, abi: POOL_ABI, functionName: 'slot0' },
            { address, abi: POOL_ABI, functionName: 'liquidity' }
        )
    }

    // @ts-ignore
    const results = await viemClient.multicall({ contracts })
    const priceMap = new Map<Address, { rawPriceT1PerT0: Decimal; liquidity: bigint }>()

    let resultIndex = 0
    for (const address of poolAddresses) {
        const resSlot0 = results[resultIndex++]
        const resLiquidity = results[resultIndex++]

        if (resSlot0.status === 'success' && resLiquidity.status === 'success') {
            const [sqrtPriceX96] = resSlot0.result as [bigint, number, number, number, number, number, boolean]
            const liquidity = resLiquidity.result as bigint
            const MIN_LIQUIDITY = 10000000000000000000n // 10e18 (увеличено для надежности)

            if (liquidity < MIN_LIQUIDITY) {
                console.log(`⚠️ Skipping low-liquidity pool: ${address} (liquidity: ${liquidity})`)
                continue
            }

            const rawPriceT1PerT0 = getRawPriceFromSqrt(sqrtPriceX96)
            priceMap.set(address, { rawPriceT1PerT0, liquidity })
        }
    }

    console.log(`⚡ Fetched prices in ${Date.now() - start}ms`)

    // 2. Расчет прибыльности
    const profitableTriads: any[] = []
    const START_TOKEN_SYMBOL: TokenSymbol = 'WETH'
    const TEST_AMOUNT = new Decimal('1') // 1 WETH
    const MIN_PROFIT_THRESHOLD = new Decimal('0.001') // 0.1%

    for (const triad of triads) {
        let currentAmount = TEST_AMOUNT
        const routeString: string[] = []
        let isProfitable = true
        let currentTokenSymbol: TokenSymbol = START_TOKEN_SYMBOL

        if (triad.route[0].tokenIn !== START_TOKEN_SYMBOL) continue
        if (triad.route.some(leg => !priceMap.has(leg.pool))) continue

        for (const leg of triad.route) {
            const priceData = priceMap.get(leg.pool)
            if (!priceData) { isProfitable = false; break; }

            if (leg.tokenIn !== currentTokenSymbol) {
                isProfitable = false
                break
            }

            // Используем сохраненные token0/token1 из маршрута
            let rawPriceMultiplier: Decimal
            const feeRate = new Decimal(leg.fee).div(1_000_000)
            const decimalsIn = TOKENS[leg.tokenIn].decimals
            const decimalsOut = TOKENS[leg.tokenOut].decimals

            if (leg.tokenIn === leg.token0) {
                rawPriceMultiplier = priceData.rawPriceT1PerT0 // token1/token0
            } else if (leg.tokenIn === leg.token1) {
                rawPriceMultiplier = new Decimal(1).div(priceData.rawPriceT1PerT0) // token0/token1
            } else {
                console.error(`❌ Token mismatch in pool ${leg.pool}`)
                isProfitable = false
                break
            }

            const decShift = new Decimal(10).pow(decimalsIn - decimalsOut)
            const humanExchangeRate = rawPriceMultiplier.mul(decShift)

            currentAmount = currentAmount
                .mul(humanExchangeRate)
                .mul(new Decimal(1).sub(feeRate))

            currentTokenSymbol = leg.tokenOut
            routeString.push(`${leg.tokenIn}→${leg.tokenOut}(${leg.fee/10000}%)`)
        }

        if (!isProfitable) continue
        if (currentTokenSymbol !== START_TOKEN_SYMBOL) continue

        const profit = currentAmount.sub(TEST_AMOUNT)
        if (profit.greaterThan(MIN_PROFIT_THRESHOLD)) {
            profitableTriads.push({
                Route: routeString.join('→'),
                StartToken: START_TOKEN_SYMBOL,
                StartAmount: TEST_AMOUNT.toString(),
                Profit: profit.toSignificantDigits(6).toString(),
                'Profit %': profit.div(TEST_AMOUNT).mul(100).toSignificantDigits(4).toString() + '%',
                Pools: triad.route.map(l => l.pool.slice(0, 10) + '...')
            })
        }
    }

    console.log(`\n--- 🏆 PROFITABLE TRIADS FOUND (${profitableTriads.length}) ---`)
    if (profitableTriads.length > 0) {
        console.table(profitableTriads)
    } else {
        console.log('😔 No profitable triads found above the minimum threshold.')
    }

    await redisClient.quit()
    process.exit(0)
}

runMonitor()