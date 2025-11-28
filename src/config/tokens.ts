import { getAddress } from 'viem'

export const TOKENS = {
    USDC: {
        address: getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
        decimals: 6,
    },
    USDT: {
        address: getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
        decimals: 6,
    },
    DAI: {
        address: getAddress('0xDA10009cBd5D07dd0CECc66161FC93D7c9000da1'),
        decimals: 18,
    },
    WETH: {
        address: getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
        decimals: 18,
    },
    WBTC: {
        address: getAddress('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'),
        decimals: 8,
    },
    // Arbitrum нативные
    ARB: {
        address: getAddress('0x912CE59144191C1204E64559FE8253a0e49E6548'),
        decimals: 18,
    },
    // GMX: {
    //     address: getAddress('0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a'),
    //     decimals: 18,
    // },
    // MAGIC: {
    //     address: getAddress('0x539bdE0d7Dbd336b79148AA742883198BBF60342'),
    //     decimals: 18,
    // },

    // DeFi токены
    UNI: {
        address: getAddress('0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0'),
        decimals: 18,
    },
    // CRV: {
    //     address: getAddress('0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978'),
    //     decimals: 18,
    // },
} as const

export type TokenSymbol = keyof typeof TOKENS

export const FeeAmount = {
    LOW: 500,
    MEDIUM: 3000,
} as const

export type FeeAmountType = typeof FeeAmount[keyof typeof FeeAmount]

export const COMMON_FEES: FeeAmountType[] = [
    FeeAmount.LOW,
    FeeAmount.MEDIUM
]