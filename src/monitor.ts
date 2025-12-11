import { Address } from 'viem'
import Decimal from 'decimal.js'
import { POOL_ABI } from './config/abi'
import { viemClient, redisClient } from './utils/client'
import { TOKENS, TokenSymbol } from './config/tokens'
import { TriadRoute, PoolConfig } from './scanner'
Decimal.set({ precision: 60, toExpNeg: -100, toExpPos: 100 })

const REDIS_TRIADS_KEY = 'arb_triads_v3'

// Интерфейс для хранения СЫРОЙ цены (в минимальных единицах) и информации о токенах пула
interface PriceData {
    rawPriceT1PerT0: Decimal; // Изменено: хранит T1 smallest / T0 smallest
    token0Symbol: TokenSymbol;
    token1Symbol: TokenSymbol;
}

// Математика Uniswap V3: Raw Price (T1 smallest / T0 smallest)
// Эта функция возвращает только сырое соотношение, без корректировки на decimals.
function getRawPriceFromSqrt(sqrtPriceX96: bigint): Decimal {
    const Q96 = new Decimal(2).pow(96)
    const sqrt = new Decimal(sqrtPriceX96.toString())

    // Цена T1 в терминах T0 (T1 smallest / T0 smallest)
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

    // 1. Создаем Map всех уникальных пулов для Multicall
    const poolConfigMap = new Map<Address, PoolConfig>()
    triads.forEach(triad => {
        triad.route.forEach(leg => {
            const poolKey = leg.pool;
            if (!poolConfigMap.has(poolKey)) {
                const tA = leg.tokenIn;
                const tB = leg.tokenOut;

                const t0Symbol = BigInt(TOKENS[tA].address) < BigInt(TOKENS[tB].address) ? tA : tB
                const t1Symbol = BigInt(TOKENS[tA].address) < BigInt(TOKENS[tB].address) ? tB : tA

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

    const priceMap = new Map<Address, PriceData>() // Key: Pool Address
    const liquidityMap = new Map<Address, bigint>()
    const STABLE_TOKENS = new Set<TokenSymbol>(['USDC', 'USDT', 'DAI'])
    let resultIndex = 0

    // 2. Обработка результатов и сохранение PriceData
    for (const poolAddress of poolAddresses) {
        const resSlot0 = results[resultIndex++]
        const resLiquidity = results[resultIndex++]

        if (resSlot0.status === 'success' && resSlot0.result && resLiquidity.status === 'success' && resLiquidity.result) {
            const [sqrtPriceX96] = resSlot0.result as [bigint, number, number, number, number, number, boolean]
            const liquidity = resLiquidity.result as bigint
            const MIN_LIQUIDITY = 1000000000000000000n // 1e18

            if (liquidity < MIN_LIQUIDITY) {
                console.log(`⚠️ Skipping low-liquidity pool: ${poolAddress} (liquidity: ${liquidity})`)
                continue
            }

            const config = poolConfigMap.get(poolAddress)!

            // Получаем RAW Price Ratio (T1 smallest / T0 smallest)
            const rawPriceT1PerT0 = getRawPriceFromSqrt(sqrtPriceX96)

            // Вычисляем Human Price (T1/T0) для проверки стейбл-пулов
            const decimalsToken0 = TOKENS[config.token0].decimals
            const decimalsToken1 = TOKENS[config.token1].decimals
            const dec_shift = new Decimal(10).pow(decimalsToken0 - decimalsToken1)
            const humanPriceT1PerT0 = rawPriceT1PerT0.mul(dec_shift)

            // Проверка для стейбл-пулов
            if (STABLE_TOKENS.has(config.token0) && STABLE_TOKENS.has(config.token1)) {
                if (humanPriceT1PerT0.lessThan(0.99) || humanPriceT1PerT0.greaterThan(1.01)) {
                    console.log(`⚠️ Skipping stable pool with abnormal price: ${poolAddress} (price: ${humanPriceT1PerT0.toSignificantDigits(4).toString()}, liquidity: ${liquidity})`)
                    continue
                }
            }

            liquidityMap.set(poolAddress, liquidity)
            priceMap.set(poolAddress, {
                rawPriceT1PerT0, // Сохраняем сырую цену
                token0Symbol: config.token0,
                token1Symbol: config.token1,
            })
        }
    }

    console.log(`⚡ Fetched prices in ${Date.now() - start}ms`)

    // 3. Расчет прибыльности
    const profitableTriads: any[] = []

    const START_TOKEN_SYMBOL: TokenSymbol = 'WETH';
    const TEST_AMOUNT = new Decimal('1'); // 1 WETH для расчета

    for (const triad of triads) {
        let currentAmount = TEST_AMOUNT
        const routeString: string[] = []
        let isProfitable = true

        let currentTokenSymbol: TokenSymbol = START_TOKEN_SYMBOL

        // Для первого шага (A->B) нужно убедиться, что стартовый токен соответствует токену A
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

            let rawPriceMultiplier: Decimal // T_out smallest / T_in smallest
            const feeRate = new Decimal(leg.fee).div(1_000_000)

            const decimalsIn = TOKENS[leg.tokenIn].decimals
            const decimalsOut = TOKENS[leg.tokenOut].decimals

            // 1. Получаем сырую цену (T_out smallest / T_in smallest)
            if (leg.tokenIn === priceData.token0Symbol) {
                // T_in=T0, T_out=T1. Цена: (T1 smallest / T0 smallest)
                rawPriceMultiplier = priceData.rawPriceT1PerT0
            } else if (leg.tokenIn === priceData.token1Symbol) {
                // T_in=T1, T_out=T0. Цена: (T0 smallest / T1 smallest)
                rawPriceMultiplier = new Decimal(1).div(priceData.rawPriceT1PerT0)
            } else {
                isProfitable = false;
                break;
            }

            // 2. СКОРРЕКТИРОВАННАЯ ЦЕНА: Переводим T_in (human) в T_out (human)
            // Human Price (T_out / T_in) = RawPrice * (10^dec_in / 10^dec_out)
            const dec_shift = new Decimal(10).pow(decimalsIn - decimalsOut)
            const humanExchangeRate = rawPriceMultiplier.mul(dec_shift)

            // 3. Вычисляем сумму после свопа и комиссии
            currentAmount = currentAmount
                .mul(humanExchangeRate) // <--- ИСПОЛЬЗУЕМ ЧЕЛОВЕЧЕСКУЮ ЦЕНУ
                .mul(new Decimal(1).sub(feeRate))

            // 4. Обновляем текущий токен для следующего шага
            currentTokenSymbol = leg.tokenOut

            routeString.push(`${leg.tokenIn} -> ${leg.tokenOut} (${leg.fee/10000}%)`)
        }

        if (!isProfitable) continue

        // Final check: убеждаемся, что мы вернулись к стартовому токену
        if (currentTokenSymbol !== START_TOKEN_SYMBOL) continue

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