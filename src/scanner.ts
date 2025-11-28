import { getAddress, Address } from 'viem'
import { TOKENS, COMMON_FEES, TokenSymbol } from './config/tokens'
import { FACTORY_ABI, UNISWAP_V3_FACTORY } from './config/abi'
import { viemClient, redisClient, REDIS_KEYS } from './utils/client'

// Интерфейс для одиночного пула
export interface PoolConfig {
    address: Address
    token0: TokenSymbol
    token1: TokenSymbol
    fee: number
}

// Новый интерфейс для маршрута A -> B -> C -> A
export interface TriadRoute {
    route: [
        { pool: Address, tokenIn: TokenSymbol, tokenOut: TokenSymbol, fee: number }, // A -> B
        { pool: Address, tokenIn: TokenSymbol, tokenOut: TokenSymbol, fee: number }, // B -> C
        { pool: Address, tokenIn: TokenSymbol, tokenOut: TokenSymbol, fee: number }  // C -> A
    ]
}

// Вспомогательный Map для хранения найденных пар:
// Key: "WETH/USDC", Value: [PoolConfig, PoolConfig, ...]
const poolMap = new Map<string, PoolConfig[]>()

// Хеш-функция для пары, гарантирующая уникальность: A/B == B/A
function getPoolKey(tA: TokenSymbol, tB: TokenSymbol): string {
    return tA < tB ? `${tA}/${tB}` : `${tB}/${tA}`
}

async function runScanner() {
    console.log('--- 🔎 STARTING TRIAD SCANNER ---')
    await redisClient.del(REDIS_KEYS.POOLS) // Очищаем старые пары

    const tokenSymbols = Object.keys(TOKENS) as TokenSymbol[]

    // --- Шаг 1: Находим все существующие пулы (как в прошлый раз) ---
    const allChecks: { t0: TokenSymbol, t1: TokenSymbol, fee: number, contract: any }[] = []

    for (let i = 0; i < tokenSymbols.length; i++) {
        for (let j = i + 1; j < tokenSymbols.length; j++) {
            const t0 = tokenSymbols[i]
            const t1 = tokenSymbols[j]
            for (const fee of COMMON_FEES) {
                allChecks.push({
                    t0, t1, fee,
                    contract: {
                        address: getAddress(UNISWAP_V3_FACTORY),
                        abi: FACTORY_ABI,
                        functionName: 'getPool',
                        args: [TOKENS[t0].address, TOKENS[t1].address, fee] as const
                    }
                })
            }
        }
    }

    console.log(`📡 Checking ${allChecks.length} potential pairs via Multicall...`)

    const results = await viemClient.multicall({ contracts: allChecks.map(c => c.contract) })

    results.forEach((res, i) => {
        const poolAddress = res.result as Address
        if (res.status === 'success' && poolAddress !== '0x0000000000000000000000000000000000000000') {
            const config = allChecks[i]
            const poolKey = getPoolKey(config.t0, config.t1)

            const pool: PoolConfig = {
                address: poolAddress,
                token0: config.t0,
                token1: config.t1,
                fee: config.fee,
            }

            // Сохраняем пулы в map для быстрого поиска по токенам
            if (!poolMap.has(poolKey)) {
                poolMap.set(poolKey, [])
            }
            poolMap.get(poolKey)!.push(pool)
        }
    })

    const totalFoundPools = [...poolMap.values()].flat().length
    console.log(`✅ Found ${totalFoundPools} active unique pools.`)

    // --- Шаг 2: Поиск замкнутых маршрутов (Триад) ---
    console.log('\n🧭 Searching for Triads (A -> B -> C -> A)...')
    const triads: TriadRoute[] = []

    for (const tA of tokenSymbols) {
        for (const tB of tokenSymbols) {
            if (tA === tB) continue

            for (const tC of tokenSymbols) {
                if (tC === tA || tC === tB) continue

                // Цепочка: A -> B -> C -> A
                // 1. A <-> B (Pool AB)
                // 2. B <-> C (Pool BC)
                // 3. C <-> A (Pool CA)

                const poolsAB = poolMap.get(getPoolKey(tA, tB)) || []
                const poolsBC = poolMap.get(getPoolKey(tB, tC)) || []
                const poolsCA = poolMap.get(getPoolKey(tC, tA)) || []

                if (poolsAB.length > 0 && poolsBC.length > 0 && poolsCA.length > 0) {

                    // Перебираем все возможные комбинации комиссий (100+ комбинаций)
                    for (const poolAB of poolsAB) {
                        for (const poolBC of poolsBC) {
                            for (const poolCA of poolsCA) {

                                // Создаем маршрут A -> B
                                const leg1 = {
                                    pool: poolAB.address,
                                    tokenIn: tA,
                                    tokenOut: tB,
                                    fee: poolAB.fee
                                }
                                // Создаем маршрут B -> C
                                const leg2 = {
                                    pool: poolBC.address,
                                    tokenIn: tB,
                                    tokenOut: tC,
                                    fee: poolBC.fee
                                }
                                // Создаем маршрут C -> A
                                const leg3 = {
                                    pool: poolCA.address,
                                    tokenIn: tC,
                                    tokenOut: tA,
                                    fee: poolCA.fee
                                }

                                triads.push({ route: [leg1, leg2, leg3] })
                            }
                        }
                    }
                }
            }
        }
    }

    // Триады A->B->C->A и A->C->B->A будут найдены. Используем Set для хранения.
    console.log(`\n🎉 Found ${triads.length} total unique triad routes.`)

    // --- Шаг 3: Запись в Redis ---
    if (triads.length > 0) {
        const pipeline = redisClient.pipeline()

        // Используем другой ключ для триад
        const REDIS_TRIADS_KEY = 'arb_triads_v3'
        pipeline.del(REDIS_TRIADS_KEY)

        const triadStrings = triads.map(t => JSON.stringify(t))
        // Используем SADD для гарантии уникальности, хотя здесь мы уже сгенерировали уникальные маршруты
        pipeline.sadd(REDIS_TRIADS_KEY, ...triadStrings)

        await pipeline.exec()
        console.log(`💾 Saved ${triads.length} triads to Redis key: "${REDIS_TRIADS_KEY}"`)
    }

    process.exit(0)
}

runScanner()