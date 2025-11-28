import { Address } from 'viem'
import Decimal from 'decimal.js'
import { POOL_ABI } from './config/abi'
import { viemClient, redisClient } from './utils/client'
import { TOKENS, TokenSymbol } from './config/tokens'
import { TriadRoute, PoolConfig } from './scanner' // Добавлена PoolConfig

const REDIS_TRIADS_KEY = 'arb_triads_v3'

// Интерфейс для хранения цены и информации о токенах пула
interface PriceData {
    priceT1PerT0: Decimal;
    token0Symbol: TokenSymbol;
    token1Symbol: TokenSymbol;
}

// Математика Uniswap V3: Price (T1/T0)
function getPriceFromSqrt(sqrtPriceX96: bigint, decimalsToken0: number, decimalsToken1: number): Decimal {
    const Q96 = new Decimal(2).pow(96)
    const sqrt = new Decimal(sqrtPriceX96.toString())

    // Цена в терминах T0
    const priceRaw = sqrt.div(Q96).pow(2)
    // Корректировка на decimals: (10^dec0 / 10^dec1)
    const shift = new Decimal(10).pow(decimalsToken0 - decimalsToken1)

    // Цена T1 в терминах T0
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

    // 1. Создаем Map всех уникальных пулов для Multicall
    const poolConfigMap = new Map<Address, PoolConfig>()
    triads.forEach(triad => {
        triad.route.forEach(leg => {
            const poolKey = leg.pool;
            // Создаем PoolConfig для правильного определения T0 и T1
            if (!poolConfigMap.has(poolKey)) {
                // Присваиваем T0 и T1, основываясь на сортировке (token0 < token1)
                // В scanner.ts мы сохраняли token0/token1 по их адресу, здесь мы просто
                // берем пару токенов, которые мы знаем, используют этот пул.
                const tA = leg.tokenIn;
                const tB = leg.tokenOut;

                // ВАЖНО: Определяем T0 и T1 пула по адресу, чтобы правильно применить decimals в getPriceFromSqrt
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
    const contracts = poolAddresses.map(address => ({
        address,
        abi: POOL_ABI,
        functionName: 'slot0'
    }))

    console.log(`📡 Fetching prices for ${poolAddresses.length} unique pools...`)
    const start = Date.now()

    // @ts-ignore
    const results = await viemClient.multicall({ contracts })

    const priceMap = new Map<Address, PriceData>() // Key: Pool Address

    // 2. Обработка результатов и сохранение PriceData
    results.forEach((res, i) => {
        if (res.status === 'success' && res.result) {
            const poolAddress = poolAddresses[i]
            const [sqrtPriceX96] = res.result as [bigint, number, number, number, number, number, boolean]
            const config = poolConfigMap.get(poolAddress)!

            const priceT1PerT0 = getPriceFromSqrt(
                sqrtPriceX96,
                TOKENS[config.token0].decimals,
                TOKENS[config.token1].decimals
            )

            priceMap.set(poolAddress, {
                priceT1PerT0,
                token0Symbol: config.token0,
                token1Symbol: config.token1,
            })
        }
    })

    console.log(`⚡ Fetched prices in ${Date.now() - start}ms`)

    // 3. Расчет прибыльности
    const profitableTriads: any[] = []

    // ВАЖНО: Стартовая сумма должна быть в токенах с 18 decimals для удобства,
    // но расчет должен работать с любым.
    // Выбираем WETH как стандарт для расчета прибыли.
    const START_TOKEN_SYMBOL: TokenSymbol = 'WETH';
    const TEST_AMOUNT = new Decimal('1'); // 1 WETH для расчета

    for (const triad of triads) {
        let currentAmount = TEST_AMOUNT
        const routeString: string[] = []
        let isProfitable = true

        let currentTokenSymbol: TokenSymbol = START_TOKEN_SYMBOL // 👈 НОВАЯ ПЕРЕМЕННАЯ: Отслеживаем текущий токен

        // Для первого шага (A->B) нужно убедиться, что стартовый токен соответствует токену A
        if (triad.route[0].tokenIn !== START_TOKEN_SYMBOL) continue

        for (const leg of triad.route) {
            const priceData = priceMap.get(leg.pool)

            if (!priceData) {
                isProfitable = false;
                break;
            }

            // Проверка, что токен на входе в текущем leg совпадает с токеном,
            // который мы несли с предыдущего шага. (Добавлено для безопасности,
            // но в идеале всегда должно совпадать)
            if (leg.tokenIn !== currentTokenSymbol) {
                // Если не совпало, значит, наш маршрут некорректно построен
                isProfitable = false;
                break;
            }

            // 1. Определяем направление свопа
            let priceMultiplier: Decimal
            const feeRate = new Decimal(leg.fee).div(1_000_000)

            // PriceData хранит Price T1 per T0 (T1/T0). T0 < T1.
            if (leg.tokenIn === priceData.token0Symbol) {
                // Если TokenIn == T0, мы покупаем T1. Цена: T1/T0
                priceMultiplier = priceData.priceT1PerT0
            } else if (leg.tokenIn === priceData.token1Symbol) {
                // Если TokenIn == T1, мы продаем T1. Цена: T0/T1 (обратная)
                priceMultiplier = new Decimal(1).div(priceData.priceT1PerT0)
            } else {
                isProfitable = false;
                break;
            }

            // 2. Вычисляем сумму после свопа и комиссии
            currentAmount = currentAmount
                .mul(priceMultiplier)
                .mul(new Decimal(1).sub(feeRate))

            // 3. Обновляем текущий токен для следующего шага
            currentTokenSymbol = leg.tokenOut // 👈 КЛЮЧЕВОЙ МОМЕНТ

            routeString.push(`${leg.tokenIn} -> ${leg.tokenOut} (${leg.fee/10000}%)`)
        }

        if (!isProfitable) continue

        // Final check: убеждаемся, что мы вернулись к стартовому токену
        if (currentTokenSymbol !== START_TOKEN_SYMBOL) continue // Должен всегда совпадать для триады

        const profit = currentAmount.sub(TEST_AMOUNT)

        // ⚠️ Здесь вы устанавливаете свой минимальный порог прибыли
        const MIN_PROFIT_THRESHOLD = new Decimal('0.001') // 0.1% от 1 WETH

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