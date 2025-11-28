import { Address } from 'viem'
import Decimal from 'decimal.js'
import { POOL_ABI } from './config/abi'
import { viemClient, redisClient } from './utils/client'
import { TOKENS, TokenSymbol } from './config/tokens'
import { TriadRoute, PoolConfig } from './scanner'
const REDIS_TRIADS_KEY = 'arb_triads_v3'

interface PriceData {
    priceT1PerT0: Decimal;
    token0Symbol: TokenSymbol;
    token1Symbol: TokenSymbol;
}

function getPriceFromSqrt(sqrtPriceX96: bigint, decimalsToken0: number, decimalsToken1: number): Decimal {
    const Q96 = new Decimal(2).pow(96)
    const sqrt = new Decimal(sqrtPriceX96.toString())
    const priceRaw = sqrt.div(Q96).pow(2)
    const shift = new Decimal(10).pow(decimalsToken0 - decimalsToken1)
    return priceRaw.mul(shift)
}

async function runMonitor() {
    console.log('--- 💰 STARTING TRIAD ARBITRAGE MONITOR ---')
    const triadStrings = await redisClient.smembers(REDIS_TRIADS_KEY)
    if (triadStrings.length === 0) {
        console.error('❌ No triads in Redis. Run scanner first!')
        process.exit(1)
    }
    const triads: TriadRoute[] = triadStrings.map(s => JSON.parse(s))
    const poolConfigMap = new Map<Address, PoolConfig>()
    triads.forEach(triad => {
        triad.route.forEach(leg => {
            const poolKey = leg.pool;
            if (!poolConfigMap.has(poolKey)) {
                const tA = leg.tokenIn;
                const tB = leg.tokenOut;
                const t0Symbol = TOKENS[tA].address < TOKENS[tB].address ? tA : tB
                const t1Symbol = TOKENS[tA].address < TOKENS[tB].address ? tB : tA
                poolConfigMap.set(poolKey, {
                    address: poolKey,
                    token0: t0Symbol,
                    token1: t1Symbol,
                    fee: leg.fee
                })
            }
        })
    })
    const poolAddresses = [...poolConfigMap.keys()]
    const contracts = []
    for (const address of poolAddresses) {
        contracts.push({
            address,
            abi: POOL_ABI,
            functionName: 'slot0'
        })
        contracts.push({
            address,
            abi: POOL_ABI,
            functionName: 'liquidity'
        })
    }
    console.log(`📡 Fetching prices and liquidity for ${poolAddresses.length} unique pools...`)
    const start = Date.now()
    // @ts-ignore
    const results = await viemClient.multicall({ contracts })
    const priceMap = new Map<Address, PriceData>()
    const liquidityMap = new Map<Address, bigint>()
    let resultIndex = 0
    const STABLE_TOKENS = new Set<TokenSymbol>(['USDC', 'USDT', 'DAI']) // Добавлено: стейблы
    for (const poolAddress of poolAddresses) {
        const resSlot0 = results[resultIndex++]
        const resLiquidity = results[resultIndex++]
        if (resSlot0.status === 'success' && resSlot0.result && resLiquidity.status === 'success' && resLiquidity.result) {
            const [sqrtPriceX96] = resSlot0.result as [bigint, number, number, number, number, number, boolean]
            const liquidity = resLiquidity.result as bigint
            const MIN_LIQUIDITY = 1000000000000000000n // Изменено: 1e18
            if (liquidity < MIN_LIQUIDITY) {
                console.log(`⚠️ Skipping low-liquidity pool: ${poolAddress} (liquidity: ${liquidity})`)
                continue
            }
            const config = poolConfigMap.get(poolAddress)!
            const priceT1PerT0 = getPriceFromSqrt(
                sqrtPriceX96,
                TOKENS[config.token0].decimals,
                TOKENS[config.token1].decimals
            )
            // Добавлено: Проверка для стейбл-пулов
            if (STABLE_TOKENS.has(config.token0) && STABLE_TOKENS.has(config.token1)) {
                if (priceT1PerT0.lessThan(0.99) || priceT1PerT0.greaterThan(1.01)) {
                    console.log(`⚠️ Skipping stable pool with abnormal price: ${poolAddress} (price: ${priceT1PerT0.toString()}, liquidity: ${liquidity})`)
                    continue
                }
            }
            liquidityMap.set(poolAddress, liquidity)
            priceMap.set(poolAddress, {
                priceT1PerT0,
                token0Symbol: config.token0,
                token1Symbol: config.token1,
            })
        }
    }
    console.log(`⚡ Fetched prices in ${Date.now() - start}ms`)
    const profitableTriads: any[] = []
    const START_TOKEN_SYMBOL: TokenSymbol = 'WETH';
    const TEST_AMOUNT = new Decimal('1');
    for (const triad of triads) {
        let currentAmount = TEST_AMOUNT
        const routeString: string[] = []
        let isProfitable = true
        let currentTokenSymbol: TokenSymbol = START_TOKEN_SYMBOL
        if (triad.route[0].tokenIn !== START_TOKEN_SYMBOL) continue
        if (triad.route.some(leg => !priceMap.has(leg.pool))) continue
        for (const leg of triad.route) {
            const priceData = priceMap.get(leg.pool)
            if (!priceData) {
                isProfitable = false;
                break;
            }
            if (leg.tokenIn !== currentTokenSymbol) {
                isProfitable = false;
                break;
            }
            let priceMultiplier: Decimal
            const feeRate = new Decimal(leg.fee).div(1_000_000)
            if (leg.tokenIn === priceData.token0Symbol) {
                priceMultiplier = priceData.priceT1PerT0
            } else if (leg.tokenIn === priceData.token1Symbol) {
                priceMultiplier = new Decimal(1).div(priceData.priceT1PerT0)
            } else {
                isProfitable = false;
                break;
            }
            currentAmount = currentAmount.mul(priceMultiplier).mul(new Decimal(1).sub(feeRate))
            currentTokenSymbol = leg.tokenOut
            routeString.push(`${leg.tokenIn} -> ${leg.tokenOut} (${leg.fee/10000}%)`)
        }
        if (!isProfitable) continue
        if (currentTokenSymbol !== START_TOKEN_SYMBOL) continue
        const profit = currentAmount.sub(TEST_AMOUNT)
        const MIN_PROFIT_THRESHOLD = new Decimal('0.001')
        if (profit.greaterThan(MIN_PROFIT_THRESHOLD)) {
            profitableTriads.push({
                Route: routeString.join(' -> '),
                StartToken: START_TOKEN_SYMBOL,
                StartAmount: TEST_AMOUNT.toString(),
                Profit: profit.toSignificantDigits(4).toString(),
                'Profit %': profit.div(TEST_AMOUNT).mul(100).toSignificantDigits(4).toString() + '%',
                Pools: triad.route.map(l => l.pool.slice(0, 8) + '...')
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