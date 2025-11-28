import { createPublicClient, http } from 'viem'
import { arbitrum } from 'viem/chains'
import Redis from 'ioredis'
import * as dotenv from 'dotenv'

dotenv.config()

if (!process.env.RPC_URL_ARBITRUM) throw new Error('RPC_URL_ARBITRUM missing')
if (!process.env.REDIS_URL) throw new Error('REDIS_URL missing')

export const viemClient = createPublicClient({
    chain: arbitrum,
    transport: http(process.env.RPC_URL_ARBITRUM),
    batch: { multicall: true }
})

export const redisClient = new Redis(process.env.REDIS_URL)

export const REDIS_KEYS = {
    POOLS: 'active_pools_v3'
}