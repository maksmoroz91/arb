import { parseAbi } from 'viem'

export const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'

export const FACTORY_ABI = parseAbi([
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
])

export const POOL_ABI = parseAbi([
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function liquidity() external view returns (uint128)'
])